import type { TurnStepChunk, TurnStepResult } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import { relayEvents } from '../hooks/acp/events'
import type { Norm } from '../hooks/acp/norm'
import { answerCall, CHILD_CALL, type Job, type Mark, pump } from '../hooks/acp/steps'
import { type Children, childRun, closeChildren, route, woken } from '../hooks/children'
import { agentStore, NODE, run, STEP } from './helpers'

// Captured 2026-10-28 from relay/relay.mjs over codex-acp 2.3.1-preview.8 (codex-cli 0.165.0, gpt-6-luna),
// asked to spawn one subagent: the standard subagent_update flow of ACP's subagents RFD, trimmed.
const ROOT = '01a18155-81d4-7ba0-8246-5cba1d8adb3b'
const CHILD = `${ROOT}:subagent:01a18155-8b4f-7403-bb8f-f472976c48cd`
const MODEL = {
  configOptions: [{ currentValue: 'gpt-6-luna', type: 'select', id: 'model', name: 'Model', category: 'model', options: [] }],
}
const CAPTURED = [
  { relay: 'session', sessionId: ROOT, cwd: '/repo' },
  { relay: 'steered' },
  { sessionId: ROOT, update: { sessionId: CHILD, title: 'List acp', capabilities: {}, sessionUpdate: 'subagent_update' } },
  { sessionId: CHILD, update: { ...MODEL, sessionUpdate: 'config_option_update' } },
  { sessionId: ROOT, update: { sessionId: CHILD, state: { state: 'running' }, sessionUpdate: 'subagent_update' } },
  { sessionId: ROOT, update: { used: 21285, size: 258400, sessionUpdate: 'usage_update' } },
  { sessionId: ROOT, update: { toolCallId: 'w', title: 'wait', kind: 'other', status: 'in_progress', sessionUpdate: 'tool_call' } },
  {
    sessionId: CHILD,
    update: { toolCallId: 'x', title: "List files in 'acp'", kind: 'read', status: 'in_progress', sessionUpdate: 'tool_call' },
  },
  {
    sessionId: CHILD,
    update: {
      toolCallId: 'x',
      status: 'completed',
      rawOutput: { exit_code: 0 },
      _meta: { terminal_output_delta: { data: 'steps.ts\n' } },
      sessionUpdate: 'tool_call_update',
    },
  },
  { sessionId: CHILD, update: { used: 23763, size: 258400, sessionUpdate: 'usage_update' } },
  { sessionId: CHILD, update: { content: { text: 'steps.ts', type: 'text' }, messageId: 'm1', sessionUpdate: 'agent_message_chunk' } },
  { sessionId: ROOT, update: { sessionId: CHILD, state: { stopReason: 'end_turn', state: 'idle' }, sessionUpdate: 'subagent_update' } },
  { sessionId: ROOT, update: { toolCallId: 'w', status: 'completed', sessionUpdate: 'tool_call_update' } },
  {
    sessionId: ROOT,
    update: { content: { text: 'It found steps.ts.', type: 'text' }, messageId: 'm2', sessionUpdate: 'agent_message_chunk' },
  },
]

test("a subagent's session is parsed apart: its rows, model and message, never the run's answer or context", () => {
  const parse = relayEvents()
  const norms = CAPTURED.flatMap((line) => parse(JSON.stringify(line)))
  expect(norms.filter((n) => n.k === 'child')).toEqual([
    { k: 'child', id: CHILD, parent: ROOT, title: 'List acp' },
    { k: 'child', id: CHILD, parent: ROOT, state: 'running' },
    { k: 'child', id: CHILD, parent: ROOT, state: 'idle' },
  ])
  expect(norms.filter((n) => n.k === 'of').map((n) => (n.k === 'of' ? n.norm : n))).toEqual([
    { k: 'model', name: 'gpt-6-luna' },
    { k: 'call', id: 'x', kind: 'read', title: "List files in 'acp'" },
    { k: 'called', id: 'x', output: 'steps.ts', failed: false },
    { k: 'message' },
    { k: 'text', t: 'steps.ts' },
  ])
  // The run's own: its wait row, its context, and only its own message as the answer.
  expect(norms.filter((n) => n.k === 'usage')).toEqual([{ k: 'usage', usage: { input: 21285, cacheRead: 0, cacheWrite: 0, output: 0 } }])
  expect(norms.filter((n) => n.k === 'text')).toEqual([{ k: 'text', t: 'It found steps.ts.' }])
})

test('a failed subagent says why', () => {
  const parse = relayEvents()
  parse(JSON.stringify(CAPTURED[0]))
  parse(JSON.stringify(CAPTURED[1]))
  const failed = { stopReason: 'error', state: 'idle', error: { code: -32000, message: 'Authentication required' } }
  expect(parse(JSON.stringify({ sessionId: ROOT, update: { sessionId: CHILD, state: failed, sessionUpdate: 'subagent_update' } }))).toEqual(
    [{ k: 'child', id: CHILD, parent: ROOT, state: 'idle', failure: 'Authentication required' }],
  )
})

test('a refused or limit-stopped subagent says why, by the same mapping as the run; a cancelled one says so', () => {
  const parse = relayEvents()
  parse(JSON.stringify(CAPTURED[0]))
  parse(JSON.stringify(CAPTURED[1]))
  const idle = (stopReason: string) =>
    parse(
      JSON.stringify({
        sessionId: ROOT,
        update: { sessionId: CHILD, state: { state: 'idle', stopReason }, sessionUpdate: 'subagent_update' },
      }),
    )
  const child = { k: 'child', id: CHILD, parent: ROOT, state: 'idle' }
  expect(idle('refusal')).toEqual([{ ...child, failure: "it refused this request, and its next turn won't include this message" }])
  expect(idle('max_tokens')).toEqual([{ ...child, failure: 'its reply reached the output token limit' }])
  expect(idle('max_turn_requests')).toEqual([{ ...child, failure: 'it reached its limit of model requests for this turn' }])
  expect(idle('cancelled')).toEqual([{ ...child, cancelled: true }])
  expect(idle('end_turn')).toEqual([child])
})

// A parser past its first prompt, and the session_message updates of ACP's subagents RFD. A message is said once
// its own session moves on: until then it may still grow, or its other view arrive.
function messages() {
  const parse = relayEvents()
  parse(JSON.stringify(CAPTURED[0]))
  parse(JSON.stringify(CAPTURED[1]))
  const send = (sessionUpdate: string, sessionId: string, update: Record<string, unknown>) =>
    parse(JSON.stringify({ sessionId, update: { sessionUpdate, ...update } }))
  return {
    message: (sessionId: string, update: Record<string, unknown>) => send('session_message', sessionId, update),
    chunk: (sessionId: string, messageId: string, t: string) =>
      send('session_message_chunk', sessionId, { messageId, content: { type: 'text', text: t } }),
    // Any other update, on the run's own session unless named; only what it says of messages. parse: any line.
    moved: Object.assign(
      (sessionId = ROOT) =>
        send('usage_update', sessionId, { used: 1, size: 10 }).filter((n) => n.k === 'told' || (n.k === 'of' && n.norm.k === 'told')),
      { parse: (line: unknown) => parse(JSON.stringify(line)) },
    ),
  }
}
const text = (t: string) => [{ type: 'text', text: t }]
const toldChild = (t: string) => ({ k: 'of', child: CHILD, norm: { k: 'told', t } })

test('a message to a subagent is said once the run moves on; with both its views waiting, as the child received it', () => {
  const { message, moved } = messages()
  expect(message(ROOT, { messageId: 'out1', senderSessionId: ROOT, recipientSessionId: CHILD, content: text('Before delivery') })).toEqual(
    [],
  )
  expect(
    message(CHILD, {
      messageId: 'in1',
      senderSessionId: ROOT,
      senderMessageId: 'out1',
      recipientSessionId: CHILD,
      content: text('As received'),
    }),
  ).toEqual([])
  // The parent's session moving on says nothing yet: the child's view waits.
  expect(moved()).toEqual([])
  expect(moved(CHILD)).toEqual([toldChild('As received')])
  expect([...moved(), ...moved(CHILD)]).toEqual([])
})

test("a message's other view is never said again, however the two are linked and whichever came first", () => {
  const { message, moved } = messages()
  // Outgoing first and said; the incoming view unlinked, then a link-only update on the outgoing one.
  message(ROOT, { messageId: 'out1', senderSessionId: ROOT, recipientSessionId: CHILD, content: text('Search acp.') })
  expect(moved()).toEqual([toldChild('Search acp.')])
  message(CHILD, { messageId: 'in1', recipientSessionId: CHILD, content: text('Search acp.') })
  message(ROOT, { messageId: 'out1', recipientMessageId: 'in1' })
  expect([...moved(), ...moved(CHILD)]).toEqual([])
  // Incoming first and said, naming the outgoing view, which then comes unlinked.
  message(CHILD, { messageId: 'in2', senderSessionId: ROOT, senderMessageId: 'out2', recipientSessionId: CHILD, content: text('Go on.') })
  expect(moved(CHILD)).toEqual([toldChild('Go on.')])
  message(ROOT, { messageId: 'out2', senderSessionId: ROOT, recipientSessionId: CHILD, content: text('Go on.') })
  expect(moved()).toEqual([])
})

test("a message's later upserts and chunks are kept, as the RFD's patch rules say", () => {
  const { message, chunk, moved } = messages()
  // Empty, then its content.
  message(ROOT, { messageId: 'out1', senderSessionId: ROOT, recipientSessionId: CHILD, content: [] })
  message(ROOT, { messageId: 'out1', content: text('Reply with the word KESTREL.') })
  expect(moved()).toEqual([toldChild('Reply with the word KESTREL.')])
  // Its recipient named on a first, contentless upsert, and left out of the one with content.
  message(ROOT, { messageId: 'out2', senderSessionId: ROOT, recipientSessionId: CHILD })
  message(ROOT, { messageId: 'out2', content: text('Then OSPREY.') })
  expect(moved()).toEqual([toldChild('Then OSPREY.')])
  // Streamed into the child's view, its participants after the chunks.
  chunk(CHILD, 'in3', 'Start by ')
  chunk(CHILD, 'in3', 'reproducing it.')
  message(CHILD, { messageId: 'in3', senderSessionId: ROOT, recipientSessionId: CHILD })
  expect(moved(CHILD)).toEqual([toldChild('Start by reproducing it.')])
})

test("a message is said once its own session moves on, so another session's update between its chunks cuts nothing", () => {
  const { message, chunk, moved } = messages()
  message(CHILD, { messageId: 'in1', senderSessionId: ROOT, recipientSessionId: CHILD })
  chunk(CHILD, 'in1', 'Start by ')
  expect(moved(`${ROOT}:subagent:other`)).toEqual([])
  chunk(CHILD, 'in1', 'reproducing it.')
  expect(moved()).toEqual([])
  expect(moved(CHILD)).toEqual([toldChild('Start by reproducing it.')])
})

test("a task reported only from its sender's side is said before the child's first work", () => {
  const { message, moved } = messages()
  message(ROOT, { messageId: 'out1', senderSessionId: ROOT, recipientSessionId: CHILD, content: text('Investigate X.') })
  expect(moved(CHILD)).toEqual([toldChild('Investigate X.')])
})

test("a permission request or a steer between a message's chunks cuts nothing; only the prompt's end says what waits", () => {
  const { message, chunk, moved } = messages()
  const parse = (line: unknown) => moved.parse(line).filter((n) => n.k === 'told' || (n.k === 'of' && n.norm.k === 'told'))
  message(CHILD, { messageId: 'in1', senderSessionId: ROOT, recipientSessionId: CHILD })
  chunk(CHILD, 'in1', 'Start by ')
  const ask = { relay: 'ask', id: 'p1', title: 'Run ls', kind: 'execute', options: [] }
  expect(parse(ask)).toEqual([])
  // A steer codex-acp takes mid-turn is no prompt's end either.
  expect(parse({ relay: 'steered' })).toEqual([])
  chunk(CHILD, 'in1', 'reproducing it.')
  expect(parse({ relay: 'prompt_done', stopReason: 'end_turn' })).toEqual([toldChild('Start by reproducing it.')])
})

test('a message its sender has not yet addressed waits for its recipient, never said as one it received', () => {
  const { message, moved } = messages()
  message(ROOT, { messageId: 'out1', senderSessionId: ROOT, content: text('Investigate X.') })
  expect(moved()).toEqual([])
  message(ROOT, { messageId: 'out1', recipientSessionId: CHILD })
  expect(moved()).toEqual([toldChild('Investigate X.')])
})

test("a message to the run's own session, from its subagent or another session, is said in the run's view", () => {
  const { message, moved } = messages()
  message(ROOT, { messageId: 'in1', senderSessionId: CHILD, recipientSessionId: ROOT, content: text('Found it.') })
  expect(moved()).toEqual([{ k: 'told', t: 'Found it.' }])
})

const world = (): Children => ({ channels: new Map(), nested: new Map(), parents: new Map() })
const of = (child: string, norm: Norm): Extract<Norm, { k: 'of' }> => ({ k: 'of', child, norm })

test("a child's thinking and plan reach its view, but its context stays apart", () => {
  const parse = relayEvents()
  parse(JSON.stringify(CAPTURED[0]))
  parse(JSON.stringify(CAPTURED[1]))
  const updates = [
    { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Checking the call sites.' } },
    { sessionUpdate: 'plan', entries: [{ content: 'Read the code', status: 'in_progress', priority: 'medium' }] },
    { sessionUpdate: 'usage_update', used: 40, size: 100 },
  ]
  expect(updates.flatMap((update) => parse(JSON.stringify({ sessionId: CHILD, update })))).toEqual([
    of(CHILD, { k: 'thinking', t: 'Checking the call sites.' }),
    of(CHILD, { k: 'plan', entries: [{ content: 'Read the code', status: 'in_progress' }] }),
  ])
})

test("a child's progress and step rows stream before its final message", async () => {
  const w = world()
  route(w, 'a1', 'via:codex', { k: 'child', id: 'c', parent: 'root', title: 'Read code' })
  w.nested.set('n1', 'a1/c#1')
  const send = (norm: Norm) => route(w, 'a1', 'via:codex', of('c', norm))
  send({ k: 'thinking', t: 'Checking the call sites.' })
  const plan: Norm = { k: 'plan', entries: [{ content: 'Read the code', status: 'in_progress' }] }
  send(plan)
  send(plan) // Repeated plan snapshots do not add rows.
  send({ k: 'message' })
  send({ k: 'text', t: 'Reading the implementation.' })
  send({ k: 'call', id: 'read', kind: 'read', title: 'Read hooks/children.ts' })
  send({ k: 'called', id: 'read', output: 'source', failed: false })
  const job: Job = {
    turnId: 't1',
    gen: childRun(w, 'n1', 'codex', { turnId: 't1', index: 0 }, new AbortController().signal, false, () => new Promise(() => {})),
    held: [],
    outputs: new Map(),
    abort: new AbortController(),
    count: 0,
  }
  const steps = {
    ...w,
    tool: 'mcp__plugin_via_step__step',
    jobs: new Map([['n1', job]]),
    calls: new Map(),
    spawns: new Map(),
    handed: new Map(),
  }
  const step = { turnId: 't1', index: 0, agentId: 'n1' }
  const signal = new AbortController().signal
  const wait = () => new Promise<void>(() => {})
  const first = await drain(pump(steps, job, step, signal, wait))
  expect(first.out[0]).toEqual({ kind: 'thinking', index: 0, text: 'Checking the call sites.' })
  expect(first.result.toolUses[0]?.input).toEqual({ kind: 'plan', title: 'Plan' })
  const planCall = first.out.find((c) => c.kind === 'tool')
  expect(await answerCall(steps, planCall?.kind === 'tool' ? planCall.id : undefined, signal, wait)).toEqual({ result: '◐ Read the code' })
  const second = await drain(pump(steps, job, { ...step, index: 1 }, signal, wait))
  expect(second.out[0]).toEqual({ kind: 'text', index: 0, text: 'Reading the implementation.' })
  expect(second.result.toolUses[0]?.input).toEqual({ kind: 'read', title: 'Read hooks/children.ts' })
  const readCall = second.out.find((c) => c.kind === 'tool')
  expect(await answerCall(steps, readCall?.kind === 'tool' ? readCall.id : undefined, signal, wait)).toEqual({ result: 'source' })
  // Still live throughout both steps. Only the next message and idle event finish the child.
  expect(w.channels.get('a1/c#1')?.ended).toBe(false)
  send({ k: 'message' })
  send({ k: 'text', t: 'The implementation is correct.' })
  route(w, 'a1', 'via:codex', { k: 'child', id: 'c', parent: 'root', state: 'idle' })
  const final = await drain(pump(steps, job, { ...step, index: 2 }, signal, wait))
  expect(final.result.answer).toBe('The implementation is correct.\n\n— answered by codex subagent')
  expect(final.result.stopReason).toBe('end_turn')
})

test("a child's consecutive messages have separate text blocks and only the last is its answer", async () => {
  const w = world()
  route(w, 'a1', 'via:codex', { k: 'child', id: 'c', parent: 'root', title: 'Read code' })
  for (const t of ['Reading the code.', 'The code is correct.']) {
    route(w, 'a1', 'via:codex', of('c', { k: 'message' }))
    route(w, 'a1', 'via:codex', of('c', { k: 'text', t }))
  }
  route(w, 'a1', 'via:codex', { k: 'child', id: 'c', parent: 'root', state: 'idle' })
  w.nested.set('n1', 'a1/c#1')
  const { out, result } = await drain(
    childRun(w, 'n1', 'codex', { turnId: 't1', index: 0 }, new AbortController().signal, false, () => new Promise(() => {})),
  )
  expect(out.slice(0, 2)).toEqual([
    { kind: 'text', index: 0, text: 'Reading the code.' },
    { kind: 'text', index: 1, text: 'The code is correct.' },
  ])
  expect(result.answer).toBe('The code is correct.\n\n— answered by codex subagent')
})

async function drain(gen: AsyncGenerator<TurnStepChunk | Mark, TurnStepResult>) {
  const out: (TurnStepChunk | Mark)[] = []
  for (;;) {
    const r = await gen.next()
    if (r.done) return { out, result: r.value }
    out.push(r.value)
  }
}

test("a subagent's first work spawns its nested agent once, and its nested agent shows its rows then its signed answer", async () => {
  const w = world()
  // Its announcement and model are not work: it waits for a task to show as its prompt.
  expect(route(w, 'a1', 'via:codex', { k: 'child', id: 'c', parent: 'root', title: 'List acp' })).toEqual([])
  expect(route(w, 'a1', 'via:codex', of('c', { k: 'model', name: 'gpt-6-luna' }))).toEqual([])
  expect(route(w, 'a1', 'via:codex', of('c', { k: 'call', id: 'x', kind: 'read', title: 'List files' }))).toEqual([
    { kind: 'spawn', child: 'a1/c#1', type: 'via:codex', title: 'List acp' },
  ])
  route(w, 'a1', 'via:codex', of('c', { k: 'called', id: 'x', output: 'steps.ts', failed: false }))
  route(w, 'a1', 'via:codex', of('c', { k: 'text', t: 'steps.ts' }))
  route(w, 'a1', 'via:codex', { k: 'child', id: 'c', parent: 'root', state: 'idle' })
  w.nested.set('n1', 'a1/c#1')
  const { out, result } = await drain(
    childRun(w, 'n1', 'codex', { turnId: 't1', index: 0 }, new AbortController().signal, false, () => new Promise(() => {})),
  )
  expect(out.filter((c) => c.kind === 'call-start' || c.kind === 'call-end')).toEqual([
    { kind: 'call-start', id: 'x', input: { kind: 'read', title: 'List files' }, usage: null },
    { kind: 'call-end', id: 'x', output: 'steps.ts', failed: false },
  ])
  expect(result.answer).toBe('steps.ts\n\n— answered by codex subagent, gpt-6-luna')
  // Seen live 2026-10-28: codex-acp clears the child's cancel capability after it goes idle. A patch
  // is not a new child; only the parent's end lets the child go.
  expect(route(w, 'a1', 'via:codex', { k: 'child', id: 'c', parent: 'root' })).toEqual([])
  expect(route(w, 'a1', 'via:codex', of('c', { k: 'model', name: 'gpt-6-luna' }))).toEqual([])
  closeChildren(w, 'a1')
  expect(w.channels.size).toBe(0)
})

// A child that wrote part of a reply, then ended as the parse of its idle state says.
async function endedWith(end: { failure?: string; cancelled?: boolean }) {
  const w = world()
  route(w, 'a1', 'via:codex', { k: 'child', id: 'c', parent: 'root', title: 'List acp' })
  route(w, 'a1', 'via:codex', of('c', { k: 'model', name: 'gpt-6-luna' }))
  route(w, 'a1', 'via:codex', of('c', { k: 'text', t: 'steps.ts' }))
  route(w, 'a1', 'via:codex', { k: 'child', id: 'c', parent: 'root', state: 'idle', ...end })
  w.nested.set('n1', 'a1/c#1')
  const gen = childRun(w, 'n1', 'codex', { turnId: 't1', index: 0 }, new AbortController().signal, false, () => new Promise(() => {}))
  return (await drain(gen)).result.answer
}

test('a refused nested child keeps its text and says why, never a signature', async () => {
  expect(await endedWith({ failure: "it refused this request, and its next turn won't include this message" })).toBe(
    "steps.ts\n\nThe codex subagent failed: it refused this request, and its next turn won't include this message",
  )
})

test('a cancelled nested child keeps its text and says it was cancelled, not that it failed or answered', async () => {
  expect(await endedWith({ cancelled: true })).toBe('steps.ts\n\nThe codex subagent was cancelled before it finished.')
})

test('work after a subagent went idle is a new nested agent with the same title', () => {
  const w = world()
  route(w, 'a1', 'via:codex', { k: 'child', id: 'c', parent: 'root', title: 'List acp' })
  route(w, 'a1', 'via:codex', { k: 'child', id: 'c', parent: 'root', state: 'idle' })
  expect(route(w, 'a1', 'via:codex', { k: 'child', id: 'c', parent: 'root', state: 'running' })).toEqual([])
  // Found by review: each assignment keeps its own queue, so two nested agents never split one.
  expect(route(w, 'a1', 'via:codex', of('c', { k: 'text', t: 'second' }))).toEqual([
    { kind: 'spawn', child: 'a1/c#2', type: 'via:codex', title: 'List acp' },
  ])
  expect(w.channels.get('a1/c#1')?.queue).toEqual([{ k: 'end' }])
  expect(w.channels.get('a1/c#2')?.queue).toEqual([{ k: 'text', t: 'second' }])
})

test("a subagent with no announcement (codex-acp 2.3.0's own form) still gets a nested agent, ended by its parent's run", async () => {
  const w = world()
  expect(route(w, 'a1', 'via:codex', of('c', { k: 'text', t: 'done' }))).toEqual([
    { kind: 'spawn', child: 'a1/c#1', type: 'via:codex', title: 'subagent' },
  ])
  // The parent's run ends before the nested agent's first step: its queue waits for it.
  closeChildren(w, 'a1')
  w.nested.set('n1', 'a1/c#1')
  const { result } = await drain(
    childRun(w, 'n1', 'codex', { turnId: 't1', index: 0 }, new AbortController().signal, true, () => new Promise(() => {})),
  )
  expect(result.toolUses[0]?.name).toBe('SubagentHandback')
  expect(JSON.stringify(result.toolUses[0]?.input)).toContain('done')
})

test("a subagent's own subagent is spawned by its nested agent, not the run's", async () => {
  const w = world()
  route(w, 'a1', 'via:codex', { k: 'child', id: 'c', parent: 'root', title: 'outer' })
  route(w, 'a1', 'via:codex', of('c', { k: 'told', t: 'Delegate the search.' }))
  route(w, 'a1', 'via:codex', { k: 'child', id: 'g', parent: 'c', title: 'inner' })
  expect(route(w, 'a1', 'via:codex', of('g', { k: 'told', t: 'Search acp.' }))).toEqual([])
  route(w, 'a1', 'via:codex', { k: 'child', id: 'c', parent: 'root', state: 'idle' })
  w.nested.set('n1', 'a1/c#1')
  const { out } = await drain(
    childRun(w, 'n1', 'codex', { turnId: 't1', index: 0 }, new AbortController().signal, false, () => new Promise(() => {})),
  )
  expect(out.filter((c) => c.kind === 'spawn')).toEqual([
    { kind: 'spawn', child: 'a1/g#1', type: 'via:codex', title: 'inner', prompt: 'Search acp.' },
  ])
})

test("a subagent's new assignment keeps the model its session reported", () => {
  const w = world()
  route(w, 'a1', 'via:codex', of('c', { k: 'told', t: 'One.' }))
  route(w, 'a1', 'via:codex', of('c', { k: 'model', name: 'gpt-6-luna' }))
  route(w, 'a1', 'via:codex', { k: 'child', id: 'c', parent: 'root', state: 'idle' })
  route(w, 'a1', 'via:codex', of('c', { k: 'told', t: 'Two.' }))
  expect(w.channels.get('a1/c#2')?.model).toBe('gpt-6-luna')
})

test("a subagent's own subagent given new work after its parent's nested agent ended is shown from the run", () => {
  const w = world()
  route(w, 'a1', 'via:codex', { k: 'child', id: 'c', parent: 'root', title: 'outer' })
  route(w, 'a1', 'via:codex', of('c', { k: 'told', t: 'Delegate the search.' }))
  route(w, 'a1', 'via:codex', { k: 'child', id: 'g', parent: 'c', title: 'inner' })
  route(w, 'a1', 'via:codex', of('g', { k: 'told', t: 'Search acp.' }))
  route(w, 'a1', 'via:codex', { k: 'child', id: 'g', parent: 'c', state: 'idle' })
  route(w, 'a1', 'via:codex', { k: 'child', id: 'c', parent: 'root', state: 'idle' })
  // Its nested agent has read its end: nothing reads its queue any more.
  const outer = w.channels.get('a1/c#1')
  if (outer) outer.read = true
  expect(route(w, 'a1', 'via:codex', of('g', { k: 'told', t: 'Search again.' }))).toEqual([
    { kind: 'spawn', child: 'a1/g#2', type: 'via:codex', title: 'inner', prompt: 'Search again.' },
  ])
})

test('a spawn mark ends the step with an Agent call in the background, remembered for its spawn', async () => {
  const gen = (async function* (): AsyncGenerator<TurnStepChunk | Mark, TurnStepResult> {
    yield { kind: 'spawn', child: 'a1/c#1', type: 'via:codex', title: 'List acp' }
    return { turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })()
  const job: Job = { turnId: 't1', gen, held: [], outputs: new Map(), abort: new AbortController(), count: 0 }
  const w = {
    tool: 'mcp__plugin_via_step__step',
    jobs: new Map([['a1', job]]),
    calls: new Map(),
    spawns: new Map<string, string>(),
    handed: new Map(),
  }
  const step = pump(w, job, { turnId: 't1', index: 0, agentId: 'a1' }, new AbortController().signal, () => new Promise(() => {}))
  const chunks: TurnStepChunk[] = []
  let r = await step.next()
  while (!r.done) {
    chunks.push(r.value)
    r = await step.next()
  }
  const input = { description: 'List acp', prompt: 'List acp', subagent_type: 'via:codex', run_in_background: true }
  expect(r.value.toolUses).toEqual([{ name: 'Agent', input }])
  const tool = chunks.find((c) => c.kind === 'tool')
  expect(tool?.kind === 'tool' && tool.name).toBe('Agent')
  const id = tool?.kind === 'tool' ? tool.id : ''
  expect(id.startsWith(CHILD_CALL)).toBe(true)
  expect(w.spawns.get(id)).toBe('a1/c#1')
})

test("a nested agent's end or message to its via parent is a wake, and a prompt beside one still runs", () => {
  const nested = new Map([['n1', { key: 'a1/c#1' }]])
  // Captured 2026-10-28, trimmed: the notification of a nested agent's end, framed as Claude Code frames it.
  const ended = `[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event, NOT a message from the user.\nDo NOT interpret this as user acknowledgement, confirmation, or response to any pending question.\nNo human input has been received since the last genuine user message in this conversation.\n\n<task-notification>\n<tool-use-id>${CHILD_CALL}t1_1</tool-use-id>\n<status>completed</status>\n</task-notification>`
  expect(woken(ended, nested)).toBe('')
  // Sent as the nested agent after its handback, it woke the parent for a second run.
  const note =
    'Another Claude session sent a message while you were working:\n<agent-message from="n1">\n  Note: The server-side auto mode classifier was unavailable.\n</agent-message>\n\nThat "other Claude session" is an agent working inside this same session.'
  expect(woken(note, nested)).toBe('')
  // Found by review: a real prompt batched with a wake is the turn's prompt, not swallowed.
  expect(woken(`${ended}\n\nReview the error handling in src/api.`, nested)).toBe('Review the error handling in src/api.')
  expect(woken('<agent-message from="someone-else">hi</agent-message>', nested)).toBeUndefined()
  expect(woken('<agent-message from="n1" summary="done">ok</agent-message>', nested)).toBe('')
  expect(woken('Review the error handling in src/api.', nested)).toBeUndefined()
})

test('a child answers during a parent tool, whose continuation still delivers its eventual output', async ($, on) => {
  const clock = mock.clock(on)
  agentStore(on, { a1: { harness: 'codex' } })
  mock.env(on, { HOME: '/home/u' })
  on('agent.list', () => ({ value: [{ id: 'a1', description: 'parent', type: 'via:codex', status: 'running' }] }))
  on('session.messages', () => ({ value: [] }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false } }))
  on('fs.write', () => ({ value: undefined }))
  on('process.run', () => ({ value: NODE }))
  on('agent.spawn', (_, e) => ({ agentId: 'n1', model: e.model ?? 'codex' }))
  let requests = 0
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const line = (events: unknown[]) => `${events.map((event) => JSON.stringify(event)).join('\n')}\n`
  on('process.spawn', async function* () {
    requests += 1
    yield { stream: 'stdout', text: line([CAPTURED[0], CAPTURED[1], CAPTURED[6]]) }
    yield {
      stream: 'stdout',
      text: line([
        {
          sessionId: ROOT,
          update: { toolCallId: 'parallel', title: 'parallel', kind: 'execute', status: 'in_progress', sessionUpdate: 'tool_call' },
        },
        ...CAPTURED.slice(2, 5),
        CAPTURED[10],
        CAPTURED[11],
      ]),
    }
    await held
    yield {
      stream: 'stdout',
      text: line([
        {
          sessionId: ROOT,
          update: {
            toolCallId: 'parallel',
            status: 'completed',
            sessionUpdate: 'tool_call_update',
            _meta: { terminal_output_delta: { data: 'parallel output' } },
          },
        },
        {
          sessionId: ROOT,
          update: {
            toolCallId: 'w',
            status: 'completed',
            sessionUpdate: 'tool_call_update',
            _meta: { terminal_output_delta: { data: 'parent output' } },
          },
        },
        CAPTURED[13],
      ]),
    }
    return { value: { code: 0, signal: null } }
  })
  await $.turn.start({ turnId: 'parent', text: 'go', agentId: 'a1' })
  const step = { ...STEP, turnId: 'parent' }
  const first = await run($, step)
  const call = first.chunks.find((chunk) => chunk.kind === 'tool')
  let released = false
  const pending = $.tool
    .call({ tool: call?.kind === 'tool' ? call.name : '', tool_use_id: call?.kind === 'tool' ? call.id : '' } as never)
    .then((result) => {
      released = true
      return result
    })
  await clock.settle()
  const before = released
  let answer = ''
  let continued: unknown
  let continuation: Promise<unknown> | undefined
  try {
    if (before) {
      const spawn = await run($, { ...step, index: 1 })
      const tool = spawn.chunks.find((chunk) => chunk.kind === 'tool')
      expect(tool?.kind === 'tool' && tool.name).toBe('Agent')
      await $.agent.spawn({
        tool_use_id: tool?.kind === 'tool' ? tool.id : '',
        subagentType: 'via:codex',
        prompt: 'List acp',
        description: 'List acp',
        provider: { plugin: 'engine', tier: 'core' },
        parentModel: 'codex',
        parentAgentId: 'a1',
        background: true,
        fork: false,
      })
      const child = run($, { ...STEP, turnId: 'nested', agentId: 'n1' })
      const wait = await run($, { ...step, index: 2 })
      expect(wait.result.toolUses[0]?.input).toEqual({ kind: 'wait', title: 'Waiting for wait' })
      const next = wait.chunks.find((chunk) => chunk.kind === 'tool')
      continuation = $.tool
        .call({ tool: next?.kind === 'tool' ? next.name : '', tool_use_id: next?.kind === 'tool' ? next.id : '' } as never)
        .then((result) => {
          continued = result
          return result
        })
      await clock.settle()
      answer = (await child).result.answer
      expect(continued).toBeUndefined()
    }
  } finally {
    release()
    await pending
    if (continuation) await continuation
  }
  expect(before).toBe(true)
  expect(answer).toBe('steps.ts\n\n— answered by codex subagent, gpt-6-luna')
  expect(continued).toEqual({ result: 'parent output' })
  // An earlier parallel call was held before the spawn: it did not delay the child or lose output.
  const parallel = await run($, { ...step, index: 3 })
  const parallelTool = parallel.chunks.find((chunk) => chunk.kind === 'tool')
  expect(
    await $.tool.call({
      tool: parallelTool?.kind === 'tool' ? parallelTool.name : '',
      tool_use_id: parallelTool?.kind === 'tool' ? parallelTool.id : '',
    } as never),
  ).toEqual({ result: 'parallel output' })
  const last = await run($, { ...step, index: 4 })
  expect(last.result.toolUses).toEqual([])
  expect(last.result.answer).toContain('It found steps.ts.')
  expect(requests).toBe(1)
})
