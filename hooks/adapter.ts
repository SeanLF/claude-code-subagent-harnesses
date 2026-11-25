import type { ProcessSpawnRequest, ProcessSpawnResult } from 'claude-code'
import type { Choice } from '../types'

export type { Ask, Mode, Norm, Question, Usage } from './acp/norm'

import type { Mode, Norm } from './acp/norm'

export type Adapter = {
  readonly name: string
  readonly bin: string
  readonly about: string
  readonly catalogue: {
    readonly argv: readonly string[]
    ids(stdout: string): string[]
    readonly preferred?: { readonly file: string; pick(text: string): string | undefined }
  }
  readonly readOnly: 'enforced' | 'none'
  readonly tools?: readonly string[]
  readonly thinking: readonly string[] | 'offered'
  readonly options?: true
  readonly steer: boolean
  readonly defaultModel: boolean
  readonly models?: string
  readonly unsafeReadOnly?: { readonly folder: string; readonly harmless: readonly string[]; readonly why: string; readonly own?: boolean }
  readonly readOnlyGuard?: {
    readonly argv: readonly string[]
    env(stdout: string): Record<string, string> | undefined
    readonly why: string
  }
  readonly relay?: {
    readonly install?: { readonly dir: string; readonly package: string; readonly files: readonly string[]; readonly entry: string }
  }
  readonly reopen?: {
    argv(session: string): readonly string[]
    readonly midRun: boolean
    readonly note?: string
    readonly service?: { readonly argv: readonly string[]; running(stdout: string): boolean; readonly why: string }
  }
  sessionOf?(agentId: string): string
  readonly forget?: {
    request(c: { root: string; session: string; installed?: string }): { argv: readonly string[]; env: Record<string, string> }
    readonly note?: string
  }
  start(c: {
    choice: Choice
    prompt: string
    session?: string
    agentId: string
    root: string
    inbox?: string
    files?: string
    guard?: Readonly<Record<string, string>>
    mode: Mode
    installed?: string
  }): ProcessSpawnRequest
  events(session: string | undefined): (line: string) => Norm[]
  model(choice: Choice): string | undefined
  failure?(exit: ProcessSpawnResult, stderr: string): { message: string; sessionLost?: boolean } | undefined
}

export type PromptAdapter = Pick<Adapter, 'name' | 'readOnly' | 'thinking' | 'tools' | 'options'>
export type HelpAdapter = PromptAdapter & Pick<Adapter, 'bin' | 'about' | 'steer' | 'defaultModel' | 'models'>
