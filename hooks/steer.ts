import type { EngineInterface, MatchedHook, Timer } from 'claude-code'
import { isRecord } from './acp/json'
import { dropHanded, questionClosed, type Send } from './acp/steps'
import { unhidden } from './acp/text'
import type { InboxLine } from './acp/wire-relay'
import type { Ask, Question } from './adapter'
import {
  type Asked,
  handoffText,
  LET_CLAUDE,
  type Plan,
  planOf,
  readAnswers,
  readReply,
  type Shown,
  shownOf,
  wholeQuestions,
} from './questions'
import type { World } from './world'

export type Inbox = { name: string; path: string; files: string; lines: string[]; interrupt?: string }

const INTERRUPT = /^interrupt:[ \t]*/i

export const steerDelivered = (name: string) => `Delivered to the running ${name} agent; ${name} reads it at its next step.`
export const interruptDelivered = (name: string) =>
  `Interrupting the running ${name} agent: it stops its current step, then takes this message.`

export async function openInbox(
  $: Pick<EngineInterface, 'env' | 'fs'>,
  name: string,
  agentId: string,
  inboxes: Map<string, Inbox>,
): Promise<Inbox | undefined> {
  const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))
  if (!home) return undefined
  const inbox: Inbox = {
    name,
    path: `${home}/.claude/via/inbox/${name}-${agentId}.jsonl`,
    files: `${home}/.claude/via/files/${name}-${agentId}`,
    lines: [],
  }
  const opened = await $.fs.write(inbox.path, '').then(
    () => true,
    () => false,
  )
  if (!opened) return undefined
  inboxes.set(agentId, inbox)
  return inbox
}

export async function closeInbox(
  $: Pick<EngineInterface, 'fs'>,
  inbox: Inbox,
  agentId: string,
  inboxes: Map<string, Inbox>,
): Promise<void> {
  inboxes.delete(agentId)
  await $.fs.write(inbox.path, '').catch(() => {})
}

export function undeliveredSteers(inbox: Inbox | undefined, steered: number): string[] {
  const steers = (inbox?.lines ?? [])
    .map((line) => JSON.parse(line) as InboxLine)
    .filter((value): value is string => typeof value === 'string')
  return steers.slice(Math.max(0, steered - 1))
}

export function undeliveredNotice(inbox: Inbox | undefined, steered: number, name: string): string | undefined {
  const steers = [...undeliveredSteers(inbox, steered), ...(inbox?.interrupt === undefined ? [] : [inbox.interrupt])]
  if (steers.length === 0) return undefined
  return `Not delivered before ${name} finished (send again as a follow-up):\n${steers.join('\n')}`
}

type SendHook = MatchedHook<'tool.call', { tool: 'SendMessage' }>

export async function sendMessage(w: World, $: Parameters<SendHook>[0], e: Parameters<SendHook>[1], next: Parameters<SendHook>[2]) {
  const to = typeof e.to === 'string' ? e.to : undefined
  const message = typeof e.message === 'string' ? e.message : undefined
  let agentId = to !== undefined && message !== undefined && w.inboxes.has(to) ? to : undefined
  if (agentId === undefined && to !== undefined && message !== undefined) {
    const named = (await $.agent.list()).find((a) => a.name === to)
    agentId = named !== undefined && w.inboxes.has(named.id) ? named.id : undefined
  }
  const inbox = agentId === undefined ? undefined : w.inboxes.get(agentId)
  if (agentId === undefined || inbox === undefined || message === undefined || e.notify_when_idle) return next(e)
  const handed = w.handed.get(agentId)?.[0]
  if (handed !== undefined && handed.inbox !== inbox) w.handed.delete(agentId)
  else if (handed?.sent && e.agentId === undefined && !INTERRUPT.test(message)) return answerHanded($, w, agentId, handed, message)
  const interrupted = await steer($, inbox, message)
  return { result: { success: true, message: interrupted ? interruptDelivered(inbox.name) : steerDelivered(inbox.name) } }
}

export async function steer($: Pick<EngineInterface, 'fs'>, inbox: Inbox, message: string): Promise<boolean> {
  const asked = INTERRUPT.test(message) ? message.replace(INTERRUPT, '') : undefined
  const line: InboxLine = asked === undefined ? message : { interrupt: asked }
  const lines = [...inbox.lines, JSON.stringify(line)]
  inbox.lines = lines
  await $.fs.write(inbox.path, lines.map((line) => `${line}\n`).join(''))
  if (asked === undefined) return false
  inbox.interrupt = inbox.interrupt === undefined ? asked : `${inbox.interrupt}\n\n${asked}`
  return true
}

export function typed(content: readonly unknown[]): string {
  const text = content
    .map((block) =>
      typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text'
        ? String((block as { text?: unknown }).text ?? '')
        : '',
    )
    .join('')
  return (
    /^<system-reminder>\nThe user sent a new message while you were working:\n([\s\S]*?)\n\nThis is how Claude Code/
      .exec(text)?.[1]
      ?.trim() ?? ''
  )
}

const VERB: Record<string, string> = { execute: 'run', edit: 'edit', delete: 'delete', move: 'move', fetch: 'fetch', read: 'read' }
const shown = (text: string) => unhidden(text.replace(/\r?\n/g, ' ⏎ ')).trim()

export async function answerAsk(
  $: Pick<EngineInterface, 'ui' | 'fs'>,
  inboxes: Map<string, Inbox>,
  agentId: string,
  inbox: Inbox | undefined,
  ask: Ask,
  name: string,
): Promise<void> {
  if (inbox === undefined) return
  const allow = ask.options.filter((o) => o.kind === 'allow_once')
  const deny = ask.options.find((o) => o.kind === 'reject_once') ?? ask.options.find((o) => o.kind === 'reject_always')
  const choices = new Map<string, string | null>()
  for (const option of [...allow.slice(0, 1), ...(deny ? [deny] : [])]) {
    const label = shown(option.name) || option.kind
    if (!choices.has(label)) choices.set(label, option.optionId)
  }
  if (choices.size < 2) choices.set('Deny', deny?.optionId ?? null)
  const what = shown(ask.command ?? ask.title) || 'a tool'
  const question = `${name} wants to ${VERB[ask.kind] ?? 'use'} ${ask.command ? `\`${what}\`` : what}. Allow it?`
  void $.ui.notify(`${name} needs your answer`).catch(() => {})
  const picked = await $.ui.ask(question, [...choices.keys()]).catch(() => undefined)
  const optionId = picked !== undefined && choices.has(picked) ? (choices.get(picked) ?? null) : (deny?.optionId ?? null)
  await answered($, inboxes, agentId, inbox, { answer: ask.id, optionId })
}

async function answered($: Pick<EngineInterface, 'fs'>, inboxes: Map<string, Inbox>, agentId: string, inbox: Inbox, line: InboxLine) {
  if (inboxes.get(agentId) !== inbox) return
  inbox.lines = [...inbox.lines, JSON.stringify(line)]
  await $.fs.write(inbox.path, inbox.lines.map((l) => `${l}\n`).join('')).catch(() => {})
}

type Reply = { action: 'accept'; content: Record<string, unknown> } | { action: 'decline' } | { action: 'cancel' }
const CANCEL: Reply = { action: 'cancel' }

function replyOf(result: unknown): Reply {
  const text = Array.isArray(result) ? (result[0] as { text?: unknown } | undefined)?.text : undefined
  let reply: { action?: unknown; content?: unknown } = {}
  try {
    reply = typeof text === 'string' ? (JSON.parse(text) as typeof reply) : {}
  } catch {}
  if (reply.action === 'accept')
    return {
      action: 'accept',
      content: typeof reply.content === 'object' && reply.content !== null ? (reply.content as Record<string, unknown>) : {},
    }
  return reply.action === 'decline' ? { action: 'decline' } : CANCEL
}

const SAID: Record<Reply['action'], string> = { accept: 'Answered', decline: 'Declined', cancel: 'Not answered' }
const CLOSED = 'No longer needed: the harness moved on before you answered.'
const saidOf = (reply: Reply) =>
  reply.action === 'accept' && Object.keys(reply.content).length > 0
    ? `${SAID.accept}: ${JSON.stringify(reply.content)}`
    : SAID[reply.action]

export type Pending = {
  id: number
  questions: Shown[]
  stop: AbortSignal
  taken?: true
  result?: { answers: Readonly<Record<string, unknown>> } | { away: number }
  done: Promise<void>
}
export type Asking = { asking: Map<number, Pending>; asked: number; interactive: boolean; background: Set<string> }
export type Handed = {
  id: string
  inbox: Inbox
  harness: string
  handed: Asked[]
  content: Record<string, unknown>
  send: Send
  sent?: true
}

const AWAY: Readonly<Record<string, number>> = { '60s': 60_000, '5m': 300_000, '10m': 600_000 }
async function awayAfter($: Pick<EngineInterface, 'settings'>): Promise<number | undefined> {
  const set = await $.settings.read({ key: 'askUserQuestionTimeout' }).catch(() => undefined)
  return typeof set === 'string' ? AWAY[set] : undefined
}
const duration = (ms: number) =>
  ms % 60_000 === 0 ? `${ms / 60_000} minute${ms === 60_000 ? '' : 's'}` : `${Math.round(ms / 1000)} seconds`

type AskHook = MatchedHook<'tool.call', { tool: 'AskUserQuestion' }>
export async function showQuestions(
  w: Asking,
  $: Pick<EngineInterface, 'settings' | 'viaQuestions'>,
  e: Parameters<AskHook>[1],
  next: Parameters<AskHook>[2],
) {
  const first = (e.questions as readonly { question?: unknown }[] | undefined)?.[0]?.question
  const pending = [...w.asking.values()].find((p) => !p.taken && p.questions[0]?.question === first)
  if (pending === undefined) return next(e)
  pending.taken = true
  const ms = await awayAfter($)
  const asked = next({ ...e, questions: pending.questions })
  asked.catch(() => {})
  const stopped = new Promise<'stopped'>((resolve) => {
    if (pending.stop.aborted) resolve('stopped')
    pending.stop.addEventListener('abort', () => resolve('stopped'), { once: true })
  })
  const away = ms === undefined ? new Promise<never>(() => {}) : timeout($, pending.id, ms)
  const done = await Promise.race([asked, stopped, away])
  if (done === 'away' && ms !== undefined) pending.result = { away: ms }
  if (done === 'stopped' || done === 'away') return { result: { questions: pending.questions, answers: {} } }
  const result = done.deny === undefined && isRecord(done.result) ? done.result : undefined
  if (typeof result?.afkTimeoutMs === 'number') pending.result = { away: result.afkTimeoutMs }
  else if (isRecord(result?.answers)) pending.result = { answers: result.answers }
  return done
}

const SLICE = 5_000
async function timeout($: Pick<EngineInterface, 'viaQuestions'>, id: number, ms: number): Promise<'away'> {
  for (let left = ms; left > 0; left -= SLICE)
    if (!(await $.viaQuestions.away({ id, ms: Math.min(left, SLICE) }))) return new Promise<never>(() => {})
  return 'away'
}

export function awayWait(w: Asking, id: number, ms: number, after: (ms: number, wake: () => void) => Timer): Promise<boolean> {
  const pending = w.asking.get(id)
  if (pending === undefined) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timer = after(ms, () => resolve(true))
    void pending.done.then(() => {
      timer.cancel()
      resolve(false)
    })
  })
}

async function dialog($: Pick<EngineInterface, 'ui'>, w: Asking, questions: Shown[], stop: AbortSignal): Promise<Pending['result']> {
  let settle!: () => void
  w.asked += 1
  const pending: Pending = { id: w.asked, questions, stop, done: new Promise((resolve) => (settle = resolve)) }
  w.asking.set(pending.id, pending)
  const [first] = questions
  try {
    if (first !== undefined)
      await $.ui
        .ask(first.question, {
          options: first.options.map((o) => o.label),
          header: first.header,
          ...(first.multiSelect ? { multiSelect: true as const } : {}),
        })
        .catch(() => undefined)
  } finally {
    w.asking.delete(pending.id)
    settle()
  }
  return pending.result
}

type Outcome = { reply: Reply } | { hand: { why: string; handed: Asked[]; content: Record<string, unknown> } }
const NO_ONE = 'no one can be asked in this session'
const ASKS = 3

async function fromPerson($: Pick<EngineInterface, 'ui'>, w: Asking, plan: Plan, stop: AbortSignal): Promise<Outcome> {
  if (!w.interactive) return plan.offer ? { hand: { why: NO_ONE, handed: plan.asked, content: {} } } : { reply: CANCEL }
  let note = ''
  for (let tries = 0; ; tries += 1) {
    if (tries === ASKS || stop.aborted) return { reply: CANCEL }
    const questions = shownOf(plan, note)
    const got = await dialog($, w, questions, stop)
    if (got === undefined) return { reply: CANCEL }
    if ('away' in got)
      return plan.offer
        ? { hand: { why: `the person didn't answer within ${duration(got.away)}`, handed: plan.asked, content: {} } }
        : { reply: CANCEL }
    const read = readAnswers(plan, got.answers, questions)
    if (read.declined) return { reply: { action: 'decline' } }
    if (read.errors.length > 0) {
      note = read.errors.join(' ')
      continue
    }
    if (read.handed.length > 0) return { hand: { why: `the person chose "${LET_CLAUDE}"`, handed: read.handed, content: read.content } }
    return { reply: { action: 'accept', content: read.content } }
  }
}

const isQuestion = (q: unknown): q is Question =>
  isRecord(q) && typeof q.id === 'string' && typeof q.message === 'string' && (q.mode === 'form' || q.mode === 'url')

export async function answerQuestion(
  $: Pick<EngineInterface, 'fs' | 'ui' | 'agent'>,
  w: Pick<World, 'calls' | 'inboxes' | 'jobs' | 'handed' | 'records'> & Asking,
  toolUseId: string,
  question: unknown,
  form: (question: Question) => Promise<{ result?: unknown } | { deny: string }>,
): Promise<{ result: string }> {
  const ref = w.calls.get(toolUseId)
  w.calls.delete(toolUseId)
  const inbox = ref === undefined ? undefined : w.inboxes.get(ref.agentId)
  const harness = (ref && w.records.get(ref.agentId)?.harness) || inbox?.name || 'harness'
  const offer = ref !== undefined && inbox !== undefined && w.background.has(ref.agentId) && w.jobs.has(ref.agentId)
  const plan = isQuestion(question) ? planOf(question, harness, offer) : undefined
  const settled = new AbortController()
  const closed = ref === undefined ? new Promise<never>(() => {}) : questionClosed(w, ref, settled.signal)
  const asked: Promise<Outcome> =
    plan !== undefined
      ? fromPerson($, w, plan, settled.signal)
      : isQuestion(question)
        ? form(wholeQuestions(question)).then(
            (done) => ({ reply: 'deny' in done ? CANCEL : replyOf(done.result) }),
            () => ({ reply: CANCEL }),
          )
        : Promise.resolve({ reply: CANCEL })
  const done = await Promise.race([asked, closed.then((yes) => (yes ? ('closed' as const) : new Promise<never>(() => {})))])
  settled.abort()
  if (done === 'closed') return { result: CLOSED }
  if ('hand' in done && ref !== undefined && inbox !== undefined) {
    const job = w.jobs.get(ref.agentId)
    const named = await $.agent.list().then(
      (agents) => agents.find((a) => a.id === ref.agentId)?.name,
      () => undefined,
    )
    const to = named || ref.agentId
    if (job === undefined || w.jobs.get(ref.agentId) !== job || job.final !== undefined || job.abort.signal.aborted) {
      await answered($, w.inboxes, ref.agentId, inbox, { question: ref.id, answer: CANCEL })
      return { result: saidOf(CANCEL) }
    }
    const send: Send = {
      kind: 'send',
      to: 'main',
      summary: `${harness} asks you a question`,
      message: handoffText({ harness, to, why: done.hand.why, handed: done.hand.handed }),
      question: ref.id,
    }
    const line = w.handed.get(ref.agentId) ?? []
    line.push({ id: ref.id, inbox, harness, handed: done.hand.handed, content: done.hand.content, send })
    w.handed.set(ref.agentId, line)
    if (line.length === 1) job.held.unshift(send)
    return {
      result: `Handed to the main agent${line.length === 1 ? '' : ', after the question it was already asked'}: ${done.hand.why}.`,
    }
  }
  const reply = 'reply' in done ? done.reply : CANCEL
  if (ref !== undefined && inbox !== undefined) await answered($, w.inboxes, ref.agentId, inbox, { question: ref.id, answer: reply })
  return { result: saidOf(reply) }
}

async function answerHanded(
  $: Pick<EngineInterface, 'fs'>,
  w: Pick<World, 'inboxes' | 'handed' | 'jobs'>,
  agentId: string,
  h: Handed,
  message: string,
) {
  const read = readReply(h.handed, message)
  if (read.errors.length > 0)
    return {
      result: { success: false, message: `Not passed on: ${read.errors.join(' ')} The question is still open; send the answer again.` },
    }
  const reply: Reply = read.declined ? { action: 'decline' } : { action: 'accept', content: { ...h.content, ...read.content } }
  dropHanded(w, w.jobs.get(agentId), agentId, h.id)
  await answered($, w.inboxes, agentId, h.inbox, { question: h.id, answer: reply })
  return { result: { success: true, message: `${saidOf(reply)} for ${h.harness}, which goes on.` } }
}
