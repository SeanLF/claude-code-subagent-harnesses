import type { Choice } from '../../types'
import { relayEvents, sessionLost } from '../acp/events'
import { isRecord } from '../acp/json'
import { type AcpMode, type AcpSpec, acpForget, acpMode, acpStart } from '../acp/spec'
import type { Adapter, Mode } from '../adapter'

export const CODEX: AcpSpec = {
  name: 'codex',
  command: ['codex-acp'],
  env: { CODEX_PATH: 'codex' },
  steer: 'steering',
  modes: {
    readOnly: { agentMode: 'read-only', policy: 'deny' },
    bypassPermissions: { agentMode: 'agent-full-access', policy: 'allow' },
    dontAsk: { agentMode: 'workspace-write', policy: 'deny' },
    default: { agentMode: 'workspace-write', policy: 'ask' },
    acceptEdits: { agentMode: 'workspace-write', policy: 'ask' },
    auto: { agentMode: 'workspace-write', policy: 'ask' },
  },
  thinking: 'reasoning_effort',
}

export function codexMode(choice: Choice, mode: Mode): AcpMode {
  return acpMode(CODEX, choice.tools === 'read', mode)
}

export const codex = {
  name: 'codex',
  bin: 'codex',
  about: "Codex CLI agent: OpenAI's models, own tools in Codex's sandbox (none in bypass mode); asks you before going past it.",
  catalogue: {
    argv: ['codex', 'debug', 'models'],
    ids: (stdout: string) => {
      try {
        const { models } = JSON.parse(stdout) as { models?: { slug?: unknown; visibility?: unknown; priority?: unknown }[] }
        return (models ?? [])
          .filter((m) => m.visibility === 'list' && typeof m.slug === 'string')
          .sort((a, b) => Number(a.priority ?? 0) - Number(b.priority ?? 0))
          .map((m) => m.slug as string)
      } catch {
        return []
      }
    },
  },
  readOnly: 'enforced',
  tools: ['read', 'write'],
  thinking: 'offered',
  options: true,
  steer: true,
  defaultModel: false,
  relay: {
    install: {
      dir: 'codex-acp-2.10.0',
      package: '@agentclientprotocol/codex-acp',
      files: ['relay/codex-acp/package.json', 'relay/codex-acp/package-lock.json'],
      entry: 'node_modules/@agentclientprotocol/codex-acp/dist/index.js',
    },
  },
  unsafeReadOnly: {
    folder: '.codex',
    harmless: [],
    own: true,
    why: "codex-acp trusts the working folder, so codex would load this project's .codex config, whose MCP servers and hooks run outside its sandbox",
  },
  readOnlyGuard: {
    argv: ['codex', 'mcp', 'list', '--json', '--disable', 'plugins'],
    why: 'the MCP servers it would run outside its sandbox could not all be listed and switched off',
    env: (stdout) => {
      try {
        const parsed: unknown = JSON.parse(stdout)
        if (!Array.isArray(parsed)) return undefined
        const names = parsed.map((server: unknown) => (isRecord(server) && typeof server.name === 'string' ? server.name : undefined))
        if (names.some((name) => name === undefined)) return undefined
        const servers = Object.fromEntries(names.map((name) => [name, { enabled: false }]))
        return { CODEX_CONFIG: JSON.stringify({ mcp_servers: servers, features: { plugins: false } }) }
      } catch {
        return undefined
      }
    },
  },
  start: ({ choice, prompt, session, root, inbox, files, guard, mode, installed }) => {
    const readOnly = codexMode(choice, mode).agentMode === 'read-only'
    if (readOnly && guard === undefined) throw new Error('codex cannot prove read-only without its MCP guard')
    if (installed === undefined) throw new Error('codex-acp is not installed')
    return acpStart(CODEX, {
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
      command: ['node', installed],
      ...(readOnly ? { env: guard } : {}),
    })
  },
  reopen: { argv: (session) => ['codex', 'resume', session], midRun: true },
  forget: {
    request: ({ root, session, installed }) => {
      if (installed === undefined) throw new Error('codex-acp is not installed')
      return acpForget(CODEX, { root, session, command: ['node', installed] })
    },
    note: 'Codex keeps it archived: `codex unarchive <session>` brings it back.',
  },
  events: () => relayEvents('codex'),
  model: () => undefined,
  failure: (_exit, stderr) =>
    sessionLost(stderr)
      ? {
          message:
            "codex could not find this agent's earlier session, so this message did not run. Send it again to start a new codex session.",
          sessionLost: true,
        }
      : undefined,
} as const satisfies Adapter
