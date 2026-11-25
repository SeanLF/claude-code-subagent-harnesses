import { cap, clip, compactionOutput, diffOf, diffRows, relative, tail } from '../acp/events'
import { isRecord } from '../acp/json'
import type { Adapter, Norm } from '../adapter'
import type { PiEvent } from '../wire'

const THINKING = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

const READ_TOOLS = new Set(['read', 'grep', 'find', 'ls'])
const readsOnly = (tools: string) => tools.split(',').every((tool) => READ_TOOLS.has(tool.trim()))

function parse(line: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(line)
    return isRecord(parsed) && typeof parsed.type === 'string' ? parsed : undefined
  } catch {
    return undefined
  }
}

const text = (value: unknown) => (typeof value === 'string' ? value : '')

const KINDS: Record<string, string> = {
  read: 'read',
  edit: 'edit',
  write: 'edit',
  bash: 'execute',
  grep: 'search',
  find: 'search',
  ls: 'search',
}

function titleOf(tool: string, args: Record<string, unknown>): string {
  const path = text(args.path)
  switch (tool) {
    case 'read':
      return `Read ${path}`
    case 'edit':
      return `Edit ${path}`
    case 'write':
      return `Write ${path}`
    case 'bash':
      return text(args.command)
    case 'grep':
    case 'find':
      return [tool, text(args.pattern), path].filter(Boolean).join(' ')
    case 'ls':
      return ['ls', path].filter(Boolean).join(' ')
    default:
      return `${tool}: ${JSON.stringify(args)}`
  }
}

function outputOf(tool: string, args: Record<string, unknown>, result: unknown, failed: boolean, cwd: string): string {
  const r = isRecord(result) ? result : {}
  const path = relative(text(args.path), cwd)
  const patch = isRecord(r.details) ? text(r.details.patch) : ''
  const lines = patch.split('\n')
  const first = lines.findIndex((l) => l.startsWith('@@'))
  if (tool === 'edit' && first >= 0) {
    const hunks = lines.slice(first)
    return diffRows(
      path,
      hunks.filter((l) => l.startsWith('-') || l.startsWith('+')).map((l) => `${l[0]} ${l.slice(1)}`),
    )
  }
  if (tool === 'write' && !failed && typeof args.content === 'string') return diffOf(path, '', args.content)
  const said = (Array.isArray(r.content) ? r.content : []).flatMap((c) => (isRecord(c) && c.type === 'text' ? [text(c.text)] : []))
  const output = said.join('\n').trim()
  return tool === 'bash' ? tail(output, 2000) : cap(output, 2000)
}

export const pi = {
  name: 'pi',
  bin: 'pi',
  about: "pi CLI agent: any provider's model, own tools (edits files).",
  catalogue: {
    argv: ['pi', '--list-models'],
    preferred: {
      file: '.pi/agent/settings.json',
      pick: (text: string) => {
        try {
          const s = JSON.parse(text) as { defaultProvider?: unknown; defaultModel?: unknown }
          return typeof s.defaultProvider === 'string' && typeof s.defaultModel === 'string'
            ? `${s.defaultProvider}/${s.defaultModel}`
            : undefined
        } catch {
          return undefined
        }
      },
    },
    ids: (stdout: string) =>
      stdout
        .split('\n')
        .slice(1)
        .map((line) => line.trim().split(/\s+/))
        .filter((cells) => cells.length >= 2)
        .map(([provider, model]) => `${provider}/${model}`),
  },
  readOnly: 'enforced',
  thinking: THINKING,
  steer: true,
  defaultModel: true,
  sessionOf: (agentId) => `pi-${agentId}`,
  reopen: { argv: (session) => ['pi', '--session', session], midRun: false },
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
  events: () => {
    let cwd = ''
    const args = new Map<string, Record<string, unknown>>()
    let compactions = 0
    return (line): Norm[] => {
      const raw = parse(line)
      if (raw?.type === 'session' && typeof raw.cwd === 'string') cwd = raw.cwd.replace(/\/+$/, '')
      const e = raw as PiEvent | undefined
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
            ? [
                { k: 'usage', usage },
                { k: 'error', message: e.message.errorMessage ?? 'unknown error' },
              ]
            : [{ k: 'usage', usage }]
        }
        case 'message_update': {
          const d = e.assistantMessageEvent
          if (d?.type === 'text_delta' && typeof d.delta === 'string') return [{ k: 'text', t: d.delta }]
          if (d?.type === 'thinking_delta' && typeof d.delta === 'string') return [{ k: 'thinking', t: d.delta }]
          return []
        }
        case 'tool_execution_start': {
          const given = isRecord(e.args) ? e.args : {}
          const tool = text(e.toolName)
          if (typeof e.toolCallId !== 'string') return [{ k: 'tool', t: `\n▸ ${clip(`${tool}: ${JSON.stringify(given)}`)}\n` }]
          args.set(e.toolCallId, given)
          const path = text(given.path)
          const absolute = path.startsWith('/') ? path : path && cwd ? `${cwd}/${path}` : ''
          return [
            {
              k: 'call',
              id: e.toolCallId,
              kind: KINDS[tool] ?? 'other',
              title: clip(relative(titleOf(tool, given), cwd)),
              ...(absolute ? { path: absolute } : {}),
            },
          ]
        }
        case 'compaction_start':
          compactions += 1
          return [{ k: 'call', id: `pi-compaction-${compactions}`, kind: 'compact', title: 'conversation' }]
        case 'compaction_end': {
          const r = e.result
          const why = e.reason === 'threshold' ? undefined : e.reason
          const output = r
            ? compactionOutput({ before: r.tokensBefore, after: r.estimatedTokensAfter, why, summary: r.summary })
            : e.errorMessage || (e.aborted ? 'Stopped.' : 'pi could not compact.')
          return [{ k: 'called', id: `pi-compaction-${compactions}`, output, failed: r === undefined }]
        }
        case 'tool_execution_end': {
          if (typeof e.toolCallId !== 'string') return []
          const given = args.get(e.toolCallId) ?? {}
          args.delete(e.toolCallId)
          const failed = e.isError === true
          return [{ k: 'called', id: e.toolCallId, output: outputOf(text(e.toolName), given, e.result, failed, cwd), failed }]
        }
        default:
          return []
      }
    }
  },
  model: () => undefined,
  models: 'pi --list-models <search> finds patterns.',
} as const satisfies Adapter
