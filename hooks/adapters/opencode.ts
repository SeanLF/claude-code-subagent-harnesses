import type { Choice } from '../../types'
import { relayEvents, sessionLost } from '../acp/events'
import { type AcpSpec, acpForget, acpMode, acpStart, type Policy } from '../acp/spec'
import type { Adapter, Mode } from '../adapter'

const READ = {
  mode: 'primary',
  description: 'Read-only agent for via',
  permission: {
    '*': 'deny',
    read: { '*': 'allow', '*.env': 'deny', '*.env.*': 'deny', '*.env.example': 'allow' },
    glob: 'allow',
    grep: 'allow',
    list: 'allow',
    lsp: 'allow',
    todoread: 'allow',
    todowrite: 'allow',
  },
}
export const OPENCODE: AcpSpec = {
  name: 'opencode',
  command: ['opencode', 'acp'],
  steer: 'prompt',
  modes: {
    readOnly: { policy: 'deny' },
    bypassPermissions: { policy: 'allow' },
    dontAsk: { policy: 'deny' },
    default: { policy: 'ask' },
    acceptEdits: { policy: 'ask' },
    auto: { policy: 'ask' },
  },
  thinking: 'effort',
}

export function opencodeRun(choice: Choice, mode: Mode, agentId: string): { agent?: string; policy: Policy } {
  const { policy } = acpMode(OPENCODE, choice.tools === 'read', mode)
  return choice.tools === 'read' || mode === 'plan' ? { agent: `via-read-${agentId}`, policy } : { policy }
}

export const opencode = {
  name: 'opencode',
  bin: 'opencode',
  about: "OpenCode CLI agent: any provider's model, including OpenCode's free ones, own tools (edits files).",
  catalogue: { argv: ['opencode', 'models'], ids: (stdout: string) => stdout.split('\n').map((line) => line.trim()) },
  readOnly: 'enforced',
  tools: ['read', 'write'],
  thinking: 'offered',
  options: true,
  steer: true,
  defaultModel: false,
  models: 'opencode models lists them.',
  relay: {},
  unsafeReadOnly: {
    folder: '.opencode',
    harmless: ['bin', '.gitignore'],
    why: 'opencode loads plugins, tools and config from .opencode on every run, before any permission applies',
  },
  start: ({ choice, prompt, session, root, inbox, files, mode, agentId }) => {
    const run = opencodeRun(choice, mode, agentId)
    const injected: Record<string, string> = run.agent
      ? { OPENCODE_CONFIG_CONTENT: JSON.stringify({ lsp: false, agent: { [run.agent]: READ } }) }
      : {}
    return acpStart(OPENCODE, {
      root,
      prompt,
      readOnly: choice.tools === 'read',
      mode,
      inbox,
      files,
      session,
      model: choice.model,
      thinking: choice.thinking,
      options: choice.config,
      ...(run.agent ? { config: { mode: run.agent }, env: { ...injected, OPENCODE_DISABLE_PROJECT_CONFIG: '1' } } : {}),
    })
  },
  reopen: {
    argv: (session) => ['opencode', '-s', session],
    midRun: false,
    note: 'Open it with the same opencode version as the running service: another version replaces the service, and the new one resumes any OpenCode run then in progress (anomalyco/opencode#51213).',
    service: {
      argv: ['opencode', 'service', 'status'],
      running: (stdout) => /^https?:\/\//.test(stdout.trim()),
      why: "OpenCode's background service is not running, and opening the session would start one, which resumes any OpenCode run then in progress as a second owner (anomalyco/opencode#51213). Start it first with `opencode service start`, between runs.",
    },
  },
  forget: { request: ({ root, session }) => acpForget(OPENCODE, { root, session }) },
  events: () => relayEvents('opencode'),
  model: () => undefined,
  failure: (_exit, stderr) =>
    sessionLost(stderr)
      ? {
          message:
            "opencode could not find this agent's earlier session, so this message did not run. Send it again to start a new opencode session.",
          sessionLost: true,
        }
      : undefined,
} as const satisfies Adapter
