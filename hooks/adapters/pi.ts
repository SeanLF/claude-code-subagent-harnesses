import type { ExtensionAPI, JsonAgentSessionEvent } from '@earendil-works/pi-coding-agent'
import type { Adapter, Norm } from '../adapter'

// Each line must fail to compile. If pnpm-workspace.yaml drops the package a type lives
// in, the type silently stops checking anything and the line compiles: tsc then reports
// the unused @ts-expect-error, instead of passing misspelt fields.
type Of<K extends JsonAgentSessionEvent['type']> = Extract<JsonAgentSessionEvent, { type: K }>
type Reply = Extract<Of<'message_end'>['message'], { role: 'assistant' }>
export const typed = (e: { start: Of<'message_start'>; end: Reply; update: Of<'message_update'>; tool: Of<'tool_execution_start'>; api: ExtensionAPI }) => [
  // @ts-expect-error a real message has no such field
  e.start.message.bogus,
  // @ts-expect-error a real Usage has no such field
  e.end.usage.bogus,
  // @ts-expect-error a real stop reason is a string
  e.end.stopReason.bogus,
  // @ts-expect-error a real update event has no such field
  e.update.assistantMessageEvent.bogus,
  // @ts-expect-error a real tool name is a string
  e.tool.toolName.bogus,
  // @ts-expect-error a real ExtensionAPI has no such member
  e.api.bogus,
]

const THINKING = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

// A tool list of these only is read-only. Such a run ignores the project's trust-gated .pi
// resources (-na): a project the user once trusted would otherwise load its extensions, which are
// code (tested live: a saved trust ran one, -na stopped it; -e extensions such as the inbox still load).
const READ_TOOLS = new Set(['read', 'grep', 'find', 'ls'])
const readsOnly = (tools: string) => tools.split(',').every((tool) => READ_TOOLS.has(tool.trim()))

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// The type is pi's promise about its output, not a check of it: fields stay optional-chained.
function wire(line: string): JsonAgentSessionEvent | undefined {
  try {
    const parsed: unknown = JSON.parse(line)
    return isRecord(parsed) && typeof parsed.type === 'string' ? (parsed as JsonAgentSessionEvent) : undefined
  } catch {
    return undefined
  }
}

export const pi = {
  name: 'pi',
  bin: 'pi',
  about: "pi CLI agent: any provider's model, own tools (edits files).",
  modelExample: 'openrouter/moonshotai/kimi-k2',
  readOnly: 'enforced',
  thinking: THINKING,
  steer: 'mid-run',
  defaultModel: true,
  start: ({ choice, prompt, agentId, root, inbox }) => ({
    argv: [
      'pi',
      '-p',
      '--mode',
      'json',
      '--session-id',
      `pi-${agentId}`,
      '-e',
      `${root}/pi-extension/inbox.ts`,
      ...(choice.model ? ['--model', choice.model] : []),
      ...(choice.tools ? ['--tools', choice.tools, ...(readsOnly(choice.tools) ? ['-na'] : [])] : []),
      ...(choice.thinking ? ['--thinking', choice.thinking] : []),
    ],
    env: { PI_INBOX: inbox ?? '' },
    input: prompt,
  }),
  events: () => (line): Norm[] => {
    const e = wire(line)
    switch (e?.type) {
      case 'message_start':
        if (e.message?.role !== 'assistant') return []
        return [{ k: 'message' }, { k: 'model', name: `${e.message.provider}/${e.message.model}` }]
      case 'message_end': {
        if (e.message?.role === 'user') return [{ k: 'steered' }]
        if (e.message?.role !== 'assistant') return []
        const u = e.message.usage
        const usage = { input: u?.input ?? 0, cacheRead: u?.cacheRead ?? 0, cacheWrite: u?.cacheWrite ?? 0, output: u?.output ?? 0 }
        return e.message.stopReason === 'error'
          ? [{ k: 'usage', usage }, { k: 'error', message: e.message.errorMessage ?? 'unknown error' }]
          : [{ k: 'usage', usage }]
      }
      case 'message_update': {
        const d = e.assistantMessageEvent
        if (d?.type === 'text_delta' && typeof d.delta === 'string') return [{ k: 'text', t: d.delta }]
        if (d?.type === 'thinking_delta' && typeof d.delta === 'string') return [{ k: 'thinking', t: d.delta }]
        return []
      }
      case 'tool_execution_start': {
        const args = JSON.stringify(e.args ?? {}) ?? ''
        return [{ k: 'tool', t: `\n▸ ${e.toolName}: ${args.length > 100 ? `${args.slice(0, 100)}…` : args}\n` }]
      }
      default:
        return []
    }
  },
  // pi names its model in the stream; a model line is a pattern, not a name to sign with.
  model: () => undefined,
  models: 'pi --list-models <search> finds patterns.',
} as const satisfies Adapter
