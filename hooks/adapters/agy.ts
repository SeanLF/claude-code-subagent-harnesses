import { relayEvents, sessionLost } from '../acp/events'
import { type AcpSpec, acpStart } from '../acp/spec'
import type { Adapter, Norm } from '../adapter'

// agy runs with the person's own tool permission (always-proceed, request-review or strict in its
// settings): its default mode asks only where that setting says to, and the question reaches the person,
// except in bypass (approved) and dontAsk (denied). Its plan mode is not read-only (it ran a command that
// wrote a file, tested live on 1.4.7), so via refuses plan mode and tools: read before readOnly is used.
// A second session/prompt steers the running turn: agy takes the message at its next step (tested live on
// 1.5.7 and 1.5.16).
export const AGY: AcpSpec = {
  name: 'agy',
  // --sandbox confines the commands agy runs (credentials such as ~/.kube are refused by the OS, tested
  // live); it does not stop agy's own file edits, nor a command that writes outside the working folder (1.5.16). Bypass runs
  // without it, as Codex runs with full access there.
  command: ['agy', 'acp', '--sandbox'],
  steer: 'prompt',
  modes: {
    readOnly: { policy: 'deny' },
    // Without --sandbox: every request is approved here anyway, so it would only refuse a command the person
    // allowed, such as kubectl reading ~/.kube (tested live on 1.5.16). Not --dangerously-skip-permissions, which
    // approves requests as the relay's allow policy does, and keeps the sandbox. From imwower's fork (b4c6fff).
    bypassPermissions: { policy: 'allow', command: ['agy', 'acp'] },
    dontAsk: { policy: 'deny' },
    default: { policy: 'ask' },
    // agy's own modes of the same names (tested live on 1.5.16, every question denied): accept-edits made the edit
    // and ran no command; auto did both under request-review, and neither under strict, which it honours.
    acceptEdits: { agentMode: 'accept-edits', policy: 'ask' },
    auto: { agentMode: 'auto', policy: 'ask' },
  },
  thinking: 'thought_level',
}

// agy heads a command's output with its own lines ("Created At: …\nCommand exited with code 0.\n\nCommand
// output:\n"): the call ends with what the command printed, and a nonzero exit code after it.
const EXIT = /^(?:(?:Created|Completed) At: [^\n]*\n)*Command exited with code (-?\d+)\./
const HEADER = new RegExp(`${EXIT.source}\\n\\nCommand output:\\n`)

export const agy = {
  name: 'agy',
  bin: 'agy',
  about:
    'Antigravity CLI agent: Gemini, Claude and GPT-OSS models through a Google account, own tools (edits files, runs commands in its sandbox, none in bypass mode; no read-only mode).',
  // One `id<TAB>name` per line; agy says it is fetching on stderr. Its session takes these ids too: a
  // Gemini one with an effort suffix (gemini-3.8-flash-low) sets the model and its thought_level.
  catalogue: { argv: ['agy', 'models'], ids: (stdout: string) => stdout.split('\n').map((line) => line.split('\t')[0]?.trim() ?? '') },
  readOnly: 'none',
  // agy offers thought_level low, medium and high for its Gemini models and none for its Claude ones; the
  // relay refuses a level the model lacks, naming those it has.
  thinking: 'offered',
  steer: true,
  defaultModel: false,
  relay: {},
  // The prompt goes as text: a leading / is not run as a command over ACP (tested live on 1.5.7 and 1.5.16).
  start: ({ choice, prompt, session, root, inbox, files, mode }) =>
    acpStart(AGY, { root, prompt, readOnly: false, mode, inbox, files, session, model: choice.model, thinking: choice.thinking }),
  // Its ACP session id is its conversation id (the same file under ~/.gemini/antigravity-cli/conversations).
  // Between runs only: whether a second agy may open a conversation another one is writing is untested. agy
  // offers no session delete over ACP (1.5.16), so it has no forget.
  reopen: { argv: (session) => ['agy', '--conversation', session], midRun: false },
  events: () => {
    const read = relayEvents('agy')
    const commands = new Set<string>()
    return (line): Norm[] =>
      read(line).map((n) => {
        if (n.k === 'call' && n.kind === 'execute') commands.add(n.id)
        if (n.k !== 'called' || !commands.delete(n.id)) return n
        // agy reports a command that exited nonzero as completed.
        const code = EXIT.exec(n.output)?.[1]
        return { ...n, output: n.output.replace(HEADER, ''), failed: n.failed || (code !== undefined && code !== '0') }
      })
  },
  // The relay names the model the session runs on.
  model: () => undefined,
  // An unknown session id fails its load as not found (1.5.16; 1.5.7 loaded it as a new, empty one).
  failure: (_exit, stderr) =>
    sessionLost(stderr)
      ? {
          message:
            "agy could not find this agent's earlier session, so this message did not run. Send it again to start a new agy session.",
          sessionLost: true,
        }
      : undefined,
} as const satisfies Adapter
