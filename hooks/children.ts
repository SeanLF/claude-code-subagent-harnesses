import type { EngineInterface, TurnStepChunk, TurnStepResult } from 'claude-code'
import type { Norm } from './acp/norm'
import { CHILD_CALL, type Mark } from './acp/steps'
import { deliver, respond } from './handback'
import { answeredBy, StepWriter } from './writer'

type Queued =
  | Norm
  | { readonly k: 'end'; readonly failure?: string; readonly cancelled?: boolean }
  | { readonly k: 'spawn'; readonly child: string }
export type Channel = {
  readonly key: string
  readonly type: string
  title: string
  role?: string
  prompt?: string
  model?: string
  readonly queue: Queued[]
  wake?: () => void
  spawned: boolean
  ended: boolean
  read: boolean
  closed: boolean
}
export type Children = {
  channels: Map<string, Channel>
  nested: Map<string, string>
  parents: Map<string, string>
}

const put = (channel: Channel, item: Queued) => {
  channel.queue.push(item)
  channel.wake?.()
}

export function route(w: Children, agentId: string, type: string, event: Extract<Norm, { k: 'child' | 'of' }>): Mark[] {
  const key = (session: string) => `${agentId}/${session}`
  const id = event.k === 'child' ? event.id : event.child
  if (event.k === 'child') w.parents.set(key(id), event.parent)
  let channel = w.channels.get(key(id))
  const marks: Mark[] = []
  const working = (event.k === 'of' && event.norm.k !== 'model') || (event.k === 'child' && event.state === 'running')
  const announced = event.k === 'child' && event.title !== undefined
  if (channel === undefined ? working || announced || event.k === 'of' : channel.ended && working) {
    const assignment = `${key(id)}#${channel ? Number(channel.key.slice(channel.key.lastIndexOf('#') + 1)) + 1 : 1}`
    channel = {
      key: assignment,
      type,
      title: channel?.title ?? 'subagent',
      ...(channel?.role ? { role: channel.role } : {}),
      ...(channel?.model ? { model: channel.model } : {}),
      queue: [],
      spawned: false,
      ended: false,
      read: false,
      closed: false,
    }
    w.channels.set(key(id), channel)
    w.channels.set(assignment, channel)
  }
  if (channel === undefined) return marks
  if (event.k === 'child' && !channel.spawned) {
    if (event.title !== undefined) channel.title = event.title
    if (event.description !== undefined) channel.role = event.description
  }
  const told = event.k === 'of' && event.norm.k === 'told' ? event.norm.t : undefined
  if (!channel.spawned) {
    if (told !== undefined) channel.prompt = told
    if (told !== undefined || (event.k === 'of' && event.norm.k !== 'model') || (event.k === 'child' && event.state === 'idle')) {
      channel.spawned = true
      const owner = w.parents.get(key(id))
      const parent = owner === undefined ? undefined : w.channels.get(key(owner))
      if (parent?.spawned && !parent.ended && !parent.read) put(parent, { k: 'spawn', child: channel.key })
      else marks.push(spawnMark(channel))
    }
    if (told !== undefined) return marks
  }
  if (event.k === 'of') {
    if (event.norm.k === 'model') channel.model = event.norm.name
    put(channel, event.norm)
  } else if (event.state === 'idle' && !channel.ended) {
    channel.ended = true
    put(channel, { k: 'end', ...(event.failure ? { failure: event.failure } : {}), ...(event.cancelled ? { cancelled: true } : {}) })
  }
  return marks
}

function spawnMark(channel: Channel): Extract<Mark, { kind: 'spawn' }> {
  const { key, type, title, role, prompt } = channel
  return {
    kind: 'spawn',
    child: key,
    type,
    title: role && role !== 'default' ? `${title} (${role})` : title,
    ...(prompt ? { prompt } : {}),
  }
}

const FRAMING = [
  '[SYSTEM NOTIFICATION',
  'This is an automated background-task event',
  'Do NOT interpret this as user',
  'No human input has been received',
  'Another Claude session sent a message',
  'That "other Claude session" is an agent',
]

export function woken(text: string, nested: ReadonlyMap<string, unknown>): string | undefined {
  let found = false
  const rest = text
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, (block) => {
      if (!block.includes(CHILD_CALL)) return block
      found = true
      return ''
    })
    .replace(/<agent-message\s+from="([^"]+)"[^>]*>[\s\S]*?<\/agent-message>/g, (block, from: string) => {
      if (!nested.has(from)) return block
      found = true
      return ''
    })
  if (!found) return undefined
  return rest
    .split('\n')
    .filter((line) => !FRAMING.some((frame) => line.startsWith(frame)))
    .join('\n')
    .trim()
}

export function closeChildren(w: Children, agentId: string, failure?: string): void {
  for (const key of w.parents.keys()) if (key.startsWith(`${agentId}/`)) w.parents.delete(key)
  for (const [key, channel] of w.channels) {
    if (!key.startsWith(`${agentId}/`)) continue
    channel.closed = true
    if (channel.read || !channel.spawned) w.channels.delete(key)
    else if (!channel.ended) {
      channel.ended = true
      put(channel, { k: 'end', ...(failure ? { failure } : {}) })
    }
  }
}

export async function waitChild(
  w: Children,
  key: string,
  after: (wake: () => void) => ReturnType<EngineInterface['clock']['after']>,
): Promise<void> {
  const channel = w.channels.get(key)
  if (!channel) throw new Error('its event channel is no longer available')
  if (channel.queue.length > 0) return
  let timer: ReturnType<EngineInterface['clock']['after']> | undefined
  try {
    await new Promise<void>((resolve) => {
      channel.wake = resolve
      timer = after(resolve)
    })
  } finally {
    channel.wake = undefined
    timer?.cancel()
  }
}

export async function* childRun(
  w: Children,
  agentId: string,
  name: string,
  e: { turnId: string; index: number },
  signal: AbortSignal,
  handback: boolean,
  wait: (key: string) => Promise<void>,
): AsyncGenerator<TurnStepChunk | Mark, TurnStepResult> {
  const key = w.nested.get(agentId)
  const channel = key === undefined ? undefined : w.channels.get(key)
  const writer = new StepWriter()
  let failure: string | undefined
  let cancelled = false
  const notices: string[] = []
  for (;;) {
    const item = channel?.queue.shift() ?? (channel === undefined ? ({ k: 'end' } as const) : undefined)
    if (item === undefined) {
      if (signal.aborted) break
      const wake = () => channel?.wake?.()
      signal.addEventListener('abort', wake, { once: true })
      try {
        await wait((channel as Channel).key)
      } catch {
        failure = 'could not wait for its next event'
        break
      } finally {
        signal.removeEventListener('abort', wake)
      }
      continue
    }
    if (item.k === 'end') {
      failure = item.failure ?? failure
      cancelled = item.cancelled === true
      if (channel) channel.read = true
      if (channel?.closed) for (const [key, held] of w.channels) if (held === channel) w.channels.delete(key)
      break
    }
    if (item.k === 'spawn') {
      const grand = w.channels.get(item.child)
      writer.boundary()
      if (grand) yield spawnMark(grand)
    } else if (item.k === 'told') yield* writer.told(item.t)
    else if (item.k === 'message') writer.message()
    else if (item.k === 'text') yield writer.text(item.t)
    else if (item.k === 'thinking') yield writer.thinking(item.t)
    else if (item.k === 'plan') yield* writer.plan(item.entries, null)
    else if (item.k === 'call')
      yield writer.call(item.id, { kind: item.kind, title: item.title, ...(item.path ? { path: item.path } : {}) }, null)
    else if (item.k === 'called') yield { kind: 'call-end', id: item.id, output: item.output, failed: item.failed }
    else if (item.k === 'notice') notices.push(item.t)
  }
  const tail = failure
    ? `The ${name} subagent failed: ${failure}`
    : cancelled
      ? `The ${name} subagent was cancelled before it finished.`
      : answeredBy(`${name} subagent`, channel?.model)
  const report = writer.report.trim()
  const said = report || (failure || cancelled ? '' : `The ${name} subagent ended without a message.`)
  const noted = notices.join('\n')
  const signed = [said, noted, tail].filter(Boolean).join('\n\n')
  yield writer.say(`${report && writer.spoke ? '\n\n' : said ? `${said}\n\n` : ''}${noted ? `${noted}\n\n` : ''}${tail}`)
  if (handback) return yield* deliver(name, e, writer.index + 1, signed, null)
  return yield* respond(e, [{ kind: 'stop', stopReason: 'end_turn', usage: null }], signed)
}
