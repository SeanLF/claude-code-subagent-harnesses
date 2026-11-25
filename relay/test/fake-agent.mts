import { appendFileSync } from 'node:fs'
import { Readable, Writable } from 'node:stream'
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
const ALL_OPTIONS: acp.SessionConfigOption[] = [
  select('model', 'model', 'gpt-6-luna', ['gpt-6-luna', 'gpt-6.1-sol']),
  select('reasoning_effort', 'thought_level', 'medium', ['low', 'medium', 'high', 'xhigh']),
  select('mode', 'mode', 'read-only', ['read-only', 'agent-full-access']),
  select('fast-mode', 'model_config', 'off', ['off', 'on']),
  select('sandbox', 'other', 'on', ['on', 'off']),
]
const OPTIONS = process.env.FAKE_OPTIONS === 'plain' ? ALL_OPTIONS.filter((o) => o.category !== 'model_config') : ALL_OPTIONS
let release: (() => void) | undefined
let prompts = 0
const STOPS = ['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled'] as const satisfies readonly acp.StopReason[]
await acp
  .agent()
  .onRequest(acp.methods.agent.initialize, (ctx) => {
    offered = ctx.params.clientCapabilities
    const closing = process.env.FAKE_CLOSE === 'resume' ? { close: {}, resume: {} } : process.env.FAKE_CLOSE === '1' ? { close: {} } : {}
    const titled = process.env.FAKE_TITLE ? { ...closing, title: {} } : closing
    const forgets = process.env.FAKE_DELETE
    const sessionCapabilities = !forgets
      ? titled
      : forgets === 'archive' || forgets === 'gone'
        ? { ...titled, list: {}, archive: {}, delete: {} }
        : { ...titled, delete: {} }
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
  .onRequest(acp.methods.agent.session.new, () => {
    if (process.env.FAKE_DELETE) log('new')
    return process.env.FAKE_OPTIONS ? { sessionId: 's1', configOptions: OPTIONS } : { sessionId: 's1' }
  })
  .onRequest(acp.methods.agent.session.delete, (ctx) => {
    log(`delete ${ctx.params.sessionId}`)
    return {}
  })
  .onRequest(acp.methods.agent.session.archive, (ctx) => {
    if (process.env.FAKE_DELETE === 'gone') throw acp.RequestError.resourceNotFound(ctx.params.sessionId)
    log(`archive ${ctx.params.sessionId}`)
    return {}
  })
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
  .onRequest(acp.methods.agent.session.setTitle, (ctx) => {
    if (process.env.FAKE_TITLE === 'refuse') throw acp.RequestError.invalidParams('title too long')
    log(`title ${ctx.params.title}`)
    return { title: ctx.params.title }
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
    if (process.env.FAKE_ERROR === 'record')
      throw acp.RequestError.internalError({ details: 'd'.repeat(600), request: { env: { OPENAI_API_KEY: 'sk-SECRET' } } })
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
