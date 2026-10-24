import type { Register, Timer, TurnStepChunk, TurnStepResult, TurnUsage } from 'claude-code'
import type { PiChoice } from '../types'

const HANDBACK_TOOL = 'SubagentHandback'
const VALUE = { model: /^[A-Za-z0-9_.:\/*~@+-]+$/, tools: /^[A-Za-z0-9_*+,:.-]+$/, thinking: /^\S+$/ }
type PromptKey = keyof typeof VALUE
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
type ThinkingLevel = (typeof THINKING_LEVELS)[number]
const isThinkingLevel = (value: string): value is ThinkingLevel => (THINKING_LEVELS as readonly string[]).includes(value)
const PI_LINE = /^pi-([A-Za-z]+):[ \t]*(.*?)[ \t]*$/
const ANSI = /\u001b\[[0-9;]*m/g

const DESCRIPTION =
  'Delegates to the pi CLI in an isolated pi session. Use for work you want done by pi\'s model and tools rather than Claude\'s: a second opinion from another provider, or a cheap bulk pass. Runs pi\'s own read/bash/edit/write tools, so it can change files. Configuration lines go at the very top of the prompt, one per line before the task, and nowhere else: a `pi-` line later in the prompt is ordinary text. To choose pi\'s model, put `pi-model: <pattern>` there (anything `pi --model` accepts, such as `openrouter/moonshotai/kimi-k2`; `pi --list-models <search>` lists them); without that line pi uses the plugin\'s defaultModel setting if set, else pi\'s own default. To make pi read-only, put `pi-tools: read` there (any comma-separated list `pi --tools` accepts, such as `-bash,read`); like `pi-model:` it holds for the agent\'s later messages. To set thinking depth, put `pi-thinking: <level>` there, one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`, which is the same setting as a `:<level>` suffix on the model (such as `pi-model: x:high`) and likewise holds for later messages. Every genuine answer ends with a line `— answered by pi, <provider/model>`; an answer without it did not come from pi.'

const NOT_ACTIVE =
  'The pi plugin did not run this task, so pi did not answer it. Check the plugin is loaded in /plugin and restart Claude Code.'

const PROMPT = `You are not pi: this plugin did not take this step. Use no tools and do not attempt the task. Reply with exactly this and nothing else:\n\n${NOT_ACTIVE}`

type Usage = { i: number; o: number; cr: number; cw: number }
type PiEvent =
  | { k: 'msg'; model: string }
  | { k: 'usage'; usage: Usage; error?: string }
  | { k: 'text' | 'thinking' | 'tool'; t: string }

type Turn = { prompt: string; report?: string; delivered: boolean }

export type PromptSpec = {
  prompt: string
  model?: string
  tools?: string
  thinking?: ThinkingLevel
  error?: string
}

export function promptOf(text: string): PromptSpec {
  const lines = text.trimStart().split('\n')
  let end = 0
  while (end < lines.length && PI_LINE.test(lines[end] ?? '')) end += 1
  if (end === 0) return { prompt: text }

  const asked: Omit<PromptSpec, 'prompt' | 'error'> = {}
  for (const line of lines.slice(0, end)) {
    const [, name = '', value = ''] = PI_LINE.exec(line) ?? []
    const key = name.toLowerCase()
    const bad = (why: string) => ({ prompt: text, error: `Invalid pi prompt line ${JSON.stringify(line)}: ${why}` })
    if (!(key in VALUE)) return bad('unknown key; known keys are pi-model, pi-tools and pi-thinking.')
    if (!VALUE[key as PromptKey].test(value)) return bad('expected one whitespace-free value.')
    if (key === 'thinking') {
      if (!isThinkingLevel(value)) return bad(`pi-thinking must be one of ${THINKING_LEVELS.join(', ')}; got ${JSON.stringify(value)}.`)
      asked.thinking ??= value
    } else asked[key as 'model' | 'tools'] ??= value
  }
  return { prompt: lines.slice(end).join('\n').trim(), ...asked }
}

export function eventOf(line: string): PiEvent | undefined {
  let e: any
  try {
    e = JSON.parse(line)
  } catch {
    return undefined
  }
  const delta = e.type === 'message_update' ? e.assistantMessageEvent : undefined
  if (e.type === 'message_start' && e.message?.role === 'assistant') {
    return { k: 'msg', model: `${e.message.provider}/${e.message.model}` }
  }
  if (e.type === 'message_end' && e.message?.role === 'assistant') {
    const u = e.message.usage ?? {}
    const usage = { i: u.input ?? 0, o: u.output ?? 0, cr: u.cacheRead ?? 0, cw: u.cacheWrite ?? 0 }
    return e.message.stopReason === 'error' ? { k: 'usage', usage, error: String(e.message.errorMessage ?? 'unknown error') } : { k: 'usage', usage }
  }
  if (delta?.type === 'text_delta') return { k: 'text', t: delta.delta }
  if (delta?.type === 'thinking_delta') return { k: 'thinking', t: delta.delta }
  if (e.type === 'tool_execution_start') {
    const args = JSON.stringify(e.args ?? {})
    return { k: 'tool', t: `\n▸ ${e.toolName}: ${args.length > 100 ? `${args.slice(0, 100)}…` : args}\n` }
  }
  return undefined
}

async function* respond(
  e: { turnId: string; index: number },
  chunks: TurnStepChunk[],
  answer: string,
  toolUses: TurnStepResult['toolUses'] = [],
): AsyncGenerator<TurnStepChunk, TurnStepResult> {
  yield* chunks
  const stop = chunks.at(-1)
  return {
    turnId: e.turnId,
    index: e.index,
    answer,
    toolUses,
    stopReason: stop?.kind === 'stop' ? stop.stopReason : 'end_turn',
    usage: stop?.kind === 'stop' ? stop.usage : null,
  }
}

export const register: Register = (on, options) => {
  const defaultModel = typeof options.defaultModel === 'string' ? options.defaultModel.trim() : ''
  const asked = options.timeoutMinutes
  const timeoutMinutes = typeof asked === 'number' && Number.isFinite(asked) && asked > 0 ? asked : 30
  const turns = new Map<string, Turn>()
  const piAgents = new Set<string>()
  const seeds = new Map<string, string>()

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.agent.register({ name: 'general-purpose', description: DESCRIPTION, prompt: PROMPT, tools: [], model: 'haiku' })
    return started
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.agentId && e.subagentType === `${$.plugin.name}:general-purpose`) seeds.set(started.agentId, e.prompt)
    return started
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) {
      const prompt = e.text || seeds.get(e.agentId)
      seeds.delete(e.agentId)
      if (prompt) turns.set(e.turnId, { prompt, delivered: false })
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    turns.delete(e.turnId)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const agentId = e.agentId
    if (agentId === undefined) return yield* next(e)
    if (!piAgents.has(agentId)) {
      const agent = (await $.agent.list()).find((a) => a.id === agentId)
      if (agent?.type !== `${$.plugin.name}:general-purpose`) return yield* next(e)
      piAgents.add(agentId)
    }

    const turn = turns.get(e.turnId)
    if (turn === undefined) return yield* respond(e, textChunks(NOT_ACTIVE), NOT_ACTIVE)
    if (turn.delivered) return yield* respond(e, textChunks('Report delivered.'), 'Report delivered.')
    if (turn.report !== undefined) return yield* deliver(e, turn, 0, turn.report, null)

    if (defaultModel && !VALUE.model.test(defaultModel)) {
      const bad = `The pi plugin's defaultModel setting ${JSON.stringify(defaultModel)} is not a pi --model pattern.`
      return yield* respond(e, textChunks(bad), bad)
    }
    const asked = promptOf(turn.prompt)
    if (asked.error !== undefined) return yield* respond(e, textChunks(asked.error), asked.error)
    const ref = { plugin: 'pi', key: 'agents', id: agentId } as const
    const held = await $.state.get(ref)
    const merged: PiChoice = {
      ...held.value,
      ...(asked.model ? { model: asked.model } : {}),
      ...(asked.tools ? { tools: asked.tools } : {}),
      ...(asked.thinking ? { thinking: asked.thinking } : {}),
    }
    const changed =
      merged.model !== held.value?.model || merged.tools !== held.value?.tools || merged.thinking !== held.value?.thinking
    if (changed) await $.state.set(ref, merged)
    const model = merged.model || defaultModel || undefined
    const allowed = merged.tools
    const level = merged.thinking
    const request = {
      argv: [
        'pi',
        '-p',
        '--mode',
        'json',
        '--session-id',
        `pi-${agentId}`,
        ...(model ? ['--model', model] : []),
        ...(allowed ? ['--tools', allowed] : []),
        ...(level ? ['--thinking', level] : []),
      ],
      input: asked.prompt,
    }

    let index = -1
    let kind: 'text' | 'thinking' | undefined
    let buffer = ''
    let stderr = ''
    let report = ''
    let answeredBy = ''
    let failure = ''
    let piError = ''
    const total: Usage = { i: 0, o: 0, cr: 0, cw: 0 }
    const push = (k: 'text' | 'thinking', text: string): TurnStepChunk => {
      if (k !== kind) {
        kind = k
        index += 1
      }
      return { kind: k, index, text }
    }
    const take = (line: string): TurnStepChunk[] => {
      const event = eventOf(line)
      if (event === undefined) return []
      if (event.k === 'msg') {
        report = ''
        answeredBy = event.model
        return []
      }
      if (event.k === 'usage') {
        total.i += event.usage.i
        total.o += event.usage.o
        total.cr += event.usage.cr
        total.cw += event.usage.cw
        piError = event.error ?? ''
        return []
      }
      if (event.k === 'text') report += event.t
      return [push(event.k === 'thinking' ? 'thinking' : 'text', event.t)]
    }

    const process = $.process.spawn(request)
    const pieces = process[Symbol.asyncIterator]()
    let timer: Timer | undefined
    let stopped: 'limit' | 'abort' | undefined
    try {
      const until = new Promise<'limit' | 'abort'>((resolve) => {
        if (next.signal.aborted) resolve('abort')
        else next.signal.addEventListener('abort', () => resolve('abort'), { once: true })
        timer = $.clock.after(timeoutMinutes * 60_000, () => resolve('limit'))
      })
      for (;;) {
        const first = await Promise.race([
          pieces.next().then((piece) => ({ kind: 'piece' as const, piece })),
          until.then((why) => ({ kind: why })),
        ])
        if (first.kind !== 'piece') {
          stopped = first.kind
          break
        }
        if (first.piece.done) break
        const piece = first.piece.value
        if (piece.stream === 'stderr') {
          stderr += piece.text
          continue
        }
        buffer += piece.text
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) yield* take(line)
      }
      if (stopped === undefined) {
        yield* take(buffer)
        const exit = await process.result
        if (piError) failure = `pi's model call failed: ${piError}`
        else if (exit.code !== 0 || !report.trim()) {
          const why = stderr.replace(ANSI, '').trim() || '(no stderr)'
          failure = exit.code !== 0 ? `pi exited with ${exit.code ?? exit.signal}.\n${why}` : `pi ended with no answer.\n${why}`
        }
      }
    } catch (err) {
      failure = `pi could not run (is it installed and on PATH?): ${String(err)}`
    } finally {
      timer?.cancel()
    }

    if (stopped !== undefined) {
      try {
        await pieces.return?.(undefined as never)
      } catch {
        // pi was already gone; the limit or the interrupt ended it.
      }
      if (stopped === 'abort') return yield* respond(e, [{ kind: 'stop', stopReason: 'end_turn', usage: null }], '')
      const partial = report.trim()
      const notice = `pi ran past ${timeoutMinutes} minutes and was stopped.`
      report = partial ? `${partial}\n\n${notice}` : notice
      yield push('text', partial ? `\n\n${notice}` : notice)
    }

    if (failure) {
      report = failure
      answeredBy = ''
      yield push('text', `\n${failure}`)
    }
    const usage: TurnUsage | null = answeredBy
      ? {
          model: answeredBy,
          input_tokens: total.i,
          output_tokens: total.o,
          cache_read_input_tokens: total.cr,
          cache_creation_input_tokens: total.cw,
        }
      : null
    const answer = report.trim()
    const signedByPi = stopped === undefined && answeredBy !== ''
    const signed = signedByPi ? `${answer}\n\n— answered by pi, ${answeredBy}` : answer
    const rows = await $.session.messages({ agentId })
    const handback = Array.isArray(rows) && rows.some((m) => m.role === 'user' && m.text.includes(HANDBACK_TOOL))
    const line = `\n\n— answered by pi, ${answeredBy}`
    const tail: TurnStepChunk[] = signedByPi ? [push('text', line)] : []
    turn.report = signed
    if (handback) return yield* deliver(e, turn, index + 1, signed, usage, tail)
    return yield* respond(e, [...tail, { kind: 'stop', stopReason: 'end_turn', usage }], signed)
  })

  async function* deliver(
    e: { turnId: string; index: number },
    turn: Turn,
    block: number,
    report: string,
    usage: TurnUsage | null,
    before: TurnStepChunk[] = [],
  ) {
    turn.delivered = true
    const input = { message: report }
    const id = `toolu_pi_${e.turnId.replace(/[^A-Za-z0-9_]/g, '_')}`
    return yield* respond(
      e,
      [
        ...before,
        { kind: 'tool', index: block, id, name: HANDBACK_TOOL },
        { kind: 'input', index: block, json: JSON.stringify(input) },
        { kind: 'stop', stopReason: 'tool_use', usage },
      ],
      report,
      [{ name: HANDBACK_TOOL, input }],
    )
  }
}

function textChunks(text: string): TurnStepChunk[] {
  return [{ kind: 'text', index: 0, text }, { kind: 'stop', stopReason: 'end_turn', usage: null }]
}
