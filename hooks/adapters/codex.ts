import type { ModelReasoningEffort } from '@openai/codex-sdk'
import type { Adapter, Mode } from '../adapter'
import type { Choice } from '../../types'
import { type Policy, relayArgv, relayEnv, relayEvents, sessionLost } from './acp'

const THINKING = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent'] as const satisfies readonly ModelReasoningEffort[]
// Fails the type check when the SDK adds an effort level this list lacks.
export const everyEffort: [Exclude<ModelReasoningEffort, (typeof THINKING)[number]>] extends [never] ? true : never = true

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// Read-only is the one mode via defends. Otherwise codex works in its workspace sandbox and asks before
// going past it, as codex exec did; the question reaches the person, except in bypass (approved) and
// dontAsk (denied). Never codex-acp's own default, auto review: its reviewer approved a network
// escalation itself, and nobody was asked (reproduced).
export function codexMode(choice: Choice, mode: Mode): { agentMode: string; policy: Policy } {
  if (choice.tools === 'read' || mode === 'plan') return { agentMode: 'read-only', policy: 'deny' }
  if (mode === 'bypassPermissions') return { agentMode: 'workspace-write', policy: 'allow' }
  if (mode === 'dontAsk') return { agentMode: 'workspace-write', policy: 'deny' }
  return { agentMode: 'workspace-write', policy: 'ask' }
}


export const codex = {
  name: 'codex',
  bin: 'codex',
  about: "Codex CLI agent: OpenAI's models, own tools in Codex's sandbox; asks you before going past it.",
  modelExample: 'gpt-5.5',
  readOnly: 'enforced',
  tools: ['read'],
  thinking: THINKING,
  steer: true,
  defaultModel: false,
  // codex-acp and its whole dependency tree, locked with integrity hashes in relay/codex-acp.
  relay: {
    install: {
      dir: 'codex-acp-2.2.2',
      package: '@agentclientprotocol/codex-acp',
      files: ['relay/codex-acp/package.json', 'relay/codex-acp/package-lock.json'],
      entry: 'node_modules/@agentclientprotocol/codex-acp/dist/index.js',
    },
  },
  // codex-acp trusts the working folder, overriding any config (hard-coded in its createSessionConfig),
  // so codex loads a project's .codex/config.toml, whose MCP servers and hooks run outside the
  // sandbox (reproduced: a project MCP server ran during a read-only run). A read-only run is refused
  // under one.
  unsafeReadOnly: {
    folder: '.codex',
    harmless: [],
    own: true,
    why: "codex-acp trusts the working folder, so codex would load this project's .codex config, whose MCP servers and hooks run outside its sandbox",
  },
  // MCP servers run outside Codex's sandbox (openai/codex#7635), so a read-only run lists them and
  // switches each off, with plugins, in the session config codex-acp merges (CODEX_CONFIG).
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
  start: ({ choice, prompt, session, root, inbox, guard, mode, installed }) => {
    const { agentMode, policy } = codexMode(choice, mode)
    // Fail closed: without the guard, MCP servers would run outside the read-only sandbox.
    if (agentMode === 'read-only' && guard === undefined) throw new Error('codex cannot prove read-only without its MCP guard')
    if (installed === undefined) throw new Error('codex-acp is not installed')
    const adapter = ['node', installed]
    return {
      argv: relayArgv(root, adapter),
      env: {
        ...relayEnv({ inbox, session, model: choice.model, agentMode, policy, config: choice.thinking ? { reasoning_effort: choice.thinking } : {} }),
        // The person's own Codex, not the copy codex-acp bundles.
        CODEX_PATH: 'codex',
        ...(agentMode === 'read-only' ? guard : {}),
      },
      input: prompt,
    }
  },
  events: () => relayEvents(),
  // The relay names the model the session runs on.
  model: () => undefined,
  failure: (_exit, stderr) =>
    sessionLost(stderr)
      ? {
          message: "codex could not find this agent's earlier session, so this message did not run. Send it again to start a new codex session.",
          sessionLost: true,
        }
      : undefined,
} as const satisfies Adapter
