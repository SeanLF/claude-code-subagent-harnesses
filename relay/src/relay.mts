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
import * as z from 'zod/v4'
import type { InboxLine, RelayLine, RelayQuestion } from '../../hooks/acp/wire-relay.ts'

type Policy = 'allow' | 'deny' | 'ask'
type Answer = (optionId: string | null) => void

const tracePath = process.env.RELAY_TRACE
if (tracePath) {
  try {
    mkdirSync(dirname(tracePath), { recursive: true, mode: 0o700 })
  } catch {}
}
const trace = (kind: 'prompt' | 'out' | 'inbox', data: unknown) => {
  if (!tracePath) return
  try {
    appendFileSync(tracePath, `${JSON.stringify({ t: new Date().toISOString(), kind, data })}\n`, { mode: 0o600 })
  } catch {}
}
const out = (event: RelayLine | acp.SessionNotification) => {
  trace('out', event)
  process.stdout.write(`${JSON.stringify(event)}\n`)
}
let agentPid: number | undefined
let busy = false
let sentPrompt = false
let spokeIdle = false
const fail = (message: string): never => {
  out({ relay: 'error', message })
  process.stderr.write(`acp relay: ${message}\n`)
  try {
    if (agentPid !== undefined) process.kill(-agentPid, 'SIGTERM')
  } catch {}
  process.exit(1)
}
const reason = (error: unknown) => {
  const { message, data } = (error ?? {}) as { message?: unknown; data?: unknown }
  const said = String(message ?? error)
  const record = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : undefined
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

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}
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
const attached = (text: string): acp.ContentBlock[] => {
  const paths = new Set([...text.matchAll(/(?:^|[\s'"`(<])(\/[^\s'"`<>()]+\.(?:png|jpe?g|gif|webp))\b/gi)].map((m) => m[1] as string))
  const blocks: acp.ContentBlock[] = []
  for (const path of paths) {
    if (blocks.length >= 4) break
    const mimeType = IMAGE_TYPES[path.split('.').pop()?.toLowerCase() ?? '']
    const real = realOrNone(path)
    if (!mimeType || !real || !IMAGE_ROOTS.some((root) => real.startsWith(`${root}/`))) continue
    const bytes = readThroughOneOpenNoLinkNoPipe(real, 5 * 1024 * 1024)
    if (bytes && MAGIC[mimeType]?.(bytes)) blocks.push({ type: 'image', mimeType, data: bytes.toString('base64') })
  }
  return blocks
}

const OPEN_NO_LINK_NO_PIPE = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW
function readThroughOneOpenNoLinkNoPipe(path: string, maxBytes: number): Buffer | undefined {
  let fd: number | undefined
  try {
    fd = openSync(path, OPEN_NO_LINK_NO_PIPE)
    const stat = fstatSync(fd)
    return stat.isFile() && stat.size <= maxBytes ? readFileSync(fd) : undefined
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

const CAPABILITIES: acp.ClientCapabilities = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
  session: { compaction: {}, notices: {} },
  subagents: {},
  elicitation: { form: {}, url: {} },
  _meta: { terminal_output_delta: true },
}
const dash = process.argv.indexOf('--')
const [bin, ...args] = dash < 0 ? [] : process.argv.slice(dash + 1)
if (bin === undefined) fail('usage: relay.mjs -- <agent command...>')
const policy = (process.env.RELAY_POLICY ?? 'deny') as Policy
if (!['allow', 'deny', 'ask'].includes(policy)) fail(`RELAY_POLICY must be allow, deny or ask, not ${policy}`)
const cwd = process.cwd()

const forget = process.env.RELAY_DELETE
const prompt = await new Promise<string>((resolve) => {
  if (forget) return resolve('')
  let text = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk: string) => (text += chunk))
  process.stdin.on('end', () => resolve(text))
})
trace('prompt', prompt)

const agent = spawn(bin as string, args, { stdio: ['pipe', 'pipe', 'inherit'], detached: true })
agentPid = agent.pid
agent.on('error', (error) => fail(`could not start ${bin}: ${error.message}`))
let cancel = async () => {}
let close = async () => {}
const stop = async (code: number) => {
  const ended = async () => {
    await cancel()
    await close()
  }
  await Promise.race([ended(), new Promise((resolve) => setTimeout(resolve, 2000))])
  try {
    if (agent.pid !== undefined) process.kill(-agent.pid, 'SIGTERM')
  } catch {}
  process.exit(code)
}
process.on('SIGTERM', () => void stop(0))
process.on('SIGINT', () => void stop(0))
agent.on('exit', (code) => {
  out({ relay: 'agent_exit', code })
  process.exit(code ?? 1)
})

const RUN = `${process.pid}-${Date.now().toString(36)}`
const asked = new Map<string, Answer>()
let asks = 0
type QuestionAnswer = acp.CreateElicitationResponse
const questions = new Map<string, (answer: QuestionAnswer) => void>()
const CANCEL: QuestionAnswer = { action: 'cancel' }
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
    case 'session_message':
      return update.content ? { ...update, content: update.content.map(saved) } : update
    case 'session_message_chunk':
      return { ...update, content: saved(update.content) }
    default:
      return update
  }
}

const closeQuestion = (id: string) => {
  const answerIt = questions.get(id)
  if (answerIt === undefined) return
  questions.delete(id)
  out({ relay: 'question_closed', id })
  answerIt(CANCEL)
}
const question = (request: acp.CreateElicitationRequest): RelayQuestion => {
  if (request.mode === 'url') {
    const { message, url, elicitationId } = request as Extract<acp.CreateElicitationRequest, { mode: 'url' }>
    return { mode: 'url', message, url, elicitationId }
  }
  return { mode: 'form', message: request.message, requestedSchema: 'requestedSchema' in request ? request.requestedSchema : undefined }
}
const web = (url: unknown) => {
  try {
    return ['https:', 'http:'].includes(new URL(String(url)).protocol)
  } catch {
    return false
  }
}
const REPLY = z
  .discriminatedUnion('action', [
    z.object({ action: z.literal('accept'), content: z.record(z.string(), z.unknown()).catch({}) }),
    z.object({ action: z.literal('decline') }),
    z.object({ action: z.literal('cancel') }),
  ])
  .catch({ action: 'cancel' })
const INBOX: z.ZodType<InboxLine> = z.union([
  z.string(),
  z.object({ question: z.string(), answer: REPLY }),
  z.object({ answer: z.string(), optionId: z.string().nullable().default(null) }),
  z.object({ interrupt: z.string() }),
])
const inboxLine = (text: string): { line: InboxLine } | { skipped: string } => {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { skipped: 'not JSON' }
  }
  const parsed = INBOX.safeParse(value)
  return parsed.success ? { line: parsed.data } : { skipped: 'not a steer, an interrupt or an answer' }
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
    if (!process.env.RELAY_INBOX) return CANCEL
    if (ctx.params.mode === 'url' && !web(ctx.params.url)) return CANCEL
    const id = `${RUN}-q${++asks}`
    out({ relay: 'question', id, ...question(ctx.params) })
    return new Promise<QuestionAnswer>((resolve) => {
      questions.set(id, resolve)
      if (ctx.signal.aborted) closeQuestion(id)
      else ctx.signal.addEventListener('abort', () => closeQuestion(id), { once: true })
    })
  })
  .onNotification(acp.methods.client.session.update, (ctx) => {
    if (!busy && ctx.params.update.sessionUpdate === 'agent_message_chunk') spokeIdle = true
    out({ ...ctx.params, update: savedUpdate(ctx.params.update) })
  })
  .connectWith(stream, async (ctx) => {
    const init = await ctx.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: CAPABILITIES,
    })
    if (forget) {
      const offered = init.agentCapabilities?.sessionCapabilities
      const how = offered?.archive ? 'archived' : offered?.delete ? 'deleted' : undefined
      if (how === undefined) return fail('the agent offers no way to delete or archive a session')
      const gone = await ctx
        .request(how === 'archived' ? acp.methods.agent.session.archive : acp.methods.agent.session.delete, { sessionId: forget })
        .then(
          () => false,
          (error: unknown) => {
            if ((error as { code?: unknown })?.code === -32002) return true
            return fail(`could not ${how === 'archived' ? 'archive' : 'delete'} the session: ${reason(error)}`)
          },
        )
      out({ relay: 'forgotten', sessionId: forget, how: gone ? 'gone' : how })
      return stop(0)
    }
    const resume = process.env.RELAY_SESSION
    const opened = resume
      ? await ctx.request(acp.methods.agent.session.load, { sessionId: resume, cwd, mcpServers: [] }).catch((error: unknown) => {
          const message = reason(error)
          const data = JSON.stringify((error as { data?: unknown })?.data ?? '')
          if (!/not found/i.test(`${message} ${data}`)) return fail(`could not resume the session: ${message}`)
          out({ relay: 'session_lost', message })
          process.stderr.write(`acp relay: session lost: ${message}\n`)
          return process.exit(1)
        })
      : await ctx.request(acp.methods.agent.session.new, { cwd, mcpServers: [] })
    const sessionId = resume ?? (opened as acp.NewSessionResponse).sessionId
    cancel = async () => {
      await ctx.notify(acp.methods.agent.session.cancel, { sessionId })
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
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
    const TUNING = ['model_config', 'speed']
    const reserved = (o: acp.SessionConfigOption) => !TUNING.includes(String(o.category)) || o.id === 'mode' || o.id === 'model'
    let options: Record<string, unknown> = {}
    try {
      options = JSON.parse(process.env.RELAY_OPTIONS || '{}') as Record<string, unknown>
    } catch {
      fail('RELAY_OPTIONS is not a JSON object')
    }
    const configure = async (session: { configOptions?: acp.SessionConfigOption[] | null }, first: boolean) => {
      if (modeId)
        await ctx
          .request(acp.methods.agent.session.setMode, { sessionId, modeId })
          .catch((error: unknown) => fail(`the agent refused mode ${modeId}: ${reason(error)}`))
      let configOptions = session.configOptions ?? []
      const model = process.env.RELAY_MODEL
      if (model) {
        const set = await ctx
          .request(acp.methods.agent.session.setConfigOption, { sessionId, configId: 'model', value: model })
          .catch((error: unknown) => fail(`the agent refused model ${model}: ${reason(error)}`))
        configOptions = set.configOptions ?? configOptions
      }
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
        if (option === undefined) {
          const title = `the agent offers no ${configId} option${forModel}, so this run goes without it; it offers ${settable().join(', ') || 'none'}. config: ${configId}= drops it.`
          if (first) out({ sessionId, update: { sessionUpdate: 'notice', severity: 'warning', title } })
          continue
        }
        await setOption(configId, value)
      }
      for (const [configId, value] of Object.entries(extra)) await setOption(configId, value)
      if (modeId && Object.keys(options).length > 0)
        await ctx
          .request(acp.methods.agent.session.setMode, { sessionId, modeId })
          .catch((error: unknown) => fail(`the agent refused mode ${modeId}: ${reason(error)}`))
      return configOptions
    }
    const configOptions = await configure(opened as { configOptions?: acp.SessionConfigOption[] | null }, true)
    out({ relay: 'session', sessionId, cwd })
    const title = process.env.RELAY_TITLE?.trim()
    if (!resume && title && (init.agentCapabilities?.sessionCapabilities as { title?: unknown } | undefined)?.title)
      await ctx.request(acp.methods.agent.session.setTitle, { sessionId, title }).catch(() => {})
    const current = configOptions.find((o) => o.id === 'model')
    if (current && 'currentValue' in current && typeof current.currentValue === 'string')
      out({ relay: 'model', name: current.currentValue })

    const queue = [prompt]
    let interrupt: string | undefined
    let last: acp.PromptResponse | undefined
    const promptDone = (r: acp.PromptResponse) => out({ relay: 'prompt_done', stopReason: r.stopReason, usage: r.usage ?? null })
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
    let extensionSteers: Promise<void> = Promise.resolve()
    const steerByExtension = (text: string) =>
      (extensionSteers = extensionSteers.then(async () => {
        if (!busy || interrupt !== undefined) return void queue.push(text)
        const r = await ctx
          .request<{ outcome?: string }>('_session/steering', prompted(text))
          .catch((error: unknown) => refused(text, error))
        if (r === undefined) return
        if (r.outcome === 'injected') return void out({ relay: 'steered' })
        if (r.outcome === 'startedNewTurn') await ctx.notify(acp.methods.agent.session.cancel, { sessionId }).catch(() => {})
        queue.push(text)
      }))
    const steerByPrompt = async (text: string) => {
      const r = await ctx.request(acp.methods.agent.session.prompt, prompted(text)).catch((error: unknown) => refused(text, error))
      if (r === undefined || r.stopReason === 'cancelled') return
      out({ relay: 'steered' })
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
    let lines = 0
    const inbox = process.env.RELAY_INBOX
    if (inbox)
      setInterval(() => {
        if (!existsSync(inbox)) return
        const text = readFileSync(inbox, 'utf8')
        const end = text.lastIndexOf('\n')
        if (end < offset) return
        for (const raw of text.slice(offset, end).split('\n')) {
          lines += 1
          if (!raw.trim()) continue
          const read = inboxLine(raw)
          if ('skipped' in read) {
            trace('inbox', { skipped: read.skipped, line: raw })
            process.stderr.write(`acp relay: skipped inbox line ${lines}: ${read.skipped}\n`)
            continue
          }
          const value = read.line
          trace('inbox', value)
          if (typeof value === 'string') {
            if (busy && interrupt === undefined && process.env.RELAY_STEER) steer(value)
            else queue.push(value)
          } else if ('question' in value) {
            questions.get(value.question)?.(value.answer as QuestionAnswer)
            questions.delete(value.question)
          } else if ('answer' in value) {
            asked.get(value.answer)?.(value.optionId)
            asked.delete(value.answer)
          } else {
            const text = value.interrupt
            interrupt = interrupt === undefined ? text : `${interrupt}\n\n${text}`
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
      busy = true
      sentPrompt = true
      spokeIdle = false
      const r = await ctx.request(acp.methods.agent.session.prompt, prompted(text)).catch((error: unknown) => fail(reason(error)))
      busy = false
      last = r
      promptDone(r)
      if (interrupt !== undefined) {
        out({ relay: 'interrupted' })
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
    await Promise.race([close(), new Promise((resolve) => setTimeout(resolve, 2000))])
    close = async () => {}
    return last
  })

out({ relay: 'done', stopReason: result?.stopReason ?? null })
cancel = async () => {}
await stop(0)
