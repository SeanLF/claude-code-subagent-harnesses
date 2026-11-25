import type { EngineInterface, ProcessSpawnRequest, Timer, TurnStepChunk, TurnUsage } from 'claude-code'
import type { Choice } from '../types'
import type { Norm } from './acp/norm'
import type { Mark } from './acp/steps'
import type { Adapter, Ask, Mode } from './adapter'
import { closeChildren, route } from './children'
import { nearestModels } from './prompt'
import { finish, type Totals } from './report'
import type { Inbox } from './steer'
import { answerAsk, closeInbox, undeliveredSteers } from './steer'
import type { World } from './world'
import { StepWriter } from './writer'

const ANSI = /\u001b\[[0-9;]*m/g
const MISSING_MODEL = /refused model|model.*not found|not found.*model|unknown model|invalid model|no such model|model.*does not exist/i
export const notActive = (name: string) =>
  `The via plugin did not run this task, so ${name} did not answer it. Check the plugin is loaded in /plugin and restart Claude Code.`
export const cutOff = (name: string) =>
  `This ${name} run was cut off before it answered, as happens when the session is sent to the background. Send the task again to run it.`
export const notActivePrompt = (name: string) =>
  `You are not ${name}: this plugin did not take this step. Use no tools and do not attempt the task. Reply with exactly this and nothing else:\n\n${notActive(name)}`
export type RunResult = { aborted: boolean; signed: string; usage: TurnUsage | null; block: number; next?: string }
export type RunInput = {
  agentId: string
  choice: Choice
  prompt: string
  signal: AbortSignal
  inbox: Inbox | undefined
  session: string | undefined
  block?: number
  guard: Readonly<Record<string, string>> | undefined
  mode: Mode
  installed?: string
  models?: readonly string[]
  save(session: string): Promise<void>
}

type RunState = {
  readonly writer: StepWriter
  issued?: string
  latest: string | undefined
  answeredBy: string
  readonly notices: string[]
  error: string
  steered: number
  readonly compacting: Set<string>
  compacted: boolean
  readonly asks: Ask[]
  readonly open: Map<string, string>
  readonly last: Totals
}
type Context = { readonly w: World; readonly agentId: string; readonly adapter: Adapter; readonly type: string; readonly inbox?: Inbox }

const usageOf = (s: RunState, adapter: Adapter): TurnUsage => ({
  model: s.answeredBy || adapter.name,
  input_tokens: s.last.input,
  output_tokens: s.last.output,
  cache_read_input_tokens: s.last.cacheRead,
  cache_creation_input_tokens: s.last.cacheWrite,
})

function closeOpen(s: RunState, why: string): Mark[] {
  const marks = [...s.open.keys()].map((id): Mark => ({ kind: 'call-end', id, output: why, failed: true }))
  s.open.clear()
  return marks
}

function take(s: RunState, c: Context, event: Norm): (TurnStepChunk | Mark)[] {
  switch (event.k) {
    case 'message':
      s.writer.message()
      return []
    case 'session':
      s.issued = event.id
      s.latest = event.id
      return []
    case 'model':
      s.answeredBy = event.name
      return []
    case 'usage':
      Object.assign(s.last, event.usage)
      s.error = ''
      return []
    case 'steered':
      s.steered += 1
      return []
    case 'interrupted':
      if (c.inbox) c.inbox.interrupt = undefined
      return closeOpen(s, 'interrupted')
    case 'ask':
      s.asks.push(event.ask)
      return []
    case 'question-closed':
      return [{ kind: 'question-closed', id: event.id }]
    case 'question':
      return [
        s.writer.call(
          event.question.id,
          { kind: 'question', title: event.question.message, question: event.question },
          usageOf(s, c.adapter),
        ),
      ]
    case 'notice':
      s.notices.push(event.t)
      return []
    case 'error':
      s.error = `${c.adapter.name}'s model call failed: ${event.message}`
      return []
    case 'unfinished':
      s.error = `${c.adapter.name} did not finish: ${event.why}.`
      return []
    case 'text':
      return [s.writer.text(event.t)]
    case 'thinking':
      return [s.writer.thinking(event.t)]
    case 'call': {
      s.open.set(event.id, event.title)
      if (event.kind === 'compact') s.compacting.add(event.id)
      const input = { kind: event.kind, title: event.title, ...(event.path ? { path: event.path } : {}) }
      return [s.writer.call(event.id, input, usageOf(s, c.adapter))]
    }
    case 'plan':
      return s.writer.plan(event.entries, usageOf(s, c.adapter))
    case 'called':
      if (!s.open.delete(event.id)) return []
      if (s.compacting.has(event.id) && !event.failed) s.compacted = true
      return [{ kind: 'call-end', id: event.id, output: event.output, failed: event.failed }]
    case 'child':
    case 'of': {
      const marks = route(c.w, c.agentId, c.type, event)
      if (marks.length > 0) s.writer.boundary()
      return marks
    }
    case 'told':
      return s.writer.told(event.t)
    case 'tool':
      return [s.writer.say(event.t)]
    default: {
      const unreachable: never = event
      return unreachable
    }
  }
}

async function relayed(
  $: Pick<EngineInterface, 'clock' | 'env' | 'plugin'>,
  w: Pick<World, 'records'>,
  agentId: string,
  request: ProcessSpawnRequest,
): Promise<ProcessSpawnRequest> {
  if (request.argv[1] !== `${$.plugin.root}/relay/relay.mjs`) return request
  const title = w.records.get(agentId)?.description
  const home = (await $.env.get('VIA_TRACE')) === '1' ? (await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) : undefined
  return {
    ...request,
    env: {
      ...request.env,
      ...(title ? { RELAY_TITLE: title } : {}),
      ...(home ? { RELAY_TRACE: `${home}/.claude/via/traces/${agentId}-${await $.clock.now()}.jsonl` } : {}),
    },
  }
}

export async function* run(
  w: World,
  adapter: Adapter,
  $: Pick<EngineInterface, 'process' | 'clock' | 'plugin' | 'fs' | 'env' | 'ui'>,
  { agentId, choice, prompt, signal, inbox, session, block = 0, guard, mode, installed, models = [], save }: RunInput,
): AsyncGenerator<TurnStepChunk | Mark, RunResult> {
  const request = adapter.start({
    choice,
    prompt,
    session,
    agentId,
    root: $.plugin.root,
    inbox: inbox?.path,
    files: inbox?.files,
    guard,
    mode,
    installed,
  })
  const s: RunState = {
    writer: new StepWriter(block),
    latest: session,
    answeredBy: '',
    notices: [],
    error: '',
    steered: 0,
    compacting: new Set(),
    compacted: false,
    asks: [],
    open: new Map(),
    last: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
  }
  const c: Context = { w, agentId, adapter, type: `${$.plugin.name}:${adapter.name}`, ...(inbox ? { inbox } : {}) }
  const parse = adapter.events(session)
  const takeLine = (line: string) => parse(line).flatMap((event) => take(s, c, event))
  let buffer = ''
  let stderr = ''
  let failure = ''
  const child = $.process.spawn(await relayed($, w, agentId, request))
  const pieces = child[Symbol.asyncIterator]()
  let timer: Timer | undefined
  let stopped: 'limit' | 'abort' | undefined
  let exited = false
  try {
    const until = new Promise<'limit' | 'abort'>((resolve) => {
      if (signal.aborted) resolve('abort')
      else signal.addEventListener('abort', () => resolve('abort'), { once: true })
      timer = $.clock.after(w.timeoutMinutes * 60_000, () => resolve('limit'))
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
      if (first.piece.done) {
        exited = true
        break
      }
      const piece = first.piece.value
      if (piece.stream === 'stderr') {
        stderr += piece.text
        continue
      }
      buffer += piece.text
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) yield* takeLine(line)
      while (s.asks.length > 0) void answerAsk($, w.inboxes, agentId, inbox, s.asks.shift() as Ask, adapter.name)
      if (s.issued !== undefined) {
        await save(s.issued)
        s.issued = undefined
      }
    }
    if (stopped === undefined) {
      yield* takeLine(buffer)
      if (s.issued !== undefined) await save(s.issued)
      const exit = await child.result
      const known = adapter.failure?.(exit, stderr)
      if (known?.sessionLost) await save('')
      if (
        exit.code === 0 &&
        !s.writer.report.trim() &&
        s.compacted &&
        /^\/compact\b/.test(prompt.trim()) &&
        known === undefined &&
        !s.error
      )
        s.writer.report = 'Compacted the conversation.'
      if (known !== undefined) failure = known.message
      else if (s.error) failure = s.error
      else if (exit.code !== 0 || !s.writer.report.trim()) {
        const why = stderr.replace(ANSI, '').trim() || '(no stderr)'
        failure =
          exit.code !== 0
            ? `${adapter.name} exited with ${exit.code ?? exit.signal}.\n${why}`
            : `${adapter.name} ended with no answer.\n${why}`
      }
      const refused =
        choice.model &&
        !models.includes(choice.model) &&
        failure.toLowerCase().includes(choice.model.toLowerCase()) &&
        MISSING_MODEL.test(failure)
      const near = refused && choice.model ? nearestModels(choice.model, models) : []
      if (near.length > 0) failure += `\nDid you mean ${near.join(', ')}?`
    } else {
      const tail = takeLine(buffer)
      if (stopped === 'limit') yield* tail
      if (s.issued !== undefined) await save(s.issued)
    }
  } catch (err) {
    failure = `${adapter.name} could not run (is it installed and on PATH?): ${String(err)}`
  } finally {
    if (!exited) void Promise.resolve(pieces.return?.(undefined as never)).catch(() => {})
    timer?.cancel()
    closeChildren(w, agentId, stopped === undefined ? undefined : 'the harness run was stopped')
    if (inbox) await closeInbox($, inbox, agentId, w.inboxes)
  }
  const left = [...s.open].filter(([id]) => !s.compacting.has(id)).map(([, title]) => `\`${title}\``)
  if (stopped === undefined && !failure && left.length > 0)
    s.notices.push(
      `${adapter.name} ended its turn before ${left.join(', ')} finished, so ${left.length > 1 ? 'their results are' : 'its result is'} not in this answer.`,
    )
  yield* closeOpen(
    s,
    stopped === 'limit'
      ? `stopped at the ${w.timeoutMinutes}-minute limit`
      : stopped === 'abort'
        ? 'interrupted'
        : 'the run ended before this call finished',
  )

  if (stopped === 'abort') return { aborted: true, signed: '', usage: null, block: s.writer.index }

  if (inbox?.interrupt !== undefined && failure && stopped === undefined) {
    yield s.writer.say('\n▸ interrupted\n')
    return {
      aborted: false,
      signed: '',
      usage: null,
      block: s.writer.index + 1,
      next: [...undeliveredSteers(inbox, s.steered), inbox.interrupt].join('\n\n'),
    }
  }
  const done = finish({
    adapter,
    choice,
    notices: s.notices,
    stopped,
    timeoutMinutes: w.timeoutMinutes,
    report: s.writer.report,
    answeredBy: s.answeredBy,
    failure,
    steered: s.steered,
    inbox,
    total: s.last,
    writer: s.writer,
  })
  yield* done.chunks
  return { aborted: false, signed: done.signed, usage: done.usage, block: s.writer.index + 1 }
}
