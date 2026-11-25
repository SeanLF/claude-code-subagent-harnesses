import type { Timer, TurnStepChunk, TurnStepResult, TurnUsage } from 'claude-code'
import type { Question } from './norm'
import { NO_OUTPUT } from './render'

export type Mark =
  | { kind: 'call-start'; id: string; input: CallInput; usage: TurnUsage | null }
  | { kind: 'call-end'; id: string; output: string; failed: boolean }
  | { kind: 'question-closed'; id: string }
  | { kind: 'spawn'; child: string; type: string; title: string; prompt?: string }
  | { kind: 'send'; to: string; summary: string; message: string; question?: string }
export type Send = Extract<Mark, { kind: 'send' }>
export type CallInput = { kind: string; title: string; path?: string; question?: Question }

export type Job = {
  turnId: string
  gen: AsyncGenerator<TurnStepChunk | Mark, TurnStepResult>
  held: (TurnStepChunk | Mark)[]
  outputs: Map<string, { output: string; failed: boolean }>
  final?: TurnStepResult
  abort: AbortController
  count: number
  reading?: Promise<IteratorResult<TurnStepChunk | Mark, TurnStepResult>>
}

type Line = { id: string; send: Send; sent?: true }
export type Steps<Handed extends Line = Line> = {
  tool: string
  spawns: Map<string, string>
  jobs: Map<string, Job>
  calls: Map<string, { agentId: string; id: string; input?: CallInput; question?: true }>
  handed: Map<string, Handed[]>
}

export function dropHanded(w: Pick<Steps, 'handed'>, job: Job | undefined, agentId: string, id: string): void {
  const line = w.handed.get(agentId)
  const at = line?.findIndex((h) => h.id === id) ?? -1
  if (line === undefined || at < 0) return
  line.splice(at, 1)
  const [next] = line
  if (next === undefined) w.handed.delete(agentId)
  else if (at === 0) job?.held.push(next.send)
}

export const CHILD_CALL = 'toolu_via_child_'
export const STEP_CALL = 'toolu_step_'
export const SEND_CALL = 'toolu_via_send_'

function ended(turnId: string): TurnStepResult {
  return { turnId, index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
}

function halted(job: Job): boolean {
  if (!job.abort.signal.aborted) return false
  job.final ??= ended(job.turnId)
  void job.gen.return(undefined as never).catch(() => {})
  return true
}

const NOT_FOLLOWED = 'The harness run could not be followed: its producer or its wait failed.'

function read(job: Job): Promise<IteratorResult<TurnStepChunk | Mark, TurnStepResult>> {
  job.reading ??= job.gen.next().catch((error: unknown) => {
    job.reading = undefined
    throw error
  })
  return job.reading
}

export async function waitStep(w: Steps, agentId: string, turnId: string, after: (wake: () => void) => Timer): Promise<void> {
  const job = w.jobs.get(agentId)
  if (job === undefined || job.turnId !== turnId || job.final !== undefined || job.abort.signal.aborted) return
  let timer: Timer | undefined
  try {
    await Promise.race([
      read(job).then(
        () => undefined,
        () => undefined,
      ),
      new Promise<void>((resolve) => {
        timer = after(resolve)
      }),
    ])
  } finally {
    timer?.cancel()
  }
}

export function endJob(w: Steps, agentId: string): void {
  const job = w.jobs.get(agentId)
  if (job === undefined) return
  w.jobs.delete(agentId)
  w.handed.delete(agentId)
  for (const [id, call] of w.calls) if (call.agentId === agentId) w.calls.delete(id)
  job.abort.abort()
  void job.gen.return(undefined as never).catch(() => {})
}

function lend(job: Job, signal: AbortSignal): () => void {
  const forward = () => job.abort.abort()
  if (signal.aborted) forward()
  signal.addEventListener('abort', forward, { once: true })
  return () => signal.removeEventListener('abort', forward)
}

export async function* pump(
  w: Steps,
  job: Job,
  e: { turnId: string; index: number; agentId?: string },
  signal: AbortSignal,
  wait: () => Promise<void>,
): AsyncGenerator<TurnStepChunk, TurnStepResult> {
  const unlend = lend(job, signal)
  const blocks = new Map<number, number>()
  const block = (index: number) => {
    if (!blocks.has(index)) blocks.set(index, blocks.size)
    return blocks.get(index) as number
  }
  try {
    for (;;) {
      let c: TurnStepChunk | Mark
      const heldChunk = job.held.shift()
      if (heldChunk !== undefined) c = heldChunk
      else if (job.final !== undefined) {
        if (w.jobs.get(e.agentId ?? '') === job) {
          w.jobs.delete(e.agentId ?? '')
          w.handed.delete(e.agentId ?? '')
        }
        return { ...job.final, turnId: e.turnId, index: e.index }
      } else if (halted(job)) continue
      else {
        const arrived = await Promise.race([
          read(job).then(
            () => true,
            () => undefined,
          ),
          wait().then(
            () => false,
            () => undefined,
          ),
        ])
        if (arrived === undefined) {
          job.abort.abort()
          job.final ??= { ...ended(job.turnId), answer: NOT_FOLLOWED }
          void job.gen.return(undefined as never).catch(() => {})
          yield { kind: 'text', index: block(-2), text: NOT_FOLLOWED }
          continue
        }
        if (!arrived) continue
        const r = await read(job)
        job.reading = undefined
        if (r.done) {
          job.final = r.value ?? ended(e.turnId)
          continue
        }
        c = r.value
      }
      if (c.kind === 'call-end') {
        job.outputs.set(c.id, { output: c.output, failed: c.failed })
        continue
      }
      if (c.kind === 'question-closed') {
        dropHanded(w, job, e.agentId ?? '', c.id)
        continue
      }
      if (c.kind === 'send') {
        const head = c.question === undefined ? undefined : w.handed.get(e.agentId ?? '')?.[0]
        if (c.question !== undefined && head?.id !== c.question) continue
        if (head !== undefined) head.sent = true
        job.count += 1
        const id = `${SEND_CALL}${e.turnId.replace(/[^A-Za-z0-9_]/g, '_')}_${job.count}`
        const input = { to: c.to, summary: c.summary, message: c.message }
        const index = block(-1 - job.count)
        yield { kind: 'tool', index, id, name: 'SendMessage' }
        yield { kind: 'input', index, json: JSON.stringify(input) }
        yield { kind: 'stop', stopReason: 'tool_use', usage: null }
        return {
          turnId: e.turnId,
          index: e.index,
          answer: '',
          toolUses: [{ name: 'SendMessage', input }],
          stopReason: 'tool_use',
          usage: null,
        }
      }
      if (c.kind === 'spawn') {
        job.count += 1
        const id = `${CHILD_CALL}${e.turnId.replace(/[^A-Za-z0-9_]/g, '_')}_${job.count}`
        w.spawns.set(id, c.child)
        const input = { description: c.title, prompt: c.prompt || c.title, subagent_type: c.type, run_in_background: true }
        const index = block(-1 - job.count)
        yield { kind: 'tool', index, id, name: 'Agent' }
        yield { kind: 'input', index, json: JSON.stringify(input) }
        yield { kind: 'stop', stopReason: 'tool_use', usage: null }
        return { turnId: e.turnId, index: e.index, answer: '', toolUses: [{ name: 'Agent', input }], stopReason: 'tool_use', usage: null }
      }
      if (c.kind === 'call-start') {
        job.count += 1
        const id = `${STEP_CALL}${e.turnId.replace(/[^A-Za-z0-9_]/g, '_')}_${job.count}`
        w.calls.set(id, { agentId: e.agentId ?? '', id: c.id, input: c.input, ...(c.input.question ? { question: true as const } : {}) })
        const index = block(-1 - job.count)
        yield { kind: 'tool', index, id, name: w.tool }
        yield { kind: 'input', index, json: JSON.stringify(c.input) }
        yield { kind: 'stop', stopReason: 'tool_use', usage: c.usage }
        return {
          turnId: e.turnId,
          index: e.index,
          answer: '',
          toolUses: [{ name: w.tool, input: c.input }],
          stopReason: 'tool_use',
          usage: c.usage,
        }
      }
      yield 'index' in c ? { ...c, index: block(c.index) } : c
    }
  } finally {
    unlend()
  }
}

export async function questionClosed(w: Pick<Steps, 'jobs'>, ref: { agentId: string; id: string }, stop: AbortSignal): Promise<boolean> {
  const job = w.jobs.get(ref.agentId)
  if (job === undefined) return true
  const stopped = new Promise<'stopped'>((resolve) => {
    if (stop.aborted) resolve('stopped')
    stop.addEventListener('abort', () => resolve('stopped'), { once: true })
  })
  for (;;) {
    if (job.final !== undefined || halted(job)) return true
    const r = await Promise.race([read(job).catch(() => 'failed' as const), stopped])
    if (r === 'stopped') return false
    if (r === 'failed') {
      job.abort.abort()
      job.final ??= { ...ended(job.turnId), answer: NOT_FOLLOWED }
      return true
    }
    job.reading = undefined
    if (r.done) {
      job.final = r.value ?? ended(job.turnId)
      return true
    }
    if (r.value.kind === 'question-closed' && r.value.id === ref.id) return true
    if (r.value.kind === 'call-end') job.outputs.set(r.value.id, { output: r.value.output, failed: r.value.failed })
    else job.held.push(r.value)
  }
}

export const CALL_HOLD_MS = 15 * 60_000

export async function answerCall(
  w: Steps,
  toolUseId: string | undefined,
  signal: AbortSignal,
  wait: (agentId: string, turnId: string) => Promise<void>,
  now: () => number = Date.now,
): Promise<{ result: string; isError?: true } | { deny: string }> {
  const ref = toolUseId === undefined ? undefined : w.calls.get(toolUseId)
  const job = ref === undefined ? undefined : w.jobs.get(ref.agentId)
  if (ref === undefined || job === undefined)
    return { deny: 'This tool only reports a tool call an agent harness made; it does nothing when called.' }
  const unlend = lend(job, signal)
  const until = now() + CALL_HOLD_MS
  const input = ref.input ?? { kind: 'other', title: 'harness tool' }
  const waiting: Mark = {
    kind: 'call-start',
    id: ref.id,
    input: input.kind === 'wait' ? input : { kind: 'wait', title: `Waiting for ${input.title}` },
    usage: null,
  }
  try {
    for (;;) {
      const done = job.outputs.get(ref.id)
      if (done !== undefined) {
        w.calls.delete(toolUseId as string)
        return done.failed ? { result: done.output || 'failed', isError: true } : { result: done.output || NO_OUTPUT }
      }
      if (job.final !== undefined || halted(job)) return { result: 'The harness run ended before this call finished.' }
      if (now() >= until) {
        job.held.unshift(waiting)
        w.calls.delete(toolUseId as string)
        return { result: `The harness tool is still running after ${CALL_HOLD_MS / 60_000} minutes; waiting on in the next step.` }
      }
      const arrived = await Promise.race([
        read(job).then(
          () => true,
          () => undefined,
        ),
        wait(ref.agentId, job.turnId).then(
          () => false,
          () => undefined,
        ),
      ])
      if (arrived === undefined) {
        job.abort.abort()
        job.final ??= { ...ended(job.turnId), answer: NOT_FOLLOWED }
        void job.gen.return(undefined as never).catch(() => {})
        return { result: NOT_FOLLOWED }
      }
      if (!arrived) continue
      const r = await read(job)
      job.reading = undefined
      if (r.done) {
        job.final = r.value ?? ended(job.turnId)
        continue
      }
      if (r.value.kind === 'call-end') job.outputs.set(r.value.id, { output: r.value.output, failed: r.value.failed })
      else if (r.value.kind === 'spawn') {
        job.held.unshift(r.value, waiting)
        w.calls.delete(toolUseId as string)
        return { result: 'The harness tool is still running; showing its subagent now.' }
      } else job.held.push(r.value)
    }
  } finally {
    unlend()
  }
}
