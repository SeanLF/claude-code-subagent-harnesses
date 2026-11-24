// Holds an ACP (Agent Client Protocol) connection open for a Claude Code plugin, whose spawn writes stdin
// once and closes it. Built into relay/relay.mjs (pnpm build:relay), which ships with the SDK inlined.
//
// Usage: node relay.mjs -- <agent command...>, with the prompt on stdin.
// Env:
//   RELAY_INBOX       file of JSON lines the plugin appends: a string steers the running prompt (see
//                     RELAY_STEER) or queues a follow-up, {"interrupt": text} cancels the turn and runs text
//                     next, {"answer": id, "optionId": id|null} answers a permission request, {"question": id,
//                     "answer": {"action": ..., "content": ...}} answers a question (each printed as a
//                     {"relay":"question"} line; {"relay":"question_closed"} says one no longer needs an answer)
//   RELAY_FILES       folder for what the agent sends as bytes (an image, audio, a binary resource): each is saved
//                     there and printed with {"relay": {"saved": path, "size": bytes}} in its _meta, its bytes left out
//   RELAY_STEER       how a string reaches a running prompt: steering (codex-acp's _session/steering), prompt
//                     (a second session/prompt, which opencode takes at its next step); unset: queued
//   RELAY_SESSION     a session to resume (session/load)
//   RELAY_MODEL       the agent's `model` config option
//   RELAY_AGENT_MODE  the agent's own mode (session/set_mode), such as codex's workspace-write
//   RELAY_CONFIG      a JSON object of other config options to set, such as {"reasoning_effort": "high"}
//   RELAY_OPTIONS     a JSON object of the person's own config options, such as {"fast-mode": "on"}: never a
//                     mode, model or thinking option, and each checked against what the session offers
//   RELAY_TRACE       for development: a file the relay appends the prompt, its printed lines and inbox lines to
//   RELAY_POLICY      how permission requests are answered: allow, deny (the default) or ask (every request
//                     goes to the plugin)
// Prints each ACP session update as received, and {"relay": ...} lines for its own events.
import { spawn } from 'node:child_process'
import {
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk/unstable'

type Policy = 'allow' | 'deny' | 'ask'
type Answer = (optionId: string | null) => void

// RELAY_TRACE, for development (via sets it under VIA_TRACE=1): a file the relay appends the prompt, every line it
// prints and each inbox line to, one {t, kind, data} object per line. A trace that can't be written is skipped. It
// holds everything the agent read and ran, so it is the owner's alone (0600, its folder 0700).
const tracePath = process.env.RELAY_TRACE
if (tracePath) {
  try {
    mkdirSync(dirname(tracePath), { recursive: true, mode: 0o700 })
  } catch {
    // The appends below fail too, and are skipped.
  }
}
const trace = (kind: 'prompt' | 'out' | 'inbox', data: unknown) => {
  if (!tracePath) return
  try {
    appendFileSync(tracePath, `${JSON.stringify({ t: new Date().toISOString(), kind, data })}\n`, { mode: 0o600 })
  } catch {
    // Development only: never a reason to fail the run.
  }
}
const out = (event: Record<string, unknown>) => {
  trace('out', event)
  process.stdout.write(`${JSON.stringify(event)}\n`)
}
let agentPid: number | undefined
// busy: a prompt of the main loop is running. spokeIdle: the agent wrote an answer while none was.
let busy = false
// A prompt has gone out: what came before is a resumed session's history, replayed, which nobody reads again.
let sentPrompt = false
let spokeIdle = false
const fail = (message: string): never => {
  out({ relay: 'error', message })
  process.stderr.write(`acp relay: ${message}\n`)
  try {
    if (agentPid !== undefined) process.kill(-agentPid, 'SIGTERM')
  } catch {
    // Already gone.
  }
  process.exit(1)
}
// An agent's JSON-RPC error can say only "Internal error" and carry the cause in its data (codex-acp
// puts Codex's own message there, such as a usage limit and when it resets): both are kept.
const reason = (error: unknown) => {
  const { message, data } = (error ?? {}) as { message?: unknown; data?: unknown }
  const said = String(message ?? error)
  const record = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : undefined
  // Only the agent's own words, capped: a whole data record could echo a request, its env or a token.
  const words =
    typeof data === 'string'
      ? data
      : typeof record?.details === 'string'
        ? record.details
        : typeof record?.message === 'string'
          ? record.message
          : ''
  const cause = words.length > 500 ? `${words.slice(0, 500)}…` : words
  return cause && !said.includes(cause) ? `${said}: ${cause}` : said
}

// Claude hands a subagent a screenshot as a path in its prompt (often its own temp folder): an agent that
// takes images gets each existing one as an image block too, the path left in the text.
const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}
// The relay runs outside the agent's sandbox, so it reads an image only where the run already works:
// under the working folder, or Claude Code's own temp folder, where its screenshots are (/tmp/claude-<uid>).
// Symlinks are resolved first, and the bytes must be the image the name claims.
const realOrNone = (path: string) => {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}
const IMAGE_ROOTS = [process.cwd(), `/tmp/claude-${process.getuid?.() ?? ''}`].flatMap((root) => realOrNone(root) ?? [])
const MAGIC: Record<string, (bytes: Buffer) => boolean> = {
  'image/png': (b) => b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
  'image/jpeg': (b) => b.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
  'image/gif': (b) => b.subarray(0, 4).toString('latin1') === 'GIF8',
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
}
// A path starts the text or follows a space, quote or bracket (not the tail of a relative path or of a
// URL), and at most four images go along.
const attached = (text: string): acp.ContentBlock[] => {
  const paths = new Set([...text.matchAll(/(?:^|[\s'"`(<])(\/[^\s'"`<>()]+\.(?:png|jpe?g|gif|webp))\b/gi)].map((m) => m[1] as string))
  const blocks: acp.ContentBlock[] = []
  for (const path of paths) {
    if (blocks.length >= 4) break
    const mimeType = IMAGE_TYPES[path.split('.').pop()?.toLowerCase() ?? '']
    const real = realOrNone(path)
    if (!mimeType || !real || !IMAGE_ROOTS.some((root) => real.startsWith(`${root}/`))) continue
    // One open, then every check and the read on it: a file swapped after a check is never the one read. Not
    // blocking, so a named pipe can't stall the prompt; not following the file itself if it became a link after
    // the realpath (a folder above it swapped for a link still is followed).
    let fd: number | undefined
    try {
      fd = openSync(real, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.size > 5 * 1024 * 1024) continue
      const bytes = readFileSync(fd)
      if (MAGIC[mimeType]?.(bytes)) blocks.push({ type: 'image', mimeType, data: bytes.toString('base64') })
    } catch {
      // Not readable: the path stays text.
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
  }
  return blocks
}

// terminal_output_delta: command output in tool call updates, the Zed convention. No client terminal:
// commands stay in the agent's own sandbox. No plan capability: a to-do list comes as a plan update
// either way, and with it codex-acp sends a markdown plan as plan_update, which this client does not
// draw, in place of the message text it otherwise is. Compaction: codex-acp then reports the agent's
// compaction as compaction updates, not a tool call or a line in the answer. Subagents: a harness's own
// subagents come as child sessions (ACP's subagents RFD), not folded into the parent; the relay reads
// the SDK's unstable schema, which has them, still at protocol version 1.
const CAPABILITIES: acp.ClientCapabilities = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
  // notices: codex-acp then sends its warnings as notices, not as text in the answer.
  session: { compaction: {}, notices: {} },
  subagents: {},
  // A harness's questions to the person (ACP elicitation, adapted from MCP's): printed as {"relay":"question"}
  // lines, which via asks through Claude Code's own MCP elicitation form.
  elicitation: { form: {}, url: {} },
  _meta: { terminal_output_delta: true },
}
const dash = process.argv.indexOf('--')
const [bin, ...args] = dash < 0 ? [] : process.argv.slice(dash + 1)
if (bin === undefined) fail('usage: relay.mjs -- <agent command...>')
const policy = (process.env.RELAY_POLICY ?? 'deny') as Policy
if (!['allow', 'deny', 'ask'].includes(policy)) fail(`RELAY_POLICY must be allow, deny or ask, not ${policy}`)
const cwd = process.cwd()

const prompt = await new Promise<string>((resolve) => {
  let text = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk: string) => (text += chunk))
  process.stdin.on('end', () => resolve(text))
})
trace('prompt', prompt)

// Its own process group, so a stop also reaches what it started.
const agent = spawn(bin as string, args, { stdio: ['pipe', 'pipe', 'inherit'], detached: true })
agentPid = agent.pid
agent.on('error', (error) => fail(`could not start ${bin}: ${error.message}`))
// Set once a session exists. Cancelling ends the agent's running tool, which a kill does not: opencode
// runs commands in their own process group, so a group kill left a `sleep` running.
let cancel = async () => {}
// Set once a session exists, for an agent that can close one: closing ends what the session started that
// a cancel and the kill leave running, such as Codex's background terminals.
let close = async () => {}
const stop = async (code: number) => {
  const ended = async () => {
    await cancel()
    await close()
  }
  await Promise.race([ended(), new Promise((resolve) => setTimeout(resolve, 2000))])
  try {
    if (agent.pid !== undefined) process.kill(-agent.pid, 'SIGTERM')
  } catch {
    // Already gone.
  }
  process.exit(code)
}
// The engine stops a run with SIGTERM: the agent must not outlive the relay.
process.on('SIGTERM', () => void stop(0))
process.on('SIGINT', () => void stop(0))
agent.on('exit', (code) => {
  out({ relay: 'agent_exit', code })
  process.exit(code ?? 1)
})

// Ids unique to this run: a late answer to an earlier run's question must never match one here.
const RUN = `${process.pid}-${Date.now().toString(36)}`
const asked = new Map<string, Answer>()
let asks = 0
// A question's answer, as MCP's elicitation result and ACP's are alike: accept (with content), decline, cancel.
type QuestionAnswer = acp.CreateElicitationResponse
const questions = new Map<string, (answer: QuestionAnswer) => void>()
const CANCEL: QuestionAnswer = { action: 'cancel' }
// What the agent sends as bytes, saved to RELAY_FILES, as Claude Code saves an MCP tool's: the block printed
// with the file's path and size in place of its bytes. A failed save is said the same way, its bytes still left out.
const files = process.env.RELAY_FILES
const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'audio/wav': 'wav',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'application/pdf': 'pdf',
}
let savedCount = 0
function saved(block: acp.ContentBlock): acp.ContentBlock {
  const bytes =
    block.type === 'image' || block.type === 'audio'
      ? block.data
      : block.type === 'resource' && 'blob' in block.resource
        ? block.resource.blob
        : ''
  // A resumed session's replayed history is not saved again.
  if (!files || !bytes || !sentPrompt) return block
  const mimeType =
    block.type === 'resource' ? block.resource.mimeType : block.type === 'image' || block.type === 'audio' ? block.mimeType : undefined
  const data = Buffer.from(bytes, 'base64')
  const path = join(files, `${RUN}-${++savedCount}.${EXTENSIONS[mimeType ?? ''] ?? 'bin'}`)
  let relay: Record<string, unknown>
  try {
    mkdirSync(files, { recursive: true, mode: 0o700 })
    writeFileSync(path, data, { mode: 0o600 })
    relay = { saved: path, size: data.length }
  } catch (error) {
    relay = { notSaved: reason(error), size: data.length }
  }
  const _meta = { ...block._meta, relay }
  if (block.type === 'resource' && 'blob' in block.resource) return { ...block, resource: { ...block.resource, blob: '' }, _meta }
  return block.type === 'image' || block.type === 'audio' ? { ...block, data: '', _meta } : block
}
function savedUpdate(update: acp.SessionUpdate): acp.SessionUpdate {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
    case 'agent_thought_chunk':
    case 'user_message_chunk':
      return { ...update, content: saved(update.content) }
    case 'tool_call':
    case 'tool_call_update':
      return update.content
        ? { ...update, content: update.content.map((c) => (c.type === 'content' ? { ...c, content: saved(c.content) } : c)) }
        : update
    // A message between sessions (ACP's subagents RFD): whole, or a chunk of it.
    case 'session_message':
      return update.content ? { ...update, content: update.content.map(saved) } : update
    case 'session_message_chunk':
      return { ...update, content: saved(update.content) }
    default:
      return update
  }
}

// A question still open that no answer will settle (an interrupt, the agent's own cancel): cancelled, and said
// with a {"relay":"question_closed"} line, so the plugin stops waiting on the person.
const closeQuestion = (id: string) => {
  const answerIt = questions.get(id)
  if (answerIt === undefined) return
  questions.delete(id)
  out({ relay: 'question_closed', id })
  answerIt(CANCEL)
}
// What a question carries to the person, without ACP's own scope fields: the shape MCP's elicitation takes.
const question = (request: acp.CreateElicitationRequest) =>
  request.mode === 'url'
    ? { mode: 'url', message: request.message, url: request.url, elicitationId: request.elicitationId }
    : { mode: 'form', message: request.message, requestedSchema: 'requestedSchema' in request ? request.requestedSchema : undefined }
const web = (url: unknown) => {
  try {
    return ['https:', 'http:'].includes(new URL(String(url)).protocol)
  } catch {
    return false
  }
}
const answered = (value: unknown): QuestionAnswer => {
  const answer = typeof value === 'object' && value !== null ? (value as { action?: unknown; content?: unknown }) : {}
  if (answer.action === 'accept')
    return {
      action: 'accept',
      content: typeof answer.content === 'object' && answer.content !== null ? (answer.content as Record<string, never>) : {},
    }
  return answer.action === 'decline' ? { action: 'decline' } : CANCEL
}
const choose = (options: readonly acp.PermissionOption[], kind: acp.PermissionOptionKind): acp.RequestPermissionResponse => {
  const option = options.find((o) => o.kind === kind)
  return { outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } }
}

const stream = acp.ndJsonStream(
  Writable.toWeb(agent.stdin) as WritableStream<Uint8Array>,
  Readable.toWeb(agent.stdout) as ReadableStream<Uint8Array>,
)
const result = await acp
  .client({ name: 'via' })
  .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
    const { toolCall, options } = ctx.params
    if (policy === 'allow') return choose(options, 'allow_once')
    // With no inbox no answer can come back: deny rather than wait forever.
    if (policy === 'deny' || !process.env.RELAY_INBOX) return choose(options, 'reject_once')
    const id = `${RUN}-${++asks}`
    const raw = toolCall.rawInput as { command?: unknown } | undefined
    out({
      relay: 'ask',
      id,
      title: toolCall.title ?? '',
      kind: toolCall.kind ?? 'other',
      ...(typeof raw?.command === 'string'
        ? { command: raw.command }
        : Array.isArray(raw?.command)
          ? { command: raw.command.join(' ') }
          : {}),
      options: options.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
    })
    return new Promise<acp.RequestPermissionResponse>((resolve) =>
      asked.set(id, (optionId) =>
        resolve(optionId ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } }),
      ),
    )
  })
  .onRequest(acp.methods.client.elicitation.create, (ctx) => {
    // With no inbox no answer can come back: cancel rather than wait forever.
    if (!process.env.RELAY_INBOX) return CANCEL
    // A link to open is a web page's, nothing else (a file, a script, an app's own scheme).
    if (ctx.params.mode === 'url' && !web(ctx.params.url)) return CANCEL
    const id = `${RUN}-q${++asks}`
    out({ relay: 'question', id, ...question(ctx.params) })
    return new Promise<QuestionAnswer>((resolve) => {
      questions.set(id, resolve)
      // The agent withdrew it ($/cancel_request): the person need not answer.
      if (ctx.signal.aborted) closeQuestion(id)
      else ctx.signal.addEventListener('abort', () => closeQuestion(id), { once: true })
    })
  })
  .onNotification(acp.methods.client.session.update, (ctx) => {
    if (!busy && ctx.params.update.sessionUpdate === 'agent_message_chunk') spokeIdle = true
    out({ ...ctx.params, update: savedUpdate(ctx.params.update) } as unknown as Record<string, unknown>)
  })
  .connectWith(stream, async (ctx) => {
    const init = await ctx.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: CAPABILITIES,
    })
    const resume = process.env.RELAY_SESSION
    const opened = resume
      ? await ctx.request(acp.methods.agent.session.load, { sessionId: resume, cwd, mcpServers: [] }).catch((error: unknown) => {
          const message = reason(error)
          const data = JSON.stringify((error as { data?: unknown })?.data ?? '')
          // Only a session the agent no longer has is lost; anything else (auth, a crash) is a failure.
          if (!/not found/i.test(`${message} ${data}`)) return fail(`could not resume the session: ${message}`)
          out({ relay: 'session_lost', message })
          process.stderr.write(`acp relay: session lost: ${message}\n`)
          return process.exit(1)
        })
      : await ctx.request(acp.methods.agent.session.new, { cwd, mcpServers: [] })
    const sessionId = resume ?? (opened as acp.NewSessionResponse).sessionId
    cancel = async () => {
      await ctx.notify(acp.methods.agent.session.cancel, { sessionId })
      // A moment for the agent to abort its tool before the kill.
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    // A cancel stops the turn, not the commands it started: codex keeps them as background terminals, so they
    // run on until the session closes. An agent that can close and resume a session has it closed after an
    // interrupt, and resumed for the interrupt's message.
    const reopens =
      init.agentCapabilities?.sessionCapabilities?.close != null && init.agentCapabilities?.sessionCapabilities?.resume != null
    if (init.agentCapabilities?.sessionCapabilities?.close)
      close = async () => {
        await ctx.request(acp.methods.agent.session.close, { sessionId }).catch(() => {})
      }

    const modeId = process.env.RELAY_AGENT_MODE
    let extra: Record<string, unknown> = {}
    try {
      extra = JSON.parse(process.env.RELAY_CONFIG || '{}') as Record<string, unknown>
    } catch {
      fail('RELAY_CONFIG is not a JSON object')
    }
    // The person's options (RELAY_OPTIONS) are only those that tune the model: ACP's model_config and speed
    // categories, such as codex's fast-mode. Anything else may touch the sandbox or approvals under any name
    // (codex offers read-only to agent-full-access as a mode option), so it is refused, an uncategorised one too.
    const TUNING = ['model_config', 'speed']
    const reserved = (o: acp.SessionConfigOption) => !TUNING.includes(String(o.category)) || o.id === 'mode' || o.id === 'model'
    let options: Record<string, unknown> = {}
    try {
      options = JSON.parse(process.env.RELAY_OPTIONS || '{}') as Record<string, unknown>
    } catch {
      fail('RELAY_OPTIONS is not a JSON object')
    }
    // The session's mode and options: set again on a session reopened after an interrupt, which starts from the
    // agent's defaults. first: the run's own session, the only one whose warnings are said.
    const configure = async (session: { configOptions?: acp.SessionConfigOption[] | null }, first: boolean) => {
      if (modeId)
        await ctx
          .request(acp.methods.agent.session.setMode, { sessionId, modeId })
          .catch((error: unknown) => fail(`the agent refused mode ${modeId}: ${reason(error)}`))
      let configOptions = session.configOptions ?? []
      const model = process.env.RELAY_MODEL
      if (model) {
        // A model the agent refuses ends the run: carrying on would answer from its default model.
        const set = await ctx
          .request(acp.methods.agent.session.setConfigOption, { sessionId, configId: 'model', value: model })
          .catch((error: unknown) => fail(`the agent refused model ${model}: ${reason(error)}`))
        configOptions = set.configOptions ?? configOptions
      }
      // Checked against what the session offers for its model, after the model is set: an agent may take a value
      // it does not offer and drop it silently, as codex-acp takes fast-mode on for a model without it.
      const running = configOptions.find((o) => o.id === 'model')
      const forModel =
        running && 'currentValue' in running && typeof running.currentValue === 'string' ? ` for ${running.currentValue}` : ''
      const setOption = async (configId: string, value: unknown) => {
        if (typeof value !== 'string') fail(`${configId} must be a string`)
        const option = configOptions.find((o) => o.id === configId)
        if (option === undefined) fail(`the agent offers no ${configId} option${forModel}`)
        if (option?.type === 'select') {
          const values = option.options.flatMap((o) => ('options' in o ? o.options : [o])).map((o) => o.value)
          if (!values.includes(value as string)) fail(`the agent offers ${configId} ${values.join(', ')}${forModel}, not ${String(value)}`)
        }
        const set = await ctx
          .request(acp.methods.agent.session.setConfigOption, { sessionId, configId, value: value as string })
          .catch((error: unknown) => fail(`the agent refused ${configId} ${String(value)}: ${reason(error)}`))
        configOptions = set.configOptions ?? configOptions
      }
      const settable = () => configOptions.filter((o) => !reserved(o)).map((o) => o.id)
      for (const [configId, value] of Object.entries(options)) {
        const option = configOptions.find((o) => o.id === configId)
        if (option && reserved(option))
          fail(
            `${configId} is not an option a config line sets: only ones that tune the model, ${settable().length > 0 ? `such as ${settable().join(', ')}` : 'and the agent offers none'}. config: ${configId}= drops it.`,
          )
        // Not a failure: an option held from an earlier message may be one this model lacks, such as Codex's
        // fast-mode on a model with no fast tier, and every later message would fail on it.
        if (option === undefined) {
          const title = `the agent offers no ${configId} option${forModel}, so this run goes without it; it offers ${settable().join(', ') || 'none'}. config: ${configId}= drops it.`
          if (first) out({ sessionId, update: { sessionUpdate: 'notice', severity: 'warning', title } })
          continue
        }
        await setOption(configId, value)
      }
      // via's own options last: they are what the run needs. Its mode again too, after the person's options: one
      // the session names some other way than mode must not leave it in another.
      for (const [configId, value] of Object.entries(extra)) await setOption(configId, value)
      if (modeId && Object.keys(options).length > 0)
        await ctx
          .request(acp.methods.agent.session.setMode, { sessionId, modeId })
          .catch((error: unknown) => fail(`the agent refused mode ${modeId}: ${reason(error)}`))
      return configOptions
    }
    const configOptions = await configure(opened as { configOptions?: acp.SessionConfigOption[] | null }, true)
    // Said only once the session is set up, just before its first prompt: a model, mode or option the agent
    // refuses ends the run first, and a new session saved then would hold no prompt to resume. cwd: so a
    // title's paths can be shown relative to it.
    out({ relay: 'session', sessionId, cwd })
    const current = configOptions.find((o) => o.id === 'model')
    if (current && 'currentValue' in current && typeof current.currentValue === 'string')
      out({ relay: 'model', name: current.currentValue })

    const queue = [prompt]
    let interrupt: string | undefined
    let last: acp.PromptResponse | undefined
    const promptDone = (r: acp.PromptResponse) =>
      // Not in the stable type, but codex-acp and opencode send it.
      out({ relay: 'prompt_done', stopReason: r.stopReason, usage: (r as { usage?: unknown }).usage ?? null })
    // Steers still in flight: the run is not over until each has returned. A steer counts as
    // `steered` only once the agent has taken it, or a requeued one would count twice.
    const steering = new Set<Promise<void>>()
    const images = init.agentCapabilities?.promptCapabilities?.image === true
    const prompted = (text: string): acp.PromptRequest => ({
      sessionId,
      prompt: [{ type: 'text', text }, ...(images ? attached(text) : [])],
    })
    const refused = (text: string, error: unknown) => {
      process.stderr.write(`acp relay: steer refused, queued: ${reason(error)}\n`)
      queue.push(text)
    }
    // RELAY_STEER=steering: the _session/steering extension (codex-acp), which injects into the running turn.
    // One at a time: a later one must not land in a turn an earlier one's fallback cancels.
    let extensionSteers: Promise<void> = Promise.resolve()
    const steerByExtension = (text: string) =>
      (extensionSteers = extensionSteers.then(async () => {
        // The prompt ended, or is being interrupted, while this one waited.
        if (!busy || interrupt !== undefined) return void queue.push(text)
        const r = await ctx
          .request<{ outcome?: string }>('_session/steering', prompted(text))
          .catch((error: unknown) => refused(text, error))
        if (r === undefined) return
        if (r.outcome === 'injected') return void out({ relay: 'steered' })
        // No turn was left to steer, so the agent started one whose end this relay never hears:
        // cancel it and run the message as an ordinary prompt.
        if (r.outcome === 'startedNewTurn') await ctx.notify(acp.methods.agent.session.cancel, { sessionId }).catch(() => {})
        queue.push(text)
      }))
    // Otherwise a second prompt, which an agent such as opencode takes at its next step and answers when all
    // its work is done.
    const steerByPrompt = async (text: string) => {
      const r = await ctx.request(acp.methods.agent.session.prompt, prompted(text)).catch((error: unknown) => refused(text, error))
      // Cancelled by an interrupt before it was read: reported undelivered.
      if (r === undefined || r.stopReason === 'cancelled') return
      out({ relay: 'steered' })
      // It landed after the prompt ended, so it ran as its own answer.
      if (spokeIdle) {
        last = r
        promptDone(r)
      }
    }
    const steer = (text: string) => {
      const done: Promise<void> = (process.env.RELAY_STEER === 'steering' ? steerByExtension(text) : steerByPrompt(text)).finally(() =>
        steering.delete(done),
      )
      steering.add(done)
    }
    let offset = 0
    const inbox = process.env.RELAY_INBOX
    if (inbox)
      setInterval(() => {
        if (!existsSync(inbox)) return
        const text = readFileSync(inbox, 'utf8')
        const end = text.lastIndexOf('\n')
        if (end < offset) return
        for (const line of text.slice(offset, end).split('\n')) {
          if (!line.trim()) continue
          const value = JSON.parse(line) as unknown
          trace('inbox', value)
          if (typeof value === 'string') {
            // Not into a turn an interrupt is cancelling.
            if (busy && interrupt === undefined && process.env.RELAY_STEER) steer(value)
            else queue.push(value)
          } else if (typeof value === 'object' && value !== null && 'question' in value) {
            const { question: id, answer } = value as { question: string; answer?: unknown }
            questions.get(id)?.(answered(answer))
            questions.delete(id)
          } else if (typeof value === 'object' && value !== null && 'answer' in value) {
            const { answer, optionId } = value as { answer: string; optionId?: string | null }
            asked.get(answer)?.(optionId ?? null)
            asked.delete(answer)
          } else if (typeof value === 'object' && value !== null && 'interrupt' in value) {
            const text = String((value as { interrupt: unknown }).interrupt)
            interrupt = interrupt === undefined ? text : `${interrupt}\n\n${text}`
            // An unanswered question would hold the turn open past the cancel.
            for (const [id, answerIt] of asked) {
              answerIt(null)
              asked.delete(id)
            }
            for (const id of [...questions.keys()]) closeQuestion(id)
            void ctx.notify(acp.methods.agent.session.cancel, { sessionId })
          }
        }
        offset = end + 1
      }, 300).unref()

    while (queue.length > 0 || steering.size > 0) {
      if (queue.length === 0) {
        await Promise.all(steering)
        continue
      }
      const text = queue.shift() as string
      out({ relay: 'steered' })
      // Cleared here, not after: a resumed session's replayed history arrives before the first prompt.
      busy = true
      sentPrompt = true
      spokeIdle = false
      const r = await ctx.request(acp.methods.agent.session.prompt, prompted(text)).catch((error: unknown) => fail(reason(error)))
      busy = false
      last = r
      promptDone(r)
      if (interrupt !== undefined) {
        out({ relay: 'interrupted' })
        // The interrupted step's commands stop with the session, which reopens for the interrupt's message.
        if (reopens) {
          await ctx
            .request(acp.methods.agent.session.close, { sessionId })
            .catch((error: unknown) => fail(`could not stop the interrupted step: ${reason(error)}`))
          const reopened = await ctx
            .request(acp.methods.agent.session.resume, { sessionId, cwd, mcpServers: [] })
            .catch((error: unknown) => fail(`could not reopen the session after an interrupt: ${reason(error)}`))
          await configure(reopened as { configOptions?: acp.SessionConfigOption[] | null }, false)
        }
        queue.unshift(interrupt)
        interrupt = undefined
      }
    }
    // Here, not in stop(): the connection closes when this callback returns.
    await Promise.race([close(), new Promise((resolve) => setTimeout(resolve, 2000))])
    close = async () => {}
    return last
  })

out({ relay: 'done', stopReason: result?.stopReason ?? null })
cancel = async () => {}
await stop(0)
