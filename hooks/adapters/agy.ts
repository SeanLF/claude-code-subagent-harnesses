import { isRecord } from '../acp/json'
import type { Adapter, Norm } from '../adapter'

// Written from agy 1.4.7's `--output-format stream-json`, captured 2026-10-24: agy publishes
// no types for it (its Python SDK speaks a different protocol), so tests pin these shapes.
type Usage = { input_tokens?: number; output_tokens?: number; cache_read_tokens?: number }
type Step = {
  step_index?: number
  state?: 'ACTIVE' | 'DONE'
  step_type?: string // open vocabulary: user_input, agent_response, tool, system_message, …
  text_delta?: string
  tool_name?: string
  tool_info?: { parameters?: unknown }
  usage?: Usage
}
type AgyEvent =
  | { event: 'init'; conversation_id?: string; init?: { model?: string } }
  | { event: 'step_update'; step_update?: Step }
  | { event: 'result'; result?: { status?: string; error?: unknown } }

const THINKING = ['low', 'medium', 'high', 'xhigh', 'max'] as const

function wire(line: string): AgyEvent | undefined {
  try {
    const parsed: unknown = JSON.parse(line)
    return isRecord(parsed) && typeof parsed.event === 'string' ? (parsed as AgyEvent) : undefined
  } catch {
    return undefined
  }
}

const clip = (text: string) => (text.length > 100 ? `${text.slice(0, 100)}…` : text)

const flags = (choice: { model?: string; thinking?: string }) => [
  ...(choice.model ? ['--model', choice.model] : []),
  ...(choice.thinking ? ['--effort', choice.thinking] : []),
]

export const agy = {
  name: 'agy',
  bin: 'agy',
  about:
    'Antigravity CLI agent: Gemini, Claude and GPT-OSS models through a Google account, own tools (edits files, runs sandboxed commands; no read-only mode).',
  modelExample: 'gemini-3.8-flash',
  // Neither --mode plan nor --sandbox is read-only: plan mode ran a command that wrote a file
  // (tested live on 1.4.7), and --sandbox restricts only terminal commands.
  readOnly: 'none',
  thinking: THINKING,
  steer: false,
  defaultModel: false,
  // The prompt is plain stdin. Slash commands are off, or a prompt starting with `/` runs one.
  // --sandbox confines the commands agy runs (credentials such as ~/.kube are refused by the OS,
  // tested live); it does not stop agy's own file edits.
  start: ({ choice, prompt, session }) => ({
    argv: [
      'agy',
      '--output-format',
      'stream-json',
      '--disable-slash-commands',
      '--sandbox',
      ...flags(choice),
      ...(session ? ['--conversation', session] : []),
    ],
    input: prompt,
  }),
  // `/model` resolves the flags to the exact model, effort variant included, without a turn.
  probe: {
    argv: (choice) => ['agy', '--output-format', 'json', ...flags(choice), '-p=/model'],
    model: (stdout) => {
      try {
        const parsed: unknown = JSON.parse(stdout)
        const id = isRecord(parsed) && isRecord(parsed.command) && isRecord(parsed.command.data) ? parsed.command.data.id : undefined
        return typeof id === 'string' && id ? id : undefined
      } catch {
        return undefined
      }
    },
  },
  events: (session) => {
    let speaking: number | undefined
    return (line): Norm[] => {
      const e = wire(line)
      switch (e?.event) {
        case 'init': {
          const id = e.conversation_id
          const out: Norm[] = typeof id === 'string' && id ? [{ k: 'session', id }] : []
          // Empty on 1.4.7; claudexor reads it, so a version that fills it is believed over the probe.
          if (typeof e.init?.model === 'string' && e.init.model) out.push({ k: 'model', name: e.init.model })
          // A missing conversation is only a warning: agy starts a new one and succeeds.
          if (session && id && id !== session)
            out.push({
              k: 'notice',
              t: "agy could not find this agent's earlier conversation, so this answer comes from a new one without that context.",
            })
          return out
        }
        case 'step_update': {
          const s = e.step_update
          if (s?.step_type === 'agent_response') {
            const out: Norm[] = []
            // Each agent_response step is one message; only the last is the answer.
            if (s.step_index !== speaking) {
              speaking = s.step_index
              out.push({ k: 'message' })
            }
            if (typeof s.text_delta === 'string' && s.text_delta) out.push({ k: 'text', t: s.text_delta })
            // Per step, never result.usage too: that is the same tokens summed.
            // input_tokens excludes cached reads: a captured step read 17582 cached tokens on 3464 input.
            if (s.state === 'DONE' && s.usage) {
              const u = s.usage
              out.push({
                k: 'usage',
                usage: { input: u.input_tokens ?? 0, cacheRead: u.cache_read_tokens ?? 0, cacheWrite: 0, output: u.output_tokens ?? 0 },
              })
            }
            return out
          }
          // A tool step comes twice, ACTIVE then DONE: one line for it.
          if (s?.step_type === 'tool' && s.state === 'ACTIVE')
            return [{ k: 'tool', t: `\n▸ ${String(s.tool_name)}: ${clip(JSON.stringify(s.tool_info?.parameters ?? {}) ?? '')}\n` }]
          return []
        }
        case 'result': {
          const status = e.result?.status
          if (status === undefined || status === 'SUCCESS') return []
          const why = e.result?.error
          return [{ k: 'error', message: typeof why === 'string' && why ? why : `agy ended with status ${status}` }]
        }
        default:
          return []
      }
    }
  },
  model: (choice) => choice.model,
} as const satisfies Adapter
