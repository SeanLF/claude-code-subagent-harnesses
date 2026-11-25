import type { EngineInterface } from 'claude-code'
import type { Choice } from '../types'

export type AgentRecord = {
  harness: string
  nested?: true
  handback: boolean
  mode: string
  description?: string
  choice?: Choice
  session?: string
  cwd?: string
  runningUntil?: number
  report?: string
  handedBack?: boolean
  rebuilt?: true
}

export type Records = {
  records: Map<string, AgentRecord>
  writing?: Promise<void>
  unsaved?: true
  cleared?: true
}

const INDEX = 'agent-ids'
const KEPT = 50
const REPORT_KEPT = 16_000
const keyOf = (agentId: string) => `agent:${agentId}`
type Store = Pick<EngineInterface, 'store' | 'ui'>

const isRecord = (value: unknown): value is AgentRecord =>
  typeof value === 'object' && value !== null && typeof (value as AgentRecord).harness === 'string'

function unsaved(w: Records, $: Store, error: unknown): void {
  if (w.unsaved) return
  w.unsaved = true
  try {
    let why = 'unknown error'
    try {
      why = String(error)
    } catch {}
    $.ui.log(
      `via could not read or save its agent records (${why}): an agent resumed after a restart runs read-only, without its last answer.`,
    )
  } catch {}
}

export async function recordOf(w: Records, $: Store, agentId: string): Promise<AgentRecord | undefined> {
  const held = w.records.get(agentId)
  if (held !== undefined) return held
  const stored = await $.store.get(keyOf(agentId)).catch((error: unknown) => unsaved(w, $, error))
  if (!isRecord(stored)) return undefined
  const raced = w.records.get(agentId)
  if (raced !== undefined) return raced
  w.records.set(agentId, stored)
  return stored
}

function persist(w: Records, $: Store, write: () => Promise<void>): Promise<void> {
  w.writing = (w.writing ?? Promise.resolve()).then(write).catch((error: unknown) => unsaved(w, $, error))
  return w.writing
}

function stored(record: AgentRecord): AgentRecord {
  const report = record.report
  if (report === undefined || report.length <= REPORT_KEPT) return { ...record }
  return { ...record, report: `[earlier part cut; the whole answer is in the transcript]\n…${report.slice(-REPORT_KEPT)}` }
}

export function createRecord(w: Records, $: Store, agentId: string, record: AgentRecord): Promise<void> {
  w.records.set(agentId, record)
  return persist(w, $, async () => {
    if (!w.cleared) {
      w.cleared = true
      await $.store.delete('agents').catch(() => undefined)
    }
    const listed = await $.store.get(INDEX)
    const ids = [...(Array.isArray(listed) ? listed.filter((id): id is string => typeof id === 'string' && id !== agentId) : []), agentId]
    for (const old of ids.splice(0, Math.max(0, ids.length - KEPT))) await $.store.delete(keyOf(old)).catch(() => undefined)
    await $.store.set(keyOf(agentId), stored(record))
    await $.store.set(INDEX, ids)
  })
}

export function updateRecord(w: Records, $: Store, agentId: string, change: Partial<AgentRecord>): Promise<void> {
  const held = w.records.get(agentId)
  if (held === undefined) return Promise.resolve()
  Object.assign(held, change)
  if (held.rebuilt) return Promise.resolve()
  const snapshot = stored(held)
  return persist(w, $, () => $.store.set(keyOf(agentId), snapshot))
}

export async function freshRecord(w: Records, $: Store, agentId: string): Promise<AgentRecord | undefined> {
  await w.writing
  const stored = await $.store.get(keyOf(agentId)).catch(() => undefined)
  return isRecord(stored) ? stored : w.records.get(agentId)
}

export async function listRecords(w: Records, $: Store): Promise<[string, AgentRecord][]> {
  await w.writing
  const listed = await $.store.get(INDEX)
  const ids = Array.isArray(listed) ? listed.filter((id): id is string => typeof id === 'string') : []
  const found = await Promise.all(ids.map(async (id) => [id, await $.store.get(keyOf(id)).catch(() => undefined)] as const))
  return found.flatMap(([id, record]) => (isRecord(record) ? [[id, record] as [string, AgentRecord]] : [])).reverse()
}

export function forgetRecord(w: Records, $: Store, agentId: string): Promise<void> {
  w.records.delete(agentId)
  const done = (w.writing ?? Promise.resolve()).then(async () => {
    const listed = await $.store.get(INDEX)
    if (Array.isArray(listed))
      await $.store.set(
        INDEX,
        listed.filter((id) => id !== agentId),
      )
    await $.store.delete(keyOf(agentId))
  })
  w.writing = done.catch(() => undefined)
  return done
}
