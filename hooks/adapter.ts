import type { ProcessSpawnRequest, ProcessSpawnResult } from 'claude-code'
import type { Choice } from '../types'

export type Usage = {
  readonly input: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly output: number
}

export type Norm =
  | { readonly k: 'message' } // a new assistant message starts: only the last one is the answer
  | { readonly k: 'session'; readonly id: string } // harness-issued id, saved at once for follow-ups
  | { readonly k: 'model'; readonly name: string }
  | { readonly k: 'text' | 'thinking' | 'tool'; readonly t: string }
  | { readonly k: 'usage'; readonly usage: Usage } // the core keeps the last one: per message, never a running total
  | { readonly k: 'steered' }
  | { readonly k: 'error'; readonly message: string }
  | { readonly k: 'notice'; readonly t: string } // said after the answer, as part of it
  | { readonly k: 'interrupted' } // the harness took an interrupt itself: nothing for the core to rerun
  | { readonly k: 'ask'; readonly ask: Ask } // a permission question for the person; the core writes the answer to the inbox

export type Ask = {
  readonly id: string
  readonly title: string
  readonly kind: string
  readonly command?: string
  readonly options: readonly { readonly optionId: string; readonly name: string; readonly kind: string }[]
}

// Claude Code's permission mode, as the spawn carried it: what the person allows Claude itself.
export type Mode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions' | 'dontAsk'

export type Adapter = {
  readonly name: string
  readonly bin: string
  readonly about: string // the agent type's one-line description starts with it
  readonly modelExample: string
  readonly readOnly: 'enforced' | 'none'
  readonly tools?: readonly string[] // the only values a tools line may take; absent: a free tool list
  readonly thinking: readonly string[]
  readonly steer: 'mid-run' | 'after-turn' | false // how a message to a running agent reaches it; false: only as a follow-up
  readonly defaultModel: boolean // takes the plugin's defaultModel setting
  readonly models?: string
  // A folder that voids read-only when found in the working folder or any folder above it, unless
  // it holds only the `harmless` entries: the harness loads code from it before any permission applies.
  // own: the person's own ~/<folder> is their config, not a project's, and does not count.
  readonly unsafeReadOnly?: { readonly folder: string; readonly harmless: readonly string[]; readonly why: string; readonly own?: boolean }
  // What a read-only run runs first, and the environment its output requires: when the harness cannot
  // prove it, turn.ts refuses the run. env returns undefined when the output does not prove it.
  readonly readOnlyGuard?: { readonly argv: readonly string[]; env(stdout: string): Record<string, string> | undefined; readonly why: string }
  // Runs behind relay/relay.mjs, which needs Node 22.18 or later. install: an ACP adapter via installs
  // once from a lockfile it ships, into ~/.claude/via/acp/<dir>; start then gets its entry point, or
  // 'latest' when the person chose to fetch the newest one instead.
  readonly relay?: { readonly install?: { readonly dir: string; readonly package: string; readonly files: readonly string[]; readonly entry: string } }
  start(c: {
    choice: Choice
    prompt: string
    session?: string
    agentId: string
    root: string
    inbox?: string
    guard?: Readonly<Record<string, string>>
    mode: Mode
    installed?: string
  }): ProcessSpawnRequest
  // A parser per run: message boundaries can depend on earlier lines, and session is what the run asked to resume.
  events(session: string | undefined): (line: string) => Norm[]
  // Asks the harness at no cost which model answered: alongside the run from its flags, or after
  // it from the session it ran in (`after`), when only the session can say.
  readonly probe?: {
    readonly after?: boolean
    argv(choice: Choice, session?: string): string[]
    env?(choice: Choice): Record<string, string> | undefined
    model(stdout: string): string | undefined
  }
  model(choice: Choice): string | undefined // a real model name when the stream names none, never a pattern
  // A known failure in plain words; sessionLost forgets the saved session so the next message starts fresh.
  failure?(exit: ProcessSpawnResult, stderr: string): { message: string; sessionLost?: boolean } | undefined
}

export type PromptAdapter = Pick<Adapter, 'name' | 'readOnly' | 'thinking' | 'tools'>
export type HelpAdapter = PromptAdapter & Pick<Adapter, 'bin' | 'about' | 'modelExample' | 'steer' | 'defaultModel' | 'models'>
