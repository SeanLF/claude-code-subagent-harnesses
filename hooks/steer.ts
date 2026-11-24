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

// interrupt: what an `interrupt:` message asked for; the harness aborts its step, and the core runs it next.
// files: the folder beside it where the relay saves what the agent sends as bytes.
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
  // Not $TMPDIR: on Linux it can be the shared /tmp, where another user could plant the
  // folder and write steers or a symlink (fs.write follows links). No usable home: no steering.
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

// Steers are JSON strings; an interrupt line is an object the harness acts on, never a message it reports.
export function undeliveredSteers(inbox: Inbox | undefined, steered: number): string[] {
  const steers = (inbox?.lines ?? [])
    .map((line) => JSON.parse(line) as InboxLine)
    .filter((value): value is string => typeof value === 'string')
  // The first user message the harness reports is the prompt; each later one is a steer it took.
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
  // An idle-notice subscription is the engine's to keep, so the call goes on to it.
  if (agentId === undefined || inbox === undefined || message === undefined || e.notify_when_idle) return next(e)
  // While a question of its harness's waits on the main agent, the main agent's message to it is the answer; an
  // interrupt, or another agent's message, is not.
  const handed = w.handed.get(agentId)?.[0]
  // A question handed from a run this inbox replaced: nothing waits on its answer.
  if (handed !== undefined && handed.inbox !== inbox) w.handed.delete(agentId)
  // Only a question the main agent was sent: one still waiting its turn has not been asked of it.
  else if (handed?.sent && e.agentId === undefined && !INTERRUPT.test(message)) return answerHanded($, w, agentId, handed, message)
  const interrupted = await steer($, inbox, message)
  return { result: { success: true, message: interrupted ? interruptDelivered(inbox.name) : steerDelivered(inbox.name) } }
}

// A message for a running harness, into its inbox: a steer, or with `interrupt:` an interrupt, whose
// message runs next. True for an interrupt.
export async function steer($: Pick<EngineInterface, 'fs'>, inbox: Inbox, message: string): Promise<boolean> {
  const asked = INTERRUPT.test(message) ? message.replace(INTERRUPT, '') : undefined
  const line: InboxLine = asked === undefined ? message : { interrupt: asked }
  const lines = [...inbox.lines, JSON.stringify(line)]
  // Taken before the write: a typed message and a SendMessage at once would otherwise drop one another.
  inbox.lines = lines
  await $.fs.write(inbox.path, lines.map((line) => `${line}\n`).join(''))
  if (asked === undefined) return false
  inbox.interrupt = inbox.interrupt === undefined ? asked : `${inbox.interrupt}\n\n${asked}`
  return true
}

// What the person typed into an agent's view while it ran, from the attachment Claude Code delivers at
// the agent's next step ("The user sent a new message while you were working: ..."); '' when the framing
// is not that one, never a guess: other deliveries share the attachment.
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
// The whole command, as it will run: line breaks shown, never clipped, and control, bidirectional and
// zero-width characters dropped, so what the dialog shows cannot be disguised.
const shown = (text: string) => unhidden(text.replace(/\r?\n/g, ' ⏎ ')).trim()

// A harness waiting on the person's permission: notify them, ask in Claude Code's own dialog with the
// harness's own option names, and write the chosen option to the inbox. A dismissed dialog, a -p run
// (no one to ask), free text or an AFK auto-resolve is a deny. An answer that arrives after its run
// ended writes nothing: that inbox is no longer the live one.
export async function answerAsk(
  $: Pick<EngineInterface, 'ui' | 'fs'>,
  inboxes: Map<string, Inbox>,
  agentId: string,
  inbox: Inbox | undefined,
  ask: Ask,
  name: string,
): Promise<void> {
  if (inbox === undefined) return
  // Only this once: an "always" option can amend the harness's own rules, which outlive via's run.
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

// An answer into the inbox it was asked from: not into one a later run opened in its place.
async function answered($: Pick<EngineInterface, 'fs'>, inboxes: Map<string, Inbox>, agentId: string, inbox: Inbox, line: InboxLine) {
  if (inboxes.get(agentId) !== inbox) return
  inbox.lines = [...inbox.lines, JSON.stringify(line)]
  await $.fs.write(inbox.path, inbox.lines.map((l) => `${l}\n`).join('')).catch(() => {})
}

// What the person did with a question: MCP's elicitation result, as Claude Code's form returns it.
type Reply = { action: 'accept'; content: Record<string, unknown> } | { action: 'decline' } | { action: 'cancel' }
const CANCEL: Reply = { action: 'cancel' }

// The step server's answer, as a tool.call hook reads an MCP tool's result: its content blocks, the first a text
// block holding the reply as JSON. Anything else is a cancel.
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

// A dialog via opens with $.ui.ask, which takes one question and resolves with a label alone: via's own hook on
// that AskUserQuestion call (showQuestions) shows these questions in its place and keeps the whole result.
// stop: the harness closed the question, so the dialog goes. result: the answers, or how long the person was away.
export type Pending = {
  id: number
  questions: Shown[]
  stop: AbortSignal
  taken?: true
  result?: { answers: Readonly<Record<string, unknown>> } | { away: number }
  done: Promise<void>
}
// interactive: a person is at the prompt (not -p, not the SDK). background: via agents running in the background,
// whose questions can go to the main agent while they wait; a foreground one's message would reach it only once
// the agent's turn ends.
export type Asking = { asking: Map<number, Pending>; asked: number; interactive: boolean; background: Set<string> }
// A question handed to the main agent: the questions it answers, and what the person already answered.
// send: the message that hands it over, sent when it reaches the front of the line; sent, once it has gone.
export type Handed = {
  id: string
  inbox: Inbox
  harness: string
  handed: Asked[]
  content: Record<string, unknown>
  send: Send
  sent?: true
}

// The person's askUserQuestionTimeout setting. Claude Code's own idle timer leaves a plugin's dialog alone
// (seen live on 2.1.331: a "60s" dialog was still up after two minutes), so via times it, from when it opens.
const AWAY: Readonly<Record<string, number>> = { '60s': 60_000, '5m': 300_000, '10m': 600_000 }
async function awayAfter($: Pick<EngineInterface, 'settings'>): Promise<number | undefined> {
  const set = await $.settings.read({ key: 'askUserQuestionTimeout' }).catch(() => undefined)
  return typeof set === 'string' ? AWAY[set] : undefined
}
const duration = (ms: number) =>
  ms % 60_000 === 0 ? `${ms / 60_000} minute${ms === 60_000 ? '' : 's'}` : `${Math.round(ms / 1000)} seconds`

type AskHook = MatchedHook<'tool.call', { tool: 'AskUserQuestion' }>
// The hook on AskUserQuestion: a dialog of via's shows its questions, and is dismissed when the person's timeout
// passes or the harness closes the question. Any other dialog goes on as it was.
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
  // Answering the call first dismisses the dialog. afkTimeoutMs is Claude Code's own field, refused from a hook, so
  // the timeout passing is kept on the pending dialog alone.
  if (done === 'away' && ms !== undefined) pending.result = { away: ms }
  if (done === 'stopped' || done === 'away') return { result: { questions: pending.questions, answers: {} } }
  const result = done.deny === undefined && isRecord(done.result) ? done.result : undefined
  // Claude Code's own idle timer, should it ever cover this dialog.
  if (typeof result?.afkTimeoutMs === 'number') pending.result = { away: result.afkTimeoutMs }
  else if (isRecord(result?.answers)) pending.result = { answers: result.answers }
  return done
}

// The person's timeout, waited in slices: the engine answers a noun within ten seconds (seen live: a whole minute's
// wait failed the hook at 10 s). Never settles once the dialog has.
const SLICE = 5_000
async function timeout($: Pick<EngineInterface, 'viaQuestions'>, id: number, ms: number): Promise<'away'> {
  for (let left = ms; left > 0; left -= SLICE)
    if (!(await $.viaQuestions.away({ id, ms: Math.min(left, SLICE) }))) return new Promise<never>(() => {})
  return 'away'
}

// The engine's wait for one slice of the person's timeout: true when it passes, false once the dialog settled first.
// Inside the engine, as a hook's own wait is charged to its ten-second budget.
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

// One dialog: the questions, through $.ui.ask and showQuestions. undefined: dismissed, or the call failed.
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

// The person's answer in Claude Code's AskUserQuestion dialog, asked again with what was wrong while it doesn't fit
// the form. "Let Claude answer", the person's timeout passing, or no one to ask hands the question to the main agent,
// where that's offered; otherwise the last two are a cancel.
async function fromPerson($: Pick<EngineInterface, 'ui'>, w: Asking, plan: Plan, stop: AbortSignal): Promise<Outcome> {
  if (!w.interactive) return plan.offer ? { hand: { why: NO_ONE, handed: plan.asked, content: {} } } : { reply: CANCEL }
  let note = ''
  for (let tries = 0; ; tries += 1) {
    // An answer that still doesn't fit after a few asks is no answer.
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

// The tool.call hook on a step call that asks the person. A question Claude Code's AskUserQuestion dialog can show
// is asked there; any other (a link to open, a form that doesn't map) goes through to the step server, which asks
// in Claude Code's MCP form. The reply goes back to the harness through the inbox; no answer, a cancel. A question
// handed to the main agent goes to it as a SendMessage from this agent, the step's next call, and its answer comes
// back through sendMessage. A question the harness closes first (an interrupt, or it withdrew it) ends the wait: the
// relay has cancelled it, and a later answer would go nowhere.
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
    // The run may have ended while the name was looked up: then nothing waits on the answer.
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
    // The step's next call, ahead of whatever the run said meanwhile. One open with the main agent at a time, so
    // its answer is read onto the question it was asked; a later one goes when that one is answered or closed.
    if (line.length === 1) job.held.unshift(send)
    return {
      result: `Handed to the main agent${line.length === 1 ? '' : ', after the question it was already asked'}: ${done.hand.why}.`,
    }
  }
  const reply = 'reply' in done ? done.reply : CANCEL
  if (ref !== undefined && inbox !== undefined) await answered($, w.inboxes, ref.agentId, inbox, { question: ref.id, answer: reply })
  return { result: saidOf(reply) }
}

// The main agent's message to an agent whose question it was handed: the answer, onto the harness's form. A message
// that doesn't fit is refused with why, the question still open.
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
