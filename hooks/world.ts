import type { Steps } from './acp/steps'
import type { Adapter } from './adapter'
import type { Activity } from './progress'
import type { Inbox } from './steer'

export type Turn = { prompt: string; report?: string; delivered: boolean }

export type World = Steps & {
  adapters: ReadonlyMap<string, Adapter>
  defaultModel: string
  codexAcp: 'pinned' | 'latest'
  node?: Promise<string | undefined> // the version on PATH, asked once
  installs: Map<string, Promise<string>> // an ACP adapter's install, shared by agents starting at once
  timeoutMinutes: number
  turns: Map<string, Turn>
  seeds: Map<string, string>
  handbacks: Map<string, boolean>
  modes: Map<string, string> // Claude Code's permission mode at the spawn
  agents: Map<string, Adapter>
  others: Set<string>
  inboxes: Map<string, Inbox>
  descriptions: Map<string, string> // the spawn's Agent description, for its panel row
  activity: Map<string, Activity>
}
