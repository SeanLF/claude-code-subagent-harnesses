import type { ProcessSpawnRequest } from 'claude-code'
import type { Mode } from './norm'

// An ACP agent as plain data: everything acpStart needs to run it behind relay/relay.mjs. Plain data
// so that another plugin could hand it over ($.acp.register): a call across plugins clones its
// arguments and refuses functions. Whatever a run needs beyond it (an install path, a guard's env, a
// generated config) the layer above passes in AcpRun.

export type Policy = 'allow' | 'deny' | 'ask'

const relayArgv = (root: string, agent: readonly string[]) => ['node', `${root}/relay/relay.mjs`, '--', ...agent]

// What the relay needs for one run.
// steer: how the agent takes a message mid-run, tested live on each (relay/checks/check.mts).
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

// What Claude Code's permission mode, or a read-only run, sets on the agent: its own mode, if it has
// one, and how the relay answers its permission requests.
// command: the agent as this mode starts it, in place of the spec's (agy leaves its sandbox out in bypass). A run's
// own command (an installed entry point) wins over it, so an adapter that passes one carries its sandbox flags itself.
export type AcpMode = { readonly agentMode?: string; readonly policy: Policy; readonly command?: readonly string[] }

// Each Claude Code permission mode means the same for every harness, in the harness's nearest terms: never more
// than the person gave Claude, and no less unless the harness has nothing closer. So the table names every mode,
// and a missing one is a type error; a row the same as default says why in a comment. readOnly: plan mode or a
// read-only run.
export type AcpModes = { readonly readOnly: AcpMode } & { readonly [M in Exclude<Mode, 'plan'>]: AcpMode }

export type AcpSpec = {
  readonly name: string
  readonly command: readonly string[] // the ACP agent, as the relay starts it
  readonly env?: Readonly<Record<string, string>>
  readonly steer: 'steering' | 'prompt' // how a message reaches a running prompt: the relay's RELAY_STEER
  readonly modes: AcpModes
  readonly thinking?: string // the config option a thinking level sets
}

// One run's data, from the layer above: command replaces the spec's (an installed entry point), env
// and config add to it.
export type AcpRun = {
  readonly root: string
  readonly prompt: string
  readonly readOnly: boolean
  readonly mode: Mode
  readonly inbox?: string
  readonly files?: string // where the relay saves what the agent sends as bytes
  readonly session?: string
  readonly model?: string
  readonly thinking?: string
  readonly command?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly config?: Readonly<Record<string, string>>
  readonly options?: Readonly<Record<string, string>> // the person's config lines
}

// A mode Claude Code adds later, which no table names yet, runs as default: asked, never granted more.
export function acpMode(spec: AcpSpec, readOnly: boolean, mode: Mode): AcpMode {
  if (readOnly || mode === 'plan') return spec.modes.readOnly
  return (spec.modes as Partial<Record<string, AcpMode>>)[mode] ?? spec.modes.default
}

// The relay's RELAY_DELETE for one session of the agent: no session opened, no prompt.
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
