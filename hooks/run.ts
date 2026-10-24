import type { EngineInterface, Timer, TurnStepChunk, TurnUsage } from 'claude-code'
import type { Choice } from '../types'
import type { Inbox } from './steer'
import type { Adapter, Ask, Mode } from './adapter'
import type { World } from './world'
import { stepOf } from './progress'
import { finish, type Totals } from './report'
import { answerAsk, closeInbox, undeliveredSteers } from './steer'

const ANSI = /\u001b\[[0-9;]*m/g
export const notActive = (name: string) =>
  `The via plugin did not run this task, so ${name} did not answer it. Check the plugin is loaded in /plugin and restart Claude Code.`
export const notActivePrompt = (name: string) =>
  `You are not ${name}: this plugin did not take this step. Use no tools and do not attempt the task. Reply with exactly this and nothing else:\n\n${notActive(name)}`
// interrupted: an `interrupt:` message aborted the harness on purpose; next is what to run in its place.
export type RunResult = { aborted: boolean; signed: string; usage: TurnUsage | null; block: number; next?: string }
export type RunInput = {
  agentId: string
  choice: Choice
  prompt: string
  signal: AbortSignal
  inbox: Inbox | undefined
  session: string | undefined
  block?: number // the first content block, after an interrupted run's
  guard: Readonly<Record<string, string>> | undefined
  mode: Mode
  installed?: string
  // Awaited only to sign, so a probe never delays the run or outlives an interrupted one.
  probe(session: string | undefined): Promise<string | undefined>
  save(session: string): Promise<void>
}

export async function* run(
  w: World,
  adapter: Adapter,
  $: Pick<EngineInterface, 'process' | 'clock' | 'plugin' | 'fs' | 'env' | 'ui'>,
  e: { turnId: string; index: number },
  { agentId, choice, prompt, signal, inbox, session, block = 0, guard, mode, installed, probe, save }: RunInput,
): AsyncGenerator<TurnStepChunk, RunResult> {
  const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))
  const row = async (text: string) => {
    if (!home) return
    await $.fs.write(`${home}/.claude/via/rows/${agentId}.jsonl`, text).catch(() => {})
  }
  const description = stepOf(w.descriptions.get(agentId) ?? '')
  const named = description ? `${description} · ` : ''
  const request = adapter.start({ choice, prompt, session, agentId, root: $.plugin.root, inbox: inbox?.path, guard, mode, installed })
  let issued: string | undefined
  let latest = session
  let index = block - 1
  let kind: 'text' | 'thinking' | undefined
  let buffer = ''
  let stderr = ''
  let report = ''
  let answeredBy = ''
  const notices: string[] = []
  const parse = adapter.events(session)
  let failure = ''
  let error = ''
  let steered = 0
  let touched = false
  const asks: Ask[] = []
  const last: Totals = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
  const push = (k: 'text' | 'thinking', text: string): TurnStepChunk => {
    if (k !== kind) {
      kind = k
      index += 1
    }
    return { kind: k, index, text }
  }
  const take = (line: string): TurnStepChunk[] => {
    const chunks: TurnStepChunk[] = []
    for (const event of parse(line)) {
      switch (event.k) {
        case 'message':
          report = ''
          break
        case 'session':
          issued = event.id
          latest = event.id
          break
        case 'model':
          answeredBy = event.name
          break
        case 'usage':
          // Claude Code reads input + cache as the agent's context: report the last model call, never
          // the run's sum, which reads as a context past the window and gets compacted. Cost accuracy
          // is traded away for that.
          last.input = event.usage.input
          last.cacheRead = event.usage.cacheRead
          last.cacheWrite = event.usage.cacheWrite
          last.output = event.usage.output
          error = ''
          break
        case 'steered':
          steered += 1
          break
        case 'interrupted':
          // The harness ran the interrupt itself: nothing for the core to rerun or call undelivered.
          if (inbox) inbox.interrupt = undefined
          break
        case 'ask':
          asks.push(event.ask)
          break
        case 'notice':
          notices.push(event.t)
          break
        case 'error':
          error = event.message
          break
        case 'text':
          report += event.t
          chunks.push(push('text', event.t))
          break
        case 'thinking':
          chunks.push(push('thinking', event.t))
          break
        case 'tool': {
          chunks.push(push('text', event.t))
          const tools = (w.activity.get(agentId)?.tools ?? 0) + 1
          w.activity.set(agentId, { step: stepOf(event.t), tools })
          touched = true
          break
        }
        default: {
          const unreachable: never = event
          return unreachable
        }
      }
    }
    return chunks
  }
  await row('')
  const child = $.process.spawn(request)
  const pieces = child[Symbol.asyncIterator]()
  let timer: Timer | undefined
  let stopped: 'limit' | 'abort' | undefined
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
      // Asked without waiting: Esc, the time limit and an interrupt still reach the harness meanwhile.
      while (asks.length > 0) void answerAsk($, w.inboxes, agentId, inbox, asks.shift() as Ask, adapter.name)
      if (touched) {
        touched = false
        const activity = w.activity.get(agentId)
        if (activity !== undefined) {
          const content = `via:${adapter.name} · ${named}▸ ${activity.step} · ${activity.tools} ${activity.tools === 1 ? 'step' : 'steps'}`
          await row(`${JSON.stringify({ id: agentId, content })}\n`)
        }
      }
      if (issued !== undefined) {
        await save(issued)
        issued = undefined
      }
    }
    if (stopped === undefined) {
      yield* take(buffer)
      if (issued !== undefined) await save(issued)
      const exit = await child.result
      const known = adapter.failure?.(exit, stderr)
      if (known?.sessionLost) await save('')
      if (known !== undefined) failure = known.message
      else if (error) failure = `${adapter.name}'s model call failed: ${error}`
      else if (exit.code !== 0 || !report.trim()) {
        const why = stderr.replace(ANSI, '').trim() || '(no stderr)'
        failure = exit.code !== 0 ? `${adapter.name} exited with ${exit.code ?? exit.signal}.\n${why}` : `${adapter.name} ended with no answer.\n${why}`
      }
    } else {
      const tail = take(buffer)
      if (stopped === 'limit') yield* tail
      if (issued !== undefined) await save(issued)
    }
  } catch (err) {
    failure = `${adapter.name} could not run (is it installed and on PATH?): ${String(err)}`
  } finally {
    timer?.cancel()
    w.activity.delete(agentId)
    await row('')
    if (inbox) await closeInbox($, inbox, agentId, w.inboxes)
  }

  if (stopped !== undefined) {
    try {
      await pieces.return?.(undefined as never)
    } catch {
      // The harness was already gone; the limit or the interrupt ended it.
    }
    if (stopped === 'abort') return { aborted: true, signed: '', usage: null, block: index }
  }

  // The abort's own failure is not the answer: the interrupt's message runs next, after the steers it cut off.
  // A run that finished before the abort, or hit the time limit, keeps its answer; the interrupt is undelivered.
  if (inbox?.interrupt !== undefined && failure && stopped === undefined) {
    yield push('text', '\n▸ interrupted\n')
    return { aborted: false, signed: '', usage: null, block: index + 1, next: [...undeliveredSteers(inbox, steered), inbox.interrupt].join('\n\n') }
  }
  if (!answeredBy && !failure) answeredBy = (await probe(latest)) ?? ''
  const done = finish({ adapter, choice, notices, stopped, timeoutMinutes: w.timeoutMinutes, report, answeredBy, failure, steered, inbox, total: last, push })
  yield* done.chunks
  return { aborted: false, signed: done.signed, usage: done.usage, block: index + 1 }
}
