import type { Steps } from './acp/steps'
import type { Adapter } from './adapter'
import type { Children } from './children'
import type { Installs } from './install'
import type { Records } from './record'
import type { Asking, Handed, Inbox } from './steer'

// One turn of a via agent. done: its run has answered, so a later step of the turn replays the answer.
// wake: a nested agent's end that reached a via agent as a new turn, which runs nothing.
export type Turn = { prompt: string; done?: true; wake?: true }

// Facts about an agent are in its record (record.ts); the rest is what runs now, in this process.
export type World = Steps<Handed> &
  Children &
  Records &
  Installs &
  Asking & {
    adapters: ReadonlyMap<string, Adapter>
    defaultModel: string
    latest: ReadonlySet<string> // harnesses whose ACP adapter installs the newest, not the pinned one
    timeoutMinutes: number
    turns: Map<string, Turn>
    seeds: Map<string, string> // a spawn's prompt, until its first turn starts
    others: Set<string> // agents that are not via's
    inboxes: Map<string, Inbox>
  }
