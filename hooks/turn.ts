import type { EngineInterface, StreamHook, TurnStepChunk, TurnStepResult } from 'claude-code'
import type { Choice } from '../types'
import { endJob, type Job, type Mark, pump } from './acp/steps'
import type { Adapter, Mode } from './adapter'
import { childRun } from './children'
import { deliver, HANDBACK_TOOL, handbackAsked, respond, textChunks } from './handback'
import { relayReady } from './install'
import { cachedModels } from './models'
import { helpOf, isModel, promptOf } from './prompt'
import { type AgentRecord, recordOf, updateRecord } from './record'
import { cutOff, type RunResult, run } from './run'
import { openInbox } from './steer'
import type { Turn, World } from './world'

function configOf(options: Readonly<Record<string, string>>): Readonly<Record<string, string>> | undefined {
  const kept = Object.entries(options).filter(([, value]) => value !== '')
  return kept.length > 0 ? Object.fromEntries(kept) : undefined
}

type StepHook = StreamHook<'turn.step'>
type Engine = Parameters<StepHook>[0]
type Step = Parameters<StepHook>[1]

export async function adapterOf(w: World, $: Engine, agentId: string): Promise<Adapter | undefined> {
  if (w.others.has(agentId)) return undefined
  const record = await recordOf(w, $, agentId)
  const known = record ? w.adapters.get(record.harness) : undefined
  if (known) return known
  const agent = (await $.agent.list()).find((a) => a.id === agentId)
  if (agent === undefined) return undefined
  const [plugin, name = ''] = agent.type.split(':')
  const adapter = plugin === $.plugin.name ? w.adapters.get(name) : undefined
  if (adapter) w.records.set(agentId, { harness: adapter.name, handback: false, mode: 'plan', rebuilt: true })
  else w.others.add(agentId)
  return adapter
}

async function handbackOf($: Engine, agentId: string, record: AgentRecord): Promise<boolean> {
  return record.handback || (await handbackAsked($, agentId))
}

async function foundAbove(
  $: Engine,
  folder: string,
  harmless: readonly string[],
  skip?: string,
): Promise<string | 'unchecked' | undefined> {
  let prefix = ''
  for (let depth = 0; depth < 64; depth += 1) {
    const found = await $.fs.stat(`${prefix}${folder}`, { resolve: true }).catch(() => undefined)
    const hit = found !== undefined && skip !== undefined && found.realPath === skip ? undefined : found
    if (hit !== undefined && hit.kind !== 'dir') return hit.realPath ?? `${prefix}${folder}`
    if (hit?.kind === 'dir') {
      const entries = await $.fs.list(`${prefix}${folder}`).catch(() => undefined)
      if (entries === undefined || entries.some((entry) => !harmless.includes(entry.name))) return hit.realPath ?? `${prefix}${folder}`
    }
    const here = await $.fs.stat(prefix || '.', { resolve: true }).catch(() => undefined)
    const up = await $.fs.stat(`${prefix}..`, { resolve: true }).catch(() => undefined)
    if (!here?.realPath || !up?.realPath) return 'unchecked'
    if (here.realPath === up.realPath) return undefined
    prefix += '../'
  }
  return 'unchecked'
}

async function readOnlyGuard($: Engine, adapter: Adapter): Promise<Readonly<Record<string, string>> | string | undefined> {
  const guard = adapter.readOnlyGuard
  if (!guard) return undefined
  const listed = await $.process.run(guard.argv, { timeoutMs: 15_000 }).catch(() => undefined)
  return (listed?.exitCode === 0 ? guard.env(listed.stdout) : undefined) ?? guard.why
}

async function* replay(
  w: World,
  $: Engine,
  e: Step,
  agentId: string,
  adapter: Adapter,
  record: AgentRecord,
  force = false,
): AsyncGenerator<TurnStepChunk, TurnStepResult> {
  const said = record.report || cutOff(adapter.name)
  if (!record.handedBack && (force || (await handbackOf($, agentId, record).catch(() => record.handback)))) {
    await updateRecord(w, $, agentId, { handedBack: true })
    return yield* deliver(adapter.name, e, 0, said, null)
  }
  return yield* respond(e, textChunks(said), said)
}

async function* nestedStep(
  w: World,
  $: Engine,
  e: Step,
  agentId: string,
  adapter: Adapter,
  record: AgentRecord,
  signal: AbortSignal,
): AsyncGenerator<TurnStepChunk, TurnStepResult> {
  let job = w.jobs.get(agentId)
  if (job === undefined) {
    if (record.report !== undefined) return yield* replay(w, $, e, agentId, adapter, record)
    const abort = new AbortController()
    const handback = await handbackOf($, agentId, record)
    job = {
      turnId: e.turnId,
      gen: childRun(w, agentId, adapter.name, e, abort.signal, handback, (key) => $.viaChildren.wait({ key })),
      held: [],
      outputs: new Map(),
      abort,
      count: 0,
    }
    w.jobs.set(agentId, job)
  }
  const result = yield* pump(w, job, e, signal, joining($, agentId, job.turnId))
  if (job.final?.answer) {
    const handedBack = job.final.toolUses.some((use) => use.name === HANDBACK_TOOL)
    await updateRecord(w, $, agentId, { report: job.final.answer, handedBack })
  }
  return result
}

function joining($: Engine, agentId: string, turnId: string): () => Promise<void> {
  return () => $.viaSteps.wait({ agentId, turnId })
}

export async function* turnStep(w: World, $: Engine, e: Step, next: Parameters<StepHook>[2]) {
  const agentId = e.agentId
  if (agentId === undefined) return yield* next(e)
  const adapter = await adapterOf(w, $, agentId)
  const record = w.records.get(agentId)
  if (adapter === undefined || record === undefined) return yield* next(e)
  if (record.nested) {
    if (!w.nested.has(agentId)) return yield* replay(w, $, e, agentId, adapter, record)
    return yield* nestedStep(w, $, e, agentId, adapter, record, next.signal)
  }
  const turn = w.turns.get(e.turnId)
  if (turn?.wake) return yield* respond(e, textChunks(record.report ?? ''), record.report ?? '')
  const job = w.jobs.get(agentId)
  if (job !== undefined) {
    if (job.turnId === e.turnId) return yield* pump(w, job, e, next.signal, joining($, agentId, e.turnId))
    endJob(w, agentId)
  }
  if (turn === undefined) return yield* replay(w, $, e, agentId, adapter, record)
  if (turn.done) return yield* replay(w, $, e, agentId, adapter, record, true)
  const started = yield* begin(w, adapter, $, e, agentId, record, turn)
  if ('answer' in started) return started
  w.jobs.set(agentId, started)
  return yield* pump(w, started, e, next.signal, joining($, agentId, e.turnId))
}

async function* begin(
  w: World,
  adapter: Adapter,
  $: Engine,
  e: Step,
  agentId: string,
  record: AgentRecord,
  turn: Turn,
): AsyncGenerator<TurnStepChunk, TurnStepResult | Job> {
  const say = async function* (text: string): AsyncGenerator<TurnStepChunk, TurnStepResult> {
    const handback = await handbackOf($, agentId, record).catch(() => record.handback)
    turn.done = true
    await updateRecord(w, $, agentId, { report: text, handedBack: handback })
    if (handback) return yield* deliver(adapter.name, e, 0, text, null)
    return yield* respond(e, textChunks(text), text)
  }
  const defaultModel = adapter.defaultModel ? w.defaultModel : ''
  if (defaultModel && !isModel(defaultModel)) {
    const bad = `The via plugin's defaultModel setting ${JSON.stringify(defaultModel)} is not a ${adapter.name} --model pattern.`
    return yield* say(bad)
  }
  const asked = promptOf(turn.prompt, adapter)
  if (asked.help) {
    const help = helpOf(adapter, await cachedModels($, adapter, w.defaultModel))
    return yield* say(help)
  }
  if (asked.error !== undefined) {
    const bad = `${asked.error}\n\n${helpOf(adapter, await cachedModels($, adapter, w.defaultModel))}`
    return yield* say(bad)
  }

  const held = record.choice
  const merged: Choice = {
    ...held,
    ...(asked.model ? { model: asked.model } : {}),
    ...(asked.tools ? { tools: asked.tools } : {}),
    ...(asked.thinking ? { thinking: asked.thinking } : {}),
    ...(asked.config ? { config: configOf({ ...held?.config, ...asked.config }) } : {}),
  }
  const changed =
    merged.model !== held?.model ||
    merged.tools !== held?.tools ||
    merged.thinking !== held?.thinking ||
    JSON.stringify(merged.config) !== JSON.stringify(held?.config)
  const mode = record.mode as Mode
  if (merged.config && (mode === 'plan' || merged.tools === 'read' || record.rebuilt)) {
    const refused = `A read-only ${adapter.name} run takes no config lines: an option could loosen what read-only enforces. Start a new agent without \`tools: read\`, outside plan mode, to use them.`
    return yield* say(refused)
  }
  if (changed) await updateRecord(w, $, agentId, { choice: merged })

  const withModel: Choice = merged.model ? merged : { ...merged, ...(defaultModel ? { model: defaultModel } : {}) }
  const anyway = record.rebuilt
    ? `via has no record of the permission mode this agent was spawned with, so it runs read-only. Start a new agent to run it with your current mode.`
    : 'To run it anyway, start a new agent without `tools: read`, outside plan mode; or ask a harness that can enforce read-only.'
  if (mode === 'plan' && adapter.readOnly === 'none') {
    const refused = record.rebuilt
      ? `${adapter.name} cannot run read-only: it has no read-only mode that via can enforce. ${anyway}`
      : `${adapter.name} cannot run in plan mode: it has no read-only mode that via can enforce. Leave plan mode to run it, or ask a harness that can enforce read-only.`
    return yield* say(refused)
  }
  const chosen: Choice = mode === 'plan' ? { ...withModel, tools: adapter.tools?.[0] ?? 'read,grep,find,ls' } : withModel
  const unsafe = chosen.tools === 'read' ? adapter.unsafeReadOnly : undefined
  const ownHome = unsafe?.own ? (await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) : undefined
  const own = ownHome ? (await $.fs.stat(`${ownHome}/${unsafe?.folder}`, { resolve: true }).catch(() => undefined))?.realPath : undefined
  const found = unsafe ? await foundAbove($, unsafe.folder, unsafe.harmless, own) : undefined
  if (unsafe && found) {
    const refused =
      found === 'unchecked'
        ? `${adapter.name} cannot run read-only here: this folder and those above it could not all be checked for ${unsafe.folder}, and ${unsafe.why}. ${anyway}`
        : `${adapter.name} cannot run read-only here: ${unsafe.why} (${found}). ${anyway}`
    return yield* say(refused)
  }
  const guard = chosen.tools === 'read' ? await readOnlyGuard($, adapter) : undefined
  if (typeof guard === 'string') {
    const refused = `${adapter.name} cannot run read-only here: ${guard}. ${anyway}`
    return yield* say(refused)
  }
  const ready = await relayReady(w, $, adapter, w.latest.has(adapter.name))
  if (typeof ready === 'string') return yield* say(ready)
  await updateRecord(w, $, agentId, { report: '', handedBack: false })
  const abort = new AbortController()
  return {
    turnId: e.turnId,
    abort,
    held: [],
    outputs: new Map(),
    count: 0,
    gen: drive(w, $, {
      adapter,
      e,
      turn,
      agentId,
      record,
      prompt: asked.prompt,
      chosen,
      mode,
      installed: ready.installed,
      guard,
      signal: abort.signal,
    }),
  }
}

type Drive = {
  adapter: Adapter
  e: { turnId: string; index: number }
  turn: Turn
  agentId: string
  record: AgentRecord
  prompt: string
  chosen: Choice
  mode: Mode
  installed: string | undefined
  guard: Readonly<Record<string, string>> | undefined
  signal: AbortSignal
}

async function holdUntil(w: World, $: EngineInterface, agentId: string): Promise<void> {
  const now = await Promise.resolve()
    .then(() => $.clock.now())
    .catch(() => undefined)
  if (now !== undefined) await updateRecord(w, $, agentId, { runningUntil: now + (w.timeoutMinutes + 1) * 60_000 })
}

async function* drive(w: World, $: EngineInterface, d: Drive): AsyncGenerator<TurnStepChunk | Mark, TurnStepResult> {
  await holdUntil(w, $, d.agentId)
  try {
    return yield* driveRun(w, $, d)
  } finally {
    await updateRecord(w, $, d.agentId, { runningUntil: undefined }).catch(() => undefined)
  }
}

async function* driveRun(w: World, $: EngineInterface, d: Drive): AsyncGenerator<TurnStepChunk | Mark, TurnStepResult> {
  const { adapter, e, turn, agentId, record, chosen, mode, installed, guard, signal } = d
  let prompt = d.prompt
  let block = 0
  let result: RunResult
  const models = chosen.model ? await cachedModels($, adapter, w.defaultModel) : []
  for (;;) {
    const session = record.session
    const inbox = adapter.steer ? await openInbox($, adapter.name, agentId, w.inboxes) : undefined
    result = yield* run(w, adapter, $, {
      agentId,
      choice: chosen,
      prompt,
      signal,
      inbox,
      session,
      mode,
      installed,
      models,
      block,
      guard,
      save: async (id) => {
        if (id !== session) await updateRecord(w, $, agentId, { session: id })
      },
    })
    if (result.next === undefined) break
    if (signal.aborted) return yield* respond(e, [{ kind: 'stop', stopReason: 'end_turn', usage: null }], '')
    prompt = result.next
    block = result.block
    await holdUntil(w, $, agentId)
  }
  if (result.aborted) return yield* respond(e, [{ kind: 'stop', stopReason: 'end_turn', usage: null }], '')
  const handback = await handbackOf($, agentId, record).catch(() => record.handback)
  turn.done = true
  await updateRecord(w, $, agentId, { report: result.signed, handedBack: handback })
  if (handback) return yield* deliver(adapter.name, e, result.block, result.signed, result.usage)
  return yield* respond(e, [{ kind: 'stop', stopReason: 'end_turn', usage: result.usage }], result.signed)
}
