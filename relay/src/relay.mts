// Holds an ACP (Agent Client Protocol) connection open for via, whose spawn writes stdin once and
// closes it. Built into relay/relay.mjs (pnpm build:relay), which ships with the SDK inlined.
//
// Usage: node relay.mjs -- <agent command...>, with the prompt on stdin.
// Env:
//   VIA_INBOX       file of JSON lines via appends: a string queues a follow-up, {"interrupt": text}
//                   cancels the turn and runs text next, {"answer": id, "optionId": id|null} answers a question
//   VIA_SESSION     a session to resume (session/load)
//   VIA_MODEL       the agent's `model` config option
//   VIA_AGENT_MODE  the agent's own mode (session/set_mode), such as codex's workspace-write
//   VIA_CONFIG      a JSON object of other config options to set, such as {"reasoning_effort": "high"}
//   VIA_POLICY      how permission requests are answered: allow, deny (the default) or ask (every request
//                   goes to via)
// Prints each ACP session update as received, and {"via": ...} lines for its own events.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'

type Policy = 'allow' | 'deny' | 'ask'
type Answer = (optionId: string | null) => void

const out = (event: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(event)}\n`)
let agentPid: number | undefined
const fail = (message: string): never => {
  out({ via: 'error', message })
  process.stderr.write(`via relay: ${message}\n`)
  try {
    if (agentPid !== undefined) process.kill(-agentPid, 'SIGTERM')
  } catch {
    // Already gone.
  }
  process.exit(1)
}
const reason = (error: unknown) => String((error as { message?: unknown })?.message ?? error)

const dash = process.argv.indexOf('--')
const [bin, ...args] = dash < 0 ? [] : process.argv.slice(dash + 1)
if (bin === undefined) fail('usage: relay.mjs -- <agent command...>')
const policy = (process.env.VIA_POLICY ?? 'deny') as Policy
if (!['allow', 'deny', 'ask'].includes(policy)) fail(`VIA_POLICY must be allow, deny or ask, not ${policy}`)
const cwd = process.cwd()

const prompt = await new Promise<string>((resolve) => {
  let text = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk: string) => (text += chunk))
  process.stdin.on('end', () => resolve(text))
})

// Its own process group, so a stop also reaches what it started.
const agent = spawn(bin as string, args, { stdio: ['pipe', 'pipe', 'inherit'], detached: true })
agentPid = agent.pid
agent.on('error', (error) => fail(`could not start ${bin}: ${error.message}`))
// Set once a session exists. Cancelling ends the agent's running tool, which a kill does not: opencode
// runs commands in their own process group, so a group kill left a `sleep` running.
let cancel = async () => {}
const stop = async (code: number) => {
  await Promise.race([cancel(), new Promise((resolve) => setTimeout(resolve, 2000))])
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
  out({ via: 'agent_exit', code })
  process.exit(code ?? 1)
})

// Ids unique to this run: a late answer to an earlier run's question must never match one here.
const RUN = `${process.pid}-${Date.now().toString(36)}`
const asked = new Map<string, Answer>()
let asks = 0
const choose = (options: readonly acp.PermissionOption[], kind: acp.PermissionOptionKind): acp.RequestPermissionResponse => {
  const option = options.find((o) => o.kind === kind)
  return { outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } }
}

const stream = acp.ndJsonStream(Writable.toWeb(agent.stdin) as WritableStream<Uint8Array>, Readable.toWeb(agent.stdout) as ReadableStream<Uint8Array>)
const result = await acp
  .client({ name: 'via' })
  .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
    const { toolCall, options } = ctx.params
    if (policy === 'allow') return choose(options, 'allow_once')
    // With no inbox no answer can come back: deny rather than wait forever.
    if (policy === 'deny' || !process.env.VIA_INBOX) return choose(options, 'reject_once')
    const id = `${RUN}-${++asks}`
    const raw = toolCall.rawInput as { command?: unknown } | undefined
    out({
      via: 'ask',
      id,
      title: toolCall.title ?? '',
      kind: toolCall.kind ?? 'other',
      ...(typeof raw?.command === 'string' ? { command: raw.command } : Array.isArray(raw?.command) ? { command: raw.command.join(' ') } : {}),
      options: options.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
    })
    return new Promise<acp.RequestPermissionResponse>((resolve) =>
      asked.set(id, (optionId) => resolve(optionId ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } })),
    )
  })
  .onNotification(acp.methods.client.session.update, (ctx) => {
    out(ctx.params as unknown as Record<string, unknown>)
  })
  .connectWith(stream, async (ctx) => {
    await ctx.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    })
    const resume = process.env.VIA_SESSION
    const opened = resume
      ? await ctx.request(acp.methods.agent.session.load, { sessionId: resume, cwd, mcpServers: [] }).catch((error: unknown) => {
          const message = reason(error)
          const data = JSON.stringify((error as { data?: unknown })?.data ?? '')
          // Only a session the agent no longer has is lost; anything else (auth, a crash) is a failure.
          if (!/not found/i.test(`${message} ${data}`)) return fail(`could not resume the session: ${message}`)
          out({ via: 'session_lost', message })
          process.stderr.write(`via relay: session lost: ${message}\n`)
          return process.exit(1)
        })
      : await ctx.request(acp.methods.agent.session.new, { cwd, mcpServers: [] })
    const sessionId = resume ?? (opened as acp.NewSessionResponse).sessionId
    out({ via: 'session', sessionId })
    cancel = async () => {
      await ctx.notify(acp.methods.agent.session.cancel, { sessionId })
      // A moment for the agent to abort its tool before the kill.
      await new Promise((resolve) => setTimeout(resolve, 500))
    }

    const modeId = process.env.VIA_AGENT_MODE
    if (modeId)
      await ctx.request(acp.methods.agent.session.setMode, { sessionId, modeId }).catch((error: unknown) => fail(`the agent refused mode ${modeId}: ${String((error as { message?: unknown })?.message ?? error)}`))
    let configOptions = (opened as { configOptions?: acp.SessionConfigOption[] | null }).configOptions ?? []
    const model = process.env.VIA_MODEL
    if (model) {
      // A model the agent refuses ends the run: carrying on would answer from its default model.
      const set = await ctx
        .request(acp.methods.agent.session.setConfigOption, { sessionId, configId: 'model', value: model })
        .catch((error: unknown) => fail(`the agent refused model ${model}: ${String((error as { message?: unknown })?.message ?? error)}`))
      configOptions = set.configOptions ?? configOptions
    }
    let extra: Record<string, unknown> = {}
    try {
      extra = JSON.parse(process.env.VIA_CONFIG || '{}') as Record<string, unknown>
    } catch {
      fail('VIA_CONFIG is not a JSON object')
    }
    for (const [configId, value] of Object.entries(extra)) {
      if (typeof value !== 'string') fail(`VIA_CONFIG.${configId} must be a string`)
      const set = await ctx
        .request(acp.methods.agent.session.setConfigOption, { sessionId, configId, value: value as string })
        .catch((error: unknown) => fail(`the agent refused ${configId} ${String(value)}: ${String((error as { message?: unknown })?.message ?? error)}`))
      configOptions = set.configOptions ?? configOptions
    }
    const current = configOptions.find((o) => o.id === 'model')
    if (current && 'currentValue' in current && typeof current.currentValue === 'string') out({ via: 'model', name: current.currentValue })

    const queue = [prompt]
    let interrupt: string | undefined
    let offset = 0
    const inbox = process.env.VIA_INBOX
    if (inbox)
      setInterval(() => {
        if (!existsSync(inbox)) return
        const text = readFileSync(inbox, 'utf8')
        const end = text.lastIndexOf('\n')
        if (end < offset) return
        for (const line of text.slice(offset, end).split('\n')) {
          if (!line.trim()) continue
          const value = JSON.parse(line) as unknown
          if (typeof value === 'string') queue.push(value)
          else if (typeof value === 'object' && value !== null && 'answer' in value) {
            const { answer, optionId } = value as { answer: string; optionId?: string | null }
            asked.get(answer)?.(optionId ?? null)
            asked.delete(answer)
          } else if (typeof value === 'object' && value !== null && 'interrupt' in value) {
            const text = String((value as { interrupt: unknown }).interrupt)
            interrupt = interrupt === undefined ? text : `${interrupt}\n\n${text}`
            // An unanswered question would hold the turn open past the cancel.
            for (const [id, answerIt] of asked) answerIt(null), asked.delete(id)
            void ctx.notify(acp.methods.agent.session.cancel, { sessionId })
          }
        }
        offset = end + 1
      }, 300).unref()

    let last: acp.PromptResponse | undefined
    while (queue.length > 0) {
      const text = queue.shift() as string
      out({ via: 'steered' })
      last = await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text }] }).catch((error: unknown) => fail(reason(error)))
      // Not in the stable type, but codex-acp and opencode send it.
      out({ via: 'prompt_done', stopReason: last.stopReason, usage: (last as { usage?: unknown }).usage ?? null })
      if (interrupt !== undefined) {
        out({ via: 'interrupted' })
        queue.unshift(interrupt)
        interrupt = undefined
      }
    }
    return last
  })

out({ via: 'done', stopReason: result?.stopReason ?? null })
cancel = async () => {}
await stop(0)
