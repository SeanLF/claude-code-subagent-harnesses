import { isRecord } from './json'
import type { Ask, Norm, Question } from './norm'
import { unhidden } from './text'
import type { SessionUpdate } from './wire'
import type { AskOption, Heard, RelayKind, RelayLineOf, Unchecked } from './wire-relay'

// An ACP agent runs behind relay/relay.mjs, which holds the connection open: the engine writes a
// spawn's stdin once and closes it. The relay prints ACP session updates and {"relay": ...} events
// (wire-relay.ts's RelayLine).

// Paths under the working folder, as codex-acp's titles give them ("Read file '/abs/repo/a.ts'"), are
// shown relative to it: the rest of the title survives the clip, and reads as the agent's own.
// Only where a path starts (the title's start, a quote, a space, an opening parenthesis or =), so a path that merely
// contains the folder (/x/a/repo/y for /a/repo) stays whole.
export const relative = (title: string, cwd: string) =>
  cwd ? title.replace(new RegExp(`(^|[\\s'"(=])${cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`, 'g'), '$1') : title

export const clip = (text: string) => (text.length > 100 ? `${text.slice(0, 100)}…` : text)

export const cap = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text)
export const tail = (text: string, max: number) => (text.length > max ? `…${text.slice(-max)}` : text)

// Why a prompt or a subagent's work ended unfinished, by its ACP stop reason: undefined when it finished,
// was cancelled or failed with an error of its own. ACP asks clients to show a refusal, and the agent
// forgets the refused prompt.
const UNFINISHED: Readonly<Record<string, string>> = {
  refusal: "it refused this request, and its next turn won't include this message",
  max_tokens: 'its reply reached the output token limit',
  max_turn_requests: 'it reached its limit of model requests for this turn',
}
export const unfinished = (stopReason: unknown) => (typeof stopReason === 'string' ? UNFINISHED[stopReason] : undefined)

const tokens = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

// A harness's compaction as a row's output: its sizes on the line that stays when the row folds, as
// Claude Code shows its own in one line, and the summary below it, for ctrl+o.
export function compactionOutput(c: { before?: number; after?: number; why?: string; summary?: string }): string {
  const sizes = c.before !== undefined ? `${tokens(c.before)}${c.after !== undefined ? ` → ${tokens(c.after)}` : ''} tokens` : ''
  const head = [sizes, c.why].filter(Boolean).join(' · ')
  return [head, c.summary?.trim()].filter(Boolean).join('\n\n')
}

// A diff as a row shows it: the path, then its changed lines, the first 40 of them.
export const diffRows = (path: string, changed: string[]) =>
  changed.length > 40 ? `${[path, ...changed.slice(0, 40)].join('\n')}\n…` : [path, ...changed].join('\n')

// An edit as its changed lines: the path, then the lines it took out (-) and put in (+), past what both
// versions share at the start and the end. A new file has no old text.
export function diffOf(path: string, oldText: string, newText: string): string {
  const before = oldText ? oldText.split('\n') : []
  const after = newText ? newText.split('\n') : []
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1
  let endBefore = before.length
  let endAfter = after.length
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore -= 1
    endAfter -= 1
  }
  return diffRows(path, [...before.slice(start, endBefore).map((l) => `- ${l}`), ...after.slice(start, endAfter).map((l) => `+ ${l}`)])
}

const sized = (bytes: number) =>
  bytes < 1024 ? `${bytes} bytes` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`

// A content block as text, in Claude Code's own words for an MCP tool's blocks: what the agent sent as bytes
// (an image, audio, a binary resource) by the file the relay saved it to, which Claude can open; a resource by
// its text, a link by its address. `from` names the agent, as Claude Code names the server.
export function blockText(block: unknown, from: string): string {
  if (!isRecord(block)) return ''
  if (block.type === 'text') return typeof block.text === 'string' ? block.text : ''
  if (block.type === 'resource_link') {
    const link = `[Resource link: ${String(block.name ?? '')}] ${String(block.uri ?? '')}`
    return typeof block.description === 'string' && block.description ? `${link} (${block.description})` : link
  }
  const resource = block.type === 'resource' && isRecord(block.resource) ? block.resource : undefined
  if (resource && typeof resource.text === 'string') return `[Resource from ${from} at ${String(resource.uri ?? '')}] ${resource.text}`
  const lead =
    block.type === 'image'
      ? `[Image from ${from}] `
      : block.type === 'audio'
        ? `[Audio from ${from}] `
        : resource
          ? `[Resource from ${from} at ${String(resource.uri ?? '')}] `
          : undefined
  if (lead === undefined) return ''
  const mimeType = String((resource ?? block).mimeType ?? '') || 'unknown type'
  const relay = isRecord(block._meta) && isRecord(block._meta.relay) ? block._meta.relay : {}
  const size = typeof relay.size === 'number' ? relay.size : Math.floor((String(resource ? resource.blob : block.data).length * 3) / 4)
  if (typeof relay.saved === 'string') return `${lead}Binary content (${mimeType}, ${sized(size)}) saved to ${relay.saved}`
  const why = typeof relay.notSaved === 'string' ? relay.notSaved : 'the relay saves no files'
  return `${lead}Binary content (${mimeType}, ${size} bytes) could not be saved to disk: ${why}`
}

// What a finished tool call returned, as the agent reported it: its text content, a diff of each file
// it edited, or its raw output. An exit code alone is not output (codex-acp reports one there): the
// parser keeps it apart. Kept short: it lands in the subagent's transcript.
function outputOf(u: { readonly content?: unknown; readonly rawOutput?: unknown }, cwd: string, from: string): string {
  const parts: string[] = []
  for (const item of Array.isArray(u.content) ? u.content.filter(isRecord) : []) {
    // Typed, but still an agent's JSON: a content item can come without its content.
    if (item.type === 'content' && blockText(item.content, from)) parts.push(blockText(item.content, from))
    else if (item.type === 'diff' && typeof item.path === 'string' && typeof item.newText === 'string')
      parts.push(diffOf(relative(item.path, cwd), typeof item.oldText === 'string' ? item.oldText : '', item.newText))
  }
  const raw = u.rawOutput
  if (parts.length === 0 && raw !== undefined && raw !== null) {
    if (typeof raw === 'string') parts.push(raw)
    else if (isRecord(raw) && typeof raw.output === 'string') parts.push(raw.output)
    else if (!(isRecord(raw) && typeof raw.exit_code === 'number' && Object.keys(raw).length === 1)) parts.push(JSON.stringify(raw))
  }
  return cap(parts.join('\n').trim(), 2000)
}

function ask(e: Extract<Heard, { relay: 'ask' }>): Ask | undefined {
  if (typeof e.id !== 'string' || !Array.isArray(e.options)) return undefined
  const options = e.options
    .filter(isRecord)
    .map((o): Unchecked<AskOption> => o)
    .flatMap((o) =>
      typeof o.optionId === 'string' && typeof o.name === 'string' && typeof o.kind === 'string'
        ? [{ optionId: o.optionId, name: o.name, kind: o.kind }]
        : [],
    )
  return {
    id: e.id,
    title: typeof e.title === 'string' ? e.title : '',
    kind: typeof e.kind === 'string' ? e.kind : 'other',
    ...(typeof e.command === 'string' ? { command: e.command } : {}),
    options,
  }
}

// What a form shows, without the characters that hide or reorder text, as a permission ask's text is: its
// titles, descriptions, choice names and default text. A choice shown by its value (an enum with no names, a
// oneOf option with no title) gets a cleaned name; the values that go back to the harness stay as they are.
function shownSchema(value: unknown, key = ''): unknown {
  if (typeof value === 'string') return key === 'title' || key === 'description' || key === 'default' ? unhidden(value) : value
  if (Array.isArray(value))
    return value.map((item) => (key === 'enumNames' && typeof item === 'string' ? unhidden(item) : shownSchema(item)))
  if (!isRecord(value)) return value
  const shown = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shownSchema(v, key === 'properties' ? '' : k)]))
  // A field with no title is shown by its name: given a cleaned title when cleaning would change it.
  if (key === 'properties')
    return Object.fromEntries(
      Object.entries(shown).map(([name, field]) =>
        isRecord(field) && !field.title && unhidden(name) !== name ? [name, { ...field, title: unhidden(name) }] : [name, field],
      ),
    )
  const choices = value.enum
  if (Array.isArray(choices) && value.enumNames === undefined && choices.some((c) => typeof c === 'string' && unhidden(c) !== c))
    shown.enumNames = choices.map((c) => unhidden(String(c)))
  if (typeof value.const === 'string' && !value.title && unhidden(value.const) !== value.const) shown.title = unhidden(value.const)
  return shown
}

function question(e: Extract<Heard, { relay: 'question' }>): Question | undefined {
  if (typeof e.id !== 'string' || typeof e.message !== 'string') return undefined
  const message = unhidden(e.message)
  if (e.mode === 'url') {
    // Web links only, checked here as well as in the relay; the message names the site, whatever the harness wrote.
    let host: string
    try {
      const url = new URL(String(e.url))
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
      host = url.host
    } catch {
      return undefined
    }
    return typeof e.url === 'string' && typeof e.elicitationId === 'string'
      ? { id: e.id, message: `${message} (opens ${host})`, mode: 'url', url: e.url, elicitationId: e.elicitationId }
      : undefined
  }
  return e.mode === 'form' && isRecord(e.requestedSchema)
    ? { id: e.id, mode: 'form', message, requestedSchema: shownSchema(e.requestedSchema) as Record<string, unknown> }
    : undefined
}

// One session's updates: the harness's own, or one of its subagents' (ACP's subagents RFD), each with its
// own calls, messages and context.
function sessionEvents(cwdOf: () => string, from: string) {
  let context = 0
  let speaking: unknown
  const shown = new Set<string>()
  const ended = new Set<string>()
  const titles = new Map<string, string>()
  const compactions = new Map<string, { before: number; summary: string }>()
  const kinds = new Map<string, string>()
  // A command's output, as codex-acp streams it (_meta.terminal_output_delta), and its exit code.
  const printed = new Map<string, string>()
  const exits = new Map<string, number>()
  const paths = new Map<string, string>()
  // What a call reported before it ended: codex-acp sends an edit's diff while it runs, not with its end.
  const reported = new Map<string, string>()
  const read = (u: SessionUpdate): Norm[] => {
    const cwd = cwdOf()
    switch (u.sessionUpdate) {
      case 'agent_message_chunk': {
        // A block that is not text stands on its own lines, as Claude Code sets an MCP tool's blocks apart.
        const content = u.content
        const block = blockText(content, from)
        const text = isRecord(content) && content.type !== 'text' && block ? `\n${block}\n` : block
        if (!text) return []
        // Each message is a new one; only the last is the answer.
        const out: Norm[] = []
        // An agent that sends no message id speaks one message per prompt, or between two tool calls.
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
        return isRecord(content) && content.type === 'text' && typeof content.text === 'string' && content.text
          ? [{ k: 'thinking', t: content.text }]
          : []
      }
      case 'tool_call':
      case 'tool_call_update': {
        if (typeof u.toolCallId !== 'string') return []
        // Without message ids (agy), a tool call between two texts is what makes them two messages.
        if (speaking === 'unnamed') speaking = undefined
        const id = u.toolCallId
        if (typeof u.title === 'string') titles.set(id, u.title)
        if (typeof u.kind === 'string') kinds.set(id, u.kind)
        const where = Array.isArray(u.locations) ? u.locations.find((l) => isRecord(l)) : undefined
        if (typeof where?.path === 'string') paths.set(id, where.path)
        const meta = isRecord(u._meta) ? u._meta : {}
        const delta = isRecord(meta.terminal_output_delta) ? meta.terminal_output_delta.data : undefined
        // The end of a long output is kept: that is where an error usually is.
        if (typeof delta === 'string') printed.set(id, tail((printed.get(id) ?? '') + delta, 2000))
        const raw = isRecord(u.rawOutput) ? (u.rawOutput as Record<string, unknown>).exit_code : undefined
        const exit = isRecord(meta.terminal_exit) ? meta.terminal_exit.exit_code : raw
        if (typeof exit === 'number') exits.set(id, exit)
        const now = Array.isArray(u.content) && u.content.length > 0 ? outputOf(u, cwd, from) : ''
        if (now) reported.set(id, now)
        const path = paths.get(id)
        const call = (): Norm => ({
          k: 'call',
          id,
          kind: kinds.get(id) ?? 'other',
          title: clip(relative(titles.get(id) ?? 'tool', cwd)),
          ...(path ? { path } : {}),
        })
        const out: Norm[] = []
        // Announced once, when it starts running: opencode names the command only in an update.
        if (u.status === 'in_progress' && !shown.has(id)) {
          shown.add(id)
          out.push(call())
        }
        if (u.status === 'completed' || u.status === 'failed') {
          // A call reported only once done is announced then.
          if (!shown.has(id)) {
            shown.add(id)
            out.push(call())
          }
          if (!ended.has(id)) {
            ended.add(id)
            const code = exits.get(id)
            const said = outputOf(u, cwd, from) || reported.get(id) || (printed.get(id) ?? '').trim()
            const output = code && !said.includes(`exit code ${code}`) ? `${said}${said ? '\n' : ''}exit code ${code}` : said
            out.push({ k: 'called', id, output, failed: u.status === 'failed' })
          }
        }
        return out
      }
      // Said after the answer, apart from it: a warning about the run, such as Codex resuming on another model.
      case 'notice': {
        const title = typeof u.title === 'string' ? unhidden(u.title).trim() : ''
        if (!title) return []
        const description = typeof u.description === 'string' ? unhidden(u.description).trim() : ''
        // codex-acp's titles end without a full stop: "Model rerouted", then what happened.
        const detail = description ? `${/[.!?:]$/.test(title) ? '' : '.'} ${description}` : ''
        const label = u.severity === 'warning' ? 'Warning: ' : u.severity === 'error' ? 'Error: ' : ''
        return [{ k: 'notice', t: `${label}${title}${detail}` }]
      }
      case 'plan': {
        const entries = (Array.isArray(u.entries) ? u.entries.filter((entry) => isRecord(entry)) : []).flatMap((entry) =>
          typeof entry.content === 'string'
            ? [{ content: entry.content, status: typeof entry.status === 'string' ? entry.status : 'pending' }]
            : [],
        )
        return entries.length > 0 ? [{ k: 'plan', entries }] : []
      }
      // The agent compacts its own context: a row, as Claude Code shows its own compaction. The relay
      // asks for these, so codex-acp sends them in place of a tool call or a line in the answer.
      case 'compaction_summary_chunk':
      case 'compaction_update': {
        if (typeof u.compactionId !== 'string') return []
        const id = `compaction:${u.compactionId}`
        const out: Norm[] = []
        if (!compactions.has(id)) {
          compactions.set(id, { before: context, summary: '' })
          out.push({ k: 'call', id, kind: 'compact', title: 'conversation' })
        }
        const c = compactions.get(id) ?? { before: context, summary: '' }
        const blocks = u.sessionUpdate === 'compaction_summary_chunk' ? [u.content] : Array.isArray(u.summary) ? u.summary : []
        const said = blocks.map((b) => (isRecord(b) && b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('')
        c.summary = u.sessionUpdate === 'compaction_summary_chunk' ? c.summary + said : u.summary === undefined ? c.summary : said
        if (u.sessionUpdate === 'compaction_update' && u.status !== 'in_progress' && !ended.has(id)) {
          ended.add(id)
          const failed = u.status !== 'completed'
          const output = failed
            ? (typeof u.error === 'string' && u.error) || `Compaction ${u.status}.`
            : compactionOutput({ before: c.before || undefined, summary: c.summary })
          out.push({ k: 'called', id, output, failed })
        }
        return out
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
  return {
    read,
    context: () => context,
    // A steer starts a new prompt: its first message is a new one, even with the same id.
    steered: () => {
      speaking = undefined
    },
  }
}

// What a subagent's session says that its nested agent shows; its usage is its own context, not the run's.
const SHOWN: ReadonlySet<string> = new Set(['message', 'text', 'thinking', 'plan', 'call', 'called', 'notice'])

// The relay lines that end a prompt or the run.
const ENDS: readonly RelayKind[] = ['prompt_done', 'interrupted', 'error', 'done']
// Every kind the relay prints has its case: a kind added to RelayLine fails the type check here. At run time, a
// kind this via doesn't know (a newer relay's) shows nothing.
const unknownKind = (_: never): Norm[] => []

// A parser per run. Updates before the first prompt are a resumed session's history, replayed by
// session/load: never part of this answer. So are those between an interrupt and its prompt.
// from: the agent's name, as its blocks are labelled ("[Image from codex]").
export function relayEvents(from = 'the agent'): (line: string) => Norm[] {
  let live = false
  let cwd = ''
  let root: string | undefined
  const own = sessionEvents(() => cwd, from)
  const children = new Map<string, ReturnType<typeof sessionEvents>>()
  // Messages between sessions (ACP's session_message and its chunks): a subagent's task or a later instruction,
  // as the sender's outgoing view or the recipient's incoming one, each an upsert by its id in its own session
  // (omitted: unchanged; null: cleared; a value: replaced) that chunks append to. A message is said once its
  // session moves on (another update of it, or a subagent_update of it; for a sender's view, its recipient's
  // too) or the prompt ends: until then it may grow, or its other view come. A view is the sender's when it
  // names another recipient, or no recipient yet and its own session as sender; the sender's waits for its
  // recipient. Of two views linked by id, one is said: the recipient's when both wait, since delivery may
  // change it. A message to the run's own session is said in its view; one to a subagent, in the subagent's.
  type Message = { to?: string; from?: string; other?: string; blocks: unknown[]; said: boolean }
  const messages = new Map<string, Message>() // by `${session}\n${messageId}`
  const waiting = new Set<string>()
  let kept = false
  let moving: ReadonlySet<string> | undefined // the sessions the line moves on; every one when undefined
  const outgoing = (m: Message, session: string) => (m.to !== undefined ? m.to !== session : m.from === session)
  const entry = (key: string) => {
    const found = messages.get(key)
    if (found) return found
    const made: Message = { blocks: [], said: false }
    messages.set(key, made)
    return made
  }
  const link = (a: string, b: string) => {
    entry(a).other = b
    entry(b).other = a
  }
  const said = (blocks: readonly unknown[]) =>
    blocks
      .map((block) => blockText(block, from))
      .filter(Boolean)
      .join('')
  const keep = (u: Extract<SessionUpdate, { sessionUpdate: 'session_message' | 'session_message_chunk' }>, session: string) => {
    kept = true
    if (typeof u.messageId !== 'string') return
    const key = `${session}\n${u.messageId}`
    const m = entry(key)
    if (u.sessionUpdate === 'session_message_chunk') {
      if (isRecord(u.content)) m.blocks.push(u.content)
    } else {
      const id = (value: unknown) => (typeof value === 'string' ? value : undefined)
      if (u.recipientSessionId !== undefined) m.to = id(u.recipientSessionId)
      if (u.senderSessionId !== undefined) m.from = id(u.senderSessionId)
      if (u.content !== undefined) m.blocks = Array.isArray(u.content) ? [...u.content] : []
      const sent = outgoing(m, session)
      if (sent && m.to !== undefined && typeof u.recipientMessageId === 'string') link(key, `${m.to}\n${u.recipientMessageId}`)
      if (!sent && m.from !== undefined && typeof u.senderMessageId === 'string') link(key, `${m.from}\n${u.senderMessageId}`)
    }
    if (!m.said) waiting.add(key)
  }
  const flush = (): Norm[] => {
    const out: Norm[] = []
    for (const key of waiting) {
      const session = key.slice(0, key.indexOf('\n'))
      const m = messages.get(key)
      const sent = m !== undefined && outgoing(m, session)
      // Its session moved on, or, for a sender's view, its recipient's: the task comes before the child's work.
      if (moving !== undefined && !moving.has(session) && !(sent && m.to !== undefined && moving.has(m.to))) continue
      // Its sender's view, still unaddressed: a later upsert names the recipient.
      if (sent && m.to === undefined) continue
      waiting.delete(key)
      const other = m?.other === undefined ? undefined : messages.get(m.other)
      if (m === undefined || m.said) continue
      if (other?.said) {
        m.said = true
        continue
      }
      const t = said(m.blocks)
      // No content yet, or the recipient's view waits too: a later upsert, or that view, says it.
      if (!t || (sent && other !== undefined && said(other.blocks))) continue
      m.said = true
      if (other) other.said = true
      const to = sent ? (m.to as string) : session
      out.push(to === root ? { k: 'told', t } : { k: 'of', child: to, norm: { k: 'told', t } })
    }
    return out
  }
  // One of the relay's own lines, by wire-relay.ts's names: a kind or field renamed there fails the type check here.
  const relayLine = (e: Heard): Norm[] => {
    // Only the prompt's end, or a line not the relay's, says every message that waits: not a steer, which
    // codex-acp takes mid-turn.
    if (!ENDS.includes(e.relay)) moving = new Set()
    switch (e.relay) {
      case 'session':
        if (typeof e.cwd === 'string' && e.cwd) cwd = e.cwd.replace(/\/+$/, '')
        if (typeof e.sessionId === 'string') root = e.sessionId
        return typeof e.sessionId === 'string' ? [{ k: 'session', id: e.sessionId }] : []
      case 'model':
        return typeof e.name === 'string' ? [{ k: 'model', name: e.name }] : []
      case 'steered':
        live = true
        own.steered()
        return [{ k: 'steered' }]
      case 'interrupted':
        // Until the interrupt's own prompt: what a reopened session says meanwhile is not the answer.
        live = false
        return [{ k: 'interrupted' }, { k: 'tool', t: '\n▸ interrupted\n' }]
      case 'question_closed':
        return typeof e.id === 'string' ? [{ k: 'question-closed', id: e.id }] : []
      case 'question': {
        const asked = question(e)
        return asked ? [{ k: 'question', question: asked }] : []
      }
      case 'ask': {
        const asked = ask(e)
        return asked ? [{ k: 'ask', ask: asked }] : []
      }
      case 'error':
        return [{ k: 'error', message: typeof e.message === 'string' ? e.message : 'the relay failed' }]
      case 'prompt_done': {
        // The prompt's own count of what it wrote, beside the context the last usage_update reported.
        const usage: Unchecked<NonNullable<RelayLineOf<'prompt_done'>['usage']>> = isRecord(e.usage) ? e.usage : {}
        const output = typeof usage.outputTokens === 'number' ? usage.outputTokens : 0
        const why = unfinished(e.stopReason)
        return [
          { k: 'usage', usage: { input: own.context(), cacheRead: 0, cacheWrite: 0, output } },
          ...(why ? [{ k: 'unfinished', why } as const] : []),
        ]
      }
      // Nothing to show: the run's end comes with the relay's exit, and a lost session with its stderr (sessionLost).
      case 'session_lost':
      case 'agent_exit':
      case 'done':
        return []
      default:
        return unknownKind(e)
    }
  }
  const read = (line: string): Norm[] => {
    let e: unknown
    try {
      e = JSON.parse(line)
    } catch {
      return []
    }
    if (!isRecord(e)) return []
    if (e.relay !== undefined) return typeof e.relay === 'string' ? relayLine(e as Heard) : []
    // The agent's JSON, read through the SDK's types: a field the protocol renames fails the type check
    // here. Its values are still checked, as anything a process prints is.
    if (!live || !isRecord(e.update) || typeof e.update.sessionUpdate !== 'string') return []
    const u = e.update as SessionUpdate
    const session = typeof e.sessionId === 'string' ? e.sessionId : root
    moving = new Set([session, u.sessionUpdate === 'subagent_update' ? u.sessionId : undefined].filter((s) => typeof s === 'string'))
    if (u.sessionUpdate === 'session_message' || u.sessionUpdate === 'session_message_chunk') {
      if (session !== undefined) keep(u, session)
      return []
    }
    if (u.sessionUpdate === 'subagent_update') {
      if (typeof u.sessionId !== 'string' || session === undefined) return []
      const now = isRecord(u.state) ? u.state : undefined
      const state = typeof now?.state === 'string' ? now.state : undefined
      // A child's work that ended unfinished says so only here: v1 has no prompt response for it.
      const idle = now?.state === 'idle' ? now : undefined
      const failure =
        idle?.stopReason === 'error'
          ? isRecord(idle.error) && typeof idle.error.message === 'string'
            ? idle.error.message
            : 'error'
          : unfinished(idle?.stopReason)
      return [
        {
          k: 'child',
          id: u.sessionId,
          parent: session,
          ...(typeof u.title === 'string' ? { title: u.title } : {}),
          ...(typeof u.description === 'string' ? { description: u.description } : {}),
          ...(state ? { state } : {}),
          ...(failure ? { failure } : {}),
          ...(idle?.stopReason === 'cancelled' ? { cancelled: true } : {}),
        },
      ]
    }
    // Another session's update is a subagent's only once the run's own session is known.
    if (root === undefined || session === undefined || session === root) return own.read(u)
    // The model a subagent runs on, as its session's config reports it (one select of category model).
    if (u.sessionUpdate === 'config_option_update') {
      const option = (Array.isArray(u.configOptions) ? u.configOptions : []).find((o) => isRecord(o) && o.category === 'model')
      const value = isRecord(option) && typeof option.currentValue === 'string' ? option.currentValue : undefined
      return value ? [{ k: 'of', child: session, norm: { k: 'model', name: value } }] : []
    }
    let child = children.get(session)
    if (child === undefined) {
      child = sessionEvents(() => cwd, from)
      children.set(session, child)
    }
    return child.read(u).flatMap((norm): Norm[] => (SHOWN.has(norm.k) ? [{ k: 'of', child: session, norm }] : []))
  }
  return (line) => {
    kept = false
    moving = undefined
    const norms = read(line)
    return kept ? norms : [...flush(), ...norms]
  }
}

// The relay's stderr, for an adapter's failure(): a resumed session the agent no longer has.
export const sessionLost = (stderr: string) => stderr.includes('acp relay: session lost:')
