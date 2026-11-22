// A fake ACP agent for the relay's tests, on the SDK's own agent side. By default its prompt fails as
// codex-acp's does when Codex hits its usage limit, with the cause in the error's data. With FAKE_ECHO
// set it takes images and answers with what it was offered: the client's capabilities, as the SDK
// hands them to an agent, and the prompt's block types; FAKE_STOP is the stop reason it ends with.
// FAKE_CLOSE advertises session/close, and with `resume` session/resume too; FAKE_HANG holds the prompt until a
// cancel, or with `stubborn` past it, or with `once` only the first prompt; FAKE_LOG names a file each cancel and close is written to. FAKE_OPTIONS offers config options, as
// codex-acp does: a model and its reasoning efforts; each set one is logged. FAKE_REFUSE refuses every config
// option and mode, with its reason in the error's data, as testy and codex-acp do. FAKE_ASK asks permission to run a
// command before it answers, then answers with the option the relay chose. FAKE_QUESTION (form or url) asks the person
// one question before it answers, then answers with what came back; FAKE_QUESTION_URL is the link it asks to open;
// FAKE_WITHDRAW withdraws the question ($/cancel_request) as soon as it is asked. FAKE_IMAGE answers with an image,
// and a resumed session replays one; FAKE_IMAGE=message sends one in a message to a subagent.
import { appendFileSync } from 'node:fs'
import { Readable, Writable } from 'node:stream'
// The unstable schema, as codex-acp's: the stable one has no plan capability and drops it.
import * as acp from '@agentclientprotocol/sdk/unstable'
import { PNG } from './support/png.mts'

const echo = process.env.FAKE_ECHO === '1'
const log = (what: string) => process.env.FAKE_LOG && appendFileSync(process.env.FAKE_LOG, `${what}\n`)
let offered: acp.ClientCapabilities | undefined
const select = (id: string, category: string, currentValue: string, values: readonly string[]): acp.SessionConfigOption => ({
  id,
  name: id,
  category,
  type: 'select' as const,
  currentValue,
  options: values.map((value) => ({ value, name: value })),
})
// As codex-acp 2.6.0 offers them for gpt-6-luna: no ultra.
const ALL_OPTIONS: acp.SessionConfigOption[] = [
  select('model', 'model', 'gpt-6-luna', ['gpt-6-luna', 'gpt-6.1-sol']),
  select('reasoning_effort', 'thought_level', 'medium', ['low', 'medium', 'high', 'xhigh']),
  select('mode', 'mode', 'read-only', ['read-only', 'agent-full-access']),
  select('fast-mode', 'model_config', 'off', ['off', 'on']),
  // As a harness might name a looser sandbox: no category via knows.
  select('sandbox', 'other', 'on', ['on', 'off']),
]
// FAKE_OPTIONS=plain offers none that tune the model, as opencode's are.
const OPTIONS = process.env.FAKE_OPTIONS === 'plain' ? ALL_OPTIONS.filter((o) => o.category !== 'model_config') : ALL_OPTIONS
let release: (() => void) | undefined
let prompts = 0
// The stop reasons a prompt may end with: each one checked against the SDK's.
const STOPS = ['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled'] as const satisfies readonly acp.StopReason[]
await acp
  .agent()
  .onRequest(acp.methods.agent.initialize, (ctx) => {
    offered = ctx.params.clientCapabilities
    const sessionCapabilities =
      process.env.FAKE_CLOSE === 'resume' ? { close: {}, resume: {} } : process.env.FAKE_CLOSE === '1' ? { close: {} } : {}
    return {
      protocolVersion: ctx.params.protocolVersion,
      agentCapabilities: { loadSession: true, promptCapabilities: { image: echo }, sessionCapabilities },
    }
  })
  .onRequest(acp.methods.agent.session.load, async (ctx) => {
    if (process.env.FAKE_IMAGE === '1')
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: 's1',
        update: { sessionUpdate: 'user_message_chunk', content: { type: 'image', mimeType: 'image/png', data: PNG } },
      })
    return {}
  })
  .onRequest(acp.methods.agent.session.new, () =>
    process.env.FAKE_OPTIONS ? { sessionId: 's1', configOptions: OPTIONS } : { sessionId: 's1' },
  )
  .onRequest(acp.methods.agent.session.setMode, (ctx) => {
    if (process.env.FAKE_REFUSE === '1') throw acp.RequestError.invalidParams(`no mode ${ctx.params.modeId} here; try workspace-write`)
    log(`mode ${ctx.params.modeId}`)
    return {}
  })
  .onRequest(acp.methods.agent.session.setConfigOption, (ctx) => {
    if (process.env.FAKE_REFUSE === '1')
      throw acp.RequestError.invalidParams(`no ${ctx.params.configId} ${ctx.params.value} here; try gpt-6-luna`)
    log(`set ${ctx.params.configId}=${ctx.params.value}`)
    return { configOptions: OPTIONS }
  })
  .onRequest(acp.methods.agent.session.close, () => {
    log('close')
    return {}
  })
  .onRequest(acp.methods.agent.session.resume, () => {
    log('resume')
    return {}
  })
  .onNotification(acp.methods.agent.session.cancel, () => {
    log('cancel')
    if (process.env.FAKE_HANG !== 'stubborn') release?.()
  })
  .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
    if (process.env.FAKE_HANG) log('prompt')
    if (process.env.FAKE_HANG && (process.env.FAKE_HANG !== 'once' || prompts++ === 0)) {
      // Said once the prompt is held, so a test waits on this line, never on time.
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: 's1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'holding' } },
      })
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return { stopReason: 'cancelled' }
    }
    if (process.env.FAKE_IMAGE === 'message') {
      // A message to a subagent with an image, whole and as a chunk (ACP's subagents RFD).
      const image = { type: 'image' as const, mimeType: 'image/png', data: PNG }
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: 's1',
        update: { sessionUpdate: 'session_message', messageId: 'm1', senderSessionId: 's1', recipientSessionId: 'c1', content: [image] },
      })
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: 'c1',
        update: { sessionUpdate: 'session_message_chunk', messageId: 'm2', content: image },
      })
      return { stopReason: 'end_turn' }
    }
    if (process.env.FAKE_IMAGE === '1') {
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: 's1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'image', mimeType: 'image/png', data: PNG } },
      })
      return { stopReason: 'end_turn' }
    }
    if (process.env.FAKE_QUESTION) {
      const withdraw = new AbortController()
      const asking = ctx.client.request(
        acp.methods.client.elicitation.create,
        process.env.FAKE_QUESTION === 'url'
          ? {
              sessionId: 's1',
              mode: 'url',
              message: 'Sign in to continue.',
              url: process.env.FAKE_QUESTION_URL ?? 'https://example.com/login',
              elicitationId: 'e1',
            }
          : {
              sessionId: 's1',
              mode: 'form',
              message: 'Which target?',
              requestedSchema: {
                type: 'object',
                properties: { target: { type: 'string', enum: ['staging', 'production'] } },
                required: ['target'],
              },
            },
        { cancellationSignal: withdraw.signal },
      )
      if (process.env.FAKE_WITHDRAW === '1') withdraw.abort()
      const asked = await asking.catch((error: unknown) => ({ error: (error as { code?: unknown }).code }))
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: 's1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `got ${JSON.stringify(asked)}` } },
      })
      return { stopReason: 'end_turn' }
    }
    if (process.env.FAKE_ASK === '1') {
      const asked = await ctx.client.request(acp.methods.client.session.requestPermission, {
        sessionId: 's1',
        toolCall: { toolCallId: 'ask-1', title: 'rm -rf build', kind: 'execute', status: 'pending' },
        options: [
          { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
          { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' },
        ],
      })
      const chose = asked.outcome.outcome === 'selected' ? asked.outcome.optionId : 'cancelled'
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: 's1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `chose ${chose}` } },
      })
      return { stopReason: 'end_turn' }
    }
    if (!echo) throw acp.RequestError.internalError({ details: "You've hit your usage limit. Try again at 10:04 PM." })
    const blocks = ctx.params.prompt.map((b) => (b.type === 'image' ? `image:${b.mimeType}:${b.data.length}` : b.type))
    const text = JSON.stringify({ offered, blocks })
    await ctx.client.notify(acp.methods.client.session.update, {
      sessionId: 's1',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    })
    const stopReason = STOPS.find((stop) => stop === (process.env.FAKE_STOP || 'end_turn'))
    if (stopReason === undefined) throw new Error(`FAKE_STOP must be one of ${STOPS.join(', ')}`)
    return { stopReason }
  })
  .connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>)).closed
