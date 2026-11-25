import type { Steps } from './acp/steps'
import type { Adapter } from './adapter'
import type { Children } from './children'
import type { Installs } from './install'
import type { Records } from './record'
import type { Asking, Handed, Inbox } from './steer'

export type Turn = { prompt: string; done?: true; wake?: true }

export type World = Steps<Handed> &
  Children &
  Records &
  Installs &
  Asking & {
    adapters: ReadonlyMap<string, Adapter>
    defaultModel: string
    latest: ReadonlySet<string>
    timeoutMinutes: number
    turns: Map<string, Turn>
    seeds: Map<string, string>
    others: Set<string>
    inboxes: Map<string, Inbox>
  }
