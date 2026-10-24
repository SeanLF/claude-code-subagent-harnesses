import type { Ask, Norm } from '../adapter'

// An ACP agent runs behind relay/relay.mjs, which holds the connection open: the engine writes a
// spawn's stdin once and closes it. The relay prints ACP session updates and {"via": ...} events.

export type Policy = 'allow' | 'deny' | 'ask'

export const relayArgv = (root: string, agent: readonly string[]) => ['node', `${root}/relay/relay.mjs`, '--', ...agent]

// What the relay needs from via for one run.
export function relayEnv(c: { inbox?: string; session?: string; model?: string; agentMode?: string; policy: Policy; config?: Record<string, string> }) {
  return {
    VIA_POLICY: c.policy,
    ...(c.inbox ? { VIA_INBOX: c.inbox } : {}),
    ...(c.session ? { VIA_SESSION: c.session } : {}),
    ...(c.model ? { VIA_MODEL: c.model } : {}),
    ...(c.agentMode ? { VIA_AGENT_MODE: c.agentMode } : {}),
    ...(c.config && Object.keys(c.config).length > 0 ? { VIA_CONFIG: JSON.stringify(c.config) } : {}),
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const clip = (text: string) => (text.length > 100 ? `${text.slice(0, 100)}…` : text)

function ask(e: Record<string, unknown>): Ask | undefined {
  if (typeof e.id !== 'string' || !Array.isArray(e.options)) return undefined
  const options = e.options.filter(isRecord).flatMap((o) =>
    typeof o.optionId === 'string' && typeof o.name === 'string' && typeof o.kind === 'string' ? [{ optionId: o.optionId, name: o.name, kind: o.kind }] : [],
  )
  return {
    id: e.id,
    title: typeof e.title === 'string' ? e.title : '',
    kind: typeof e.kind === 'string' ? e.kind : 'other',
    ...(typeof e.command === 'string' ? { command: e.command } : {}),
    options,
  }
}

// A parser per run. Updates before the first prompt are a resumed session's history, replayed by
// session/load: never part of this answer.
export function relayEvents(): (line: string) => Norm[] {
  let live = false
  let context = 0
  let speaking: unknown
  const shown = new Set<unknown>()
  return (line) => {
    let e: unknown
    try {
      e = JSON.parse(line)
    } catch {
      return []
    }
    if (!isRecord(e)) return []
    switch (e.via) {
      case 'session':
        return typeof e.sessionId === 'string' ? [{ k: 'session', id: e.sessionId }] : []
      case 'model':
        return typeof e.name === 'string' ? [{ k: 'model', name: e.name }] : []
      case 'steered':
        live = true
        speaking = undefined
        return [{ k: 'steered' }]
      case 'interrupted':
        return [{ k: 'interrupted' }, { k: 'tool', t: '\n▸ interrupted\n' }]
      case 'ask': {
        const asked = ask(e)
        return asked ? [{ k: 'ask', ask: asked }] : []
      }
      case 'error':
        return [{ k: 'error', message: typeof e.message === 'string' ? e.message : 'the relay failed' }]
      case 'prompt_done': {
        // The prompt's own count of what it wrote, beside the context the last usage_update reported.
        const usage = isRecord(e.usage) ? e.usage : {}
        const output = typeof usage.outputTokens === 'number' ? usage.outputTokens : 0
        return [{ k: 'usage', usage: { input: context, cacheRead: 0, cacheWrite: 0, output } }]
      }
      case undefined:
        break
      default:
        return []
    }
    const u = e.update
    if (!live || !isRecord(u)) return []
    switch (u.sessionUpdate) {
      case 'agent_message_chunk': {
        const content = u.content
        const text = isRecord(content) && content.type === 'text' && typeof content.text === 'string' ? content.text : ''
        if (!text) return []
        // Each message is a new one; only the last is the answer.
        const out: Norm[] = []
        // An agent that sends no message id speaks one message per prompt.
        const id = u.messageId ?? 'unnamed'
        if (id !== speaking) {
          speaking = id
          out.push({ k: 'message' })
        }
        out.push({ k: 'text', t: text })
        return out
      }
      case 'agent_thought_chunk': {
        const content = u.content
        return isRecord(content) && typeof content.text === 'string' && content.text ? [{ k: 'thinking', t: content.text }] : []
      }
      case 'tool_call':
      case 'tool_call_update': {
        // Shown once, when it starts running: opencode names the command only in an update.
        if (u.status !== 'in_progress' || shown.has(u.toolCallId)) return []
        shown.add(u.toolCallId)
        const title = typeof u.title === 'string' ? u.title : 'tool'
        return [{ k: 'tool', t: `\n▸ ${typeof u.kind === 'string' ? u.kind : 'tool'}: ${clip(title)}\n` }]
      }
      case 'usage_update':
        // The agent's own count of its context, which is what Claude Code reads usage as.
        if (typeof u.used !== 'number') return []
        context = u.used
        return [{ k: 'usage', usage: { input: u.used, cacheRead: 0, cacheWrite: 0, output: 0 } }]
      default:
        return []
    }
  }
}

// The relay's stderr, for an adapter's failure(): a resumed session the agent no longer has.
export const sessionLost = (stderr: string) => stderr.includes('via relay: session lost:')
