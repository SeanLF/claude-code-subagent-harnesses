import type { Choice } from '../../types'
import { relayEvents, sessionLost } from '../acp/events'
import { type AcpSpec, acpMode, acpStart, type Policy } from '../acp/spec'
import type { Adapter, Mode } from '../adapter'

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
export const OPENCODE: AcpSpec = {
  name: 'opencode',
  command: ['opencode', 'acp'],
  steer: 'prompt',
  modes: { readOnly: { policy: 'deny' }, bypassPermissions: { policy: 'allow' }, dontAsk: { policy: 'deny' }, default: { policy: 'ask' } },
  // A model with variants offers opencode's `effort` config option.
  thinking: 'effort',
}

export function opencodeRun(choice: Choice, mode: Mode, agentId: string): { agent?: string; policy: Policy } {
  const { policy } = acpMode(OPENCODE, choice.tools === 'read', mode)
  return choice.tools === 'read' || mode === 'plan' ? { agent: `via-read-${agentId}`, policy } : { policy }
}

const THINKING = ['minimal', 'low', 'medium', 'high', 'max'] as const

export const opencode = {
  name: 'opencode',
  bin: 'opencode',
  about: "OpenCode CLI agent: any provider's model, including OpenCode's free ones, own tools (edits files).",
  catalogue: { argv: ['opencode', 'models'], ids: (stdout: string) => stdout.split('\n').map((line) => line.trim()) },
  readOnly: 'enforced',
  tools: ['read', 'write'], // write: the same as no tools line, which an agent may not think to leave out
  thinking: THINKING,
  steer: true,
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
    const injected: Record<string, string> = run.agent
      ? { OPENCODE_CONFIG_CONTENT: JSON.stringify({ lsp: false, agent: { [run.agent]: READ } }) }
      : {}
    return acpStart(OPENCODE, {
      root,
      prompt,
      readOnly: choice.tools === 'read',
      mode,
      inbox,
      session,
      model: choice.model,
      thinking: choice.thinking,
      ...(run.agent ? { config: { mode: run.agent }, env: { ...injected, OPENCODE_DISABLE_PROJECT_CONFIG: '1' } } : {}),
    })
  },
  events: () => relayEvents(),
  // The relay names the model the session runs on.
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
