import type { Adapter, Mode } from '../adapter'
import type { Choice } from '../../types'
import { type Policy, relayArgv, relayEnv, relayEvents, sessionLost } from './acp'

// Read-only is a deny-by-default agent: opencode removes denied tools from what the model is offered
// (tested live). Its own plan agent allows bash, so it is not read-only. A repository's opencode.json
// merges into an agent of the same name, keeping its own key order ("*":"deny" then "bash":"allow"
// re-enabled bash), and its MCP servers and plugins run at startup, before any permission applies. So
// read-only runs load no project config. Web access stays denied: read-only reads files, not the
// network. LSP is off too: a TypeScript or ESLint server is started from the project's own
// node_modules, so a global `lsp` setting would run the repository's code on the first file read.
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
// Read-only is the one mode via sets and defends. Otherwise opencode runs with the person's own
// permissions, and an `ask` among them reaches the person, except in bypass (approved) and dontAsk
// (denied).
export function opencodeRun(choice: Choice, mode: Mode, agentId: string): { agent?: string; policy: Policy } {
  if (choice.tools === 'read' || mode === 'plan') return { agent: `via-read-${agentId}`, policy: 'deny' }
  if (mode === 'bypassPermissions') return { policy: 'allow' }
  if (mode === 'dontAsk') return { policy: 'deny' }
  return { policy: 'ask' }
}

const THINKING = ['minimal', 'low', 'medium', 'high', 'max'] as const

export const opencode = {
  name: 'opencode',
  bin: 'opencode',
  about: "OpenCode CLI agent: any provider's model, including OpenCode's free ones, own tools (edits files).",
  modelExample: 'opencode/deepseek-v4.1-flash-free',
  readOnly: 'enforced',
  tools: ['read'],
  // A model with variants offers opencode's `effort` config option.
  thinking: THINKING,
  steer: 'after-turn',
  defaultModel: false,
  models: 'opencode models lists them.',
  relay: {},
  // Tested live: a plugin there ran with OPENCODE_DISABLE_PROJECT_CONFIG, --pure, OPENCODE_PURE,
  // and from a subfolder, so no setting makes a run in such a project read-only.
  // Any .opencode folder counts, whatever it holds: plugins and tools there are code, and not all
  // of its config is proven covered by the flag. Not: ~/.opencode/bin from the install script, and
  // the .gitignore opencode itself writes into every .opencode it loads, even with that flag set.
  unsafeReadOnly: {
    folder: '.opencode',
    harmless: ['bin', '.gitignore'],
    why: 'opencode loads plugins, tools and config from .opencode on every run, before any permission applies',
  },
  start: ({ choice, prompt, session, root, inbox, mode, agentId }) => {
    const run = opencodeRun(choice, mode, agentId)
    // The read agent replaces the person's own OPENCODE_CONFIG_CONTENT for a read-only run.
    const injected: Record<string, string> = run.agent ? { OPENCODE_CONFIG_CONTENT: JSON.stringify({ lsp: false, agent: { [run.agent]: READ } }) } : {}
    const config = { ...(run.agent ? { mode: run.agent } : {}), ...(choice.thinking ? { effort: choice.thinking } : {}) }
    return {
      argv: relayArgv(root, ['opencode', 'acp']),
      env: {
        ...relayEnv({ inbox, session, model: choice.model, policy: run.policy, config }),
        ...injected,
        ...(run.agent ? { OPENCODE_DISABLE_PROJECT_CONFIG: '1' } : {}),
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
          message: "opencode could not find this agent's earlier session, so this message did not run. Send it again to start a new opencode session.",
          sessionLost: true,
        }
      : undefined,
} as const satisfies Adapter
