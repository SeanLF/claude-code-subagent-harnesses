import { relayEvents, sessionLost } from '../acp/events'
import { type AcpSpec, acpStart } from '../acp/spec'
import type { Adapter, Norm } from '../adapter'

export const AGY: AcpSpec = {
  name: 'agy',
  command: ['agy', 'acp', '--sandbox'],
  steer: 'prompt',
  modes: {
    readOnly: { policy: 'deny' },
    bypassPermissions: { policy: 'allow', command: ['agy', 'acp'] },
    dontAsk: { policy: 'deny' },
    default: { policy: 'ask' },
    acceptEdits: { agentMode: 'accept-edits', policy: 'ask' },
    auto: { agentMode: 'auto', policy: 'ask' },
  },
  thinking: 'thought_level',
}

const EXIT = /^(?:(?:Created|Completed) At: [^\n]*\n)*Command exited with code (-?\d+)\./
const HEADER = new RegExp(`${EXIT.source}\\n\\nCommand output:\\n`)

export const agy = {
  name: 'agy',
  bin: 'agy',
  about:
    'Antigravity CLI agent: Gemini, Claude and GPT-OSS models through a Google account, own tools (edits files, runs commands in its sandbox, none in bypass mode; no read-only mode).',
  catalogue: { argv: ['agy', 'models'], ids: (stdout: string) => stdout.split('\n').map((line) => line.split('\t')[0]?.trim() ?? '') },
  readOnly: 'none',
  thinking: 'offered',
  steer: true,
  defaultModel: false,
  relay: {},
  start: ({ choice, prompt, session, root, inbox, files, mode }) =>
    acpStart(AGY, { root, prompt, readOnly: false, mode, inbox, files, session, model: choice.model, thinking: choice.thinking }),
  reopen: { argv: (session) => ['agy', '--conversation', session], midRun: false },
  events: () => {
    const read = relayEvents('agy')
    const commands = new Set<string>()
    return (line): Norm[] =>
      read(line).map((n) => {
        if (n.k === 'call' && n.kind === 'execute') commands.add(n.id)
        if (n.k !== 'called' || !commands.delete(n.id)) return n
        const code = EXIT.exec(n.output)?.[1]
        return { ...n, output: n.output.replace(HEADER, ''), failed: n.failed || (code !== undefined && code !== '0') }
      })
  },
  model: () => undefined,
  failure: (_exit, stderr) =>
    sessionLost(stderr)
      ? {
          message:
            "agy could not find this agent's earlier session, so this message did not run. Send it again to start a new agy session.",
          sessionLost: true,
        }
      : undefined,
} as const satisfies Adapter
