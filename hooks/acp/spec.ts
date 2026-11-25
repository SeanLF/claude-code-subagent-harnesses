import type { ProcessSpawnRequest } from 'claude-code'
import type { Mode } from './norm'

export type Policy = 'allow' | 'deny' | 'ask'

const relayArgv = (root: string, agent: readonly string[]) => ['node', `${root}/relay/relay.mjs`, '--', ...agent]

function relayEnv(c: {
  inbox?: string
  files?: string
  steer: 'steering' | 'prompt'
  session?: string
  model?: string
  agentMode?: string
  policy: Policy
  config?: Record<string, string>
  options?: Readonly<Record<string, string>>
}) {
  return {
    RELAY_POLICY: c.policy,
    ...(c.inbox ? { RELAY_INBOX: c.inbox, RELAY_STEER: c.steer } : {}),
    ...(c.files ? { RELAY_FILES: c.files } : {}),
    ...(c.session ? { RELAY_SESSION: c.session } : {}),
    ...(c.model ? { RELAY_MODEL: c.model } : {}),
    ...(c.agentMode ? { RELAY_AGENT_MODE: c.agentMode } : {}),
    ...(c.config && Object.keys(c.config).length > 0 ? { RELAY_CONFIG: JSON.stringify(c.config) } : {}),
    ...(c.options && Object.keys(c.options).length > 0 ? { RELAY_OPTIONS: JSON.stringify(c.options) } : {}),
  }
}

export type AcpMode = { readonly agentMode?: string; readonly policy: Policy; readonly command?: readonly string[] }

export type AcpModes = { readonly readOnly: AcpMode } & { readonly [M in Exclude<Mode, 'plan'>]: AcpMode }

export type AcpSpec = {
  readonly name: string
  readonly command: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly steer: 'steering' | 'prompt'
  readonly modes: AcpModes
  readonly thinking?: string
}

export type AcpRun = {
  readonly root: string
  readonly prompt: string
  readonly readOnly: boolean
  readonly mode: Mode
  readonly inbox?: string
  readonly files?: string
  readonly session?: string
  readonly model?: string
  readonly thinking?: string
  readonly command?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly config?: Readonly<Record<string, string>>
  readonly options?: Readonly<Record<string, string>>
}

export function acpMode(spec: AcpSpec, readOnly: boolean, mode: Mode): AcpMode {
  if (readOnly || mode === 'plan') return spec.modes.readOnly
  return (spec.modes as Partial<Record<string, AcpMode>>)[mode] ?? spec.modes.default
}

export function acpForget(
  spec: AcpSpec,
  c: { root: string; session: string; command?: readonly string[] },
): { argv: readonly string[]; env: Record<string, string> } {
  return { argv: relayArgv(c.root, c.command ?? spec.command), env: { RELAY_DELETE: c.session, ...(spec.env ?? {}) } }
}

export function acpStart(spec: AcpSpec, run: AcpRun): ProcessSpawnRequest {
  const { agentMode, policy, command } = acpMode(spec, run.readOnly, run.mode)
  const config = { ...(run.config ?? {}), ...(run.thinking && spec.thinking ? { [spec.thinking]: run.thinking } : {}) }
  return {
    argv: relayArgv(run.root, run.command ?? command ?? spec.command),
    env: {
      ...relayEnv({
        inbox: run.inbox,
        files: run.files,
        steer: spec.steer,
        session: run.session,
        model: run.model,
        agentMode,
        policy,
        config,
        options: run.options,
      }),
      ...(spec.env ?? {}),
      ...(run.env ?? {}),
    },
    input: run.prompt,
  }
}
