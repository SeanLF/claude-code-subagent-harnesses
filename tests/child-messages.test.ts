import { expect, mock, type TestBody, test } from 'claude-code/testing'
import { agentInfo, agentStore, NODE, run, runTurn, STEP } from './helpers'

type On = Parameters<TestBody>[1]

const ROOT = '01a1e57c-7bc9-7d4e-a1d2-3b1a6f708960'
const CHILD = `${ROOT}:subagent:01a1e57c-7be1-7ab2-a812-b6e94b843265`
const TASK = 'Reply with only the word KESTREL.'
const FOLLOWUP = 'Now reply with only the word OSPREY.'
const state = (s: Record<string, unknown>) => ({
  sessionId: ROOT,
  update: { sessionId: CHILD, state: s, sessionUpdate: 'subagent_update' },
})
const outgoing = (id: string, text: string) => ({
  sessionId: ROOT,
  update: {
    sessionUpdate: 'session_message',
    messageId: `${id}:to:01a1e57c-7be1-7ab2-a812-b6e94b843265`,
    senderSessionId: ROOT,
    recipientSessionId: CHILD,
    content: [{ type: 'text', text }],
  },
})
const incoming = (id: string, from: string, text: string) => ({
  sessionId: CHILD,
  update: {
    sessionUpdate: 'session_message',
    messageId: id,
    recipientSessionId: CHILD,
    senderSessionId: ROOT,
    senderMessageId: `${from}:to:01a1e57c-7be1-7ab2-a812-b6e94b843265`,
    content: [{ type: 'text', text }],
  },
})
const linked = (from: string, to: string) => ({
  sessionId: ROOT,
  update: { sessionUpdate: 'session_message', messageId: `${from}:to:01a1e57c-7be1-7ab2-a812-b6e94b843265`, recipientMessageId: to },
})
const said = (session: string, id: string, text: string) => ({
  sessionId: session,
  update: { sessionUpdate: 'agent_message_chunk', messageId: id, content: { type: 'text', text } },
})
const RECORDED = [
  { relay: 'session', sessionId: ROOT, cwd: '/repo' },
  { relay: 'steered' },
  { sessionId: ROOT, update: { sessionUpdate: 'subagent_update', sessionId: CHILD, capabilities: {} } },
  outgoing('spawn', TASK),
  state({ state: 'running' }),
  state({ state: 'running' }),
  incoming('01a1e57c-7be7-7e83-92ff-a21316bc8451', 'spawn', TASK),
  linked('spawn', '01a1e57c-7be7-7e83-92ff-a21316bc8451'),
  said(CHILD, 'msg_resp_3', 'KESTREL'),
  state({ state: 'idle', stopReason: 'end_turn' }),
  outgoing('followup', FOLLOWUP),
  state({ state: 'running' }),
  state({ state: 'running' }),
  incoming('01a1e57c-7bf7-77c1-94a3-0c1c265ec10d', 'followup', FOLLOWUP),
  linked('followup', '01a1e57c-7bf7-77c1-94a3-0c1c265ec10d'),
  said(CHILD, 'msg_resp_7', 'OSPREY'),
  state({ state: 'idle', stopReason: 'end_turn' }),
  said(ROOT, 'msg_resp_9', 'DONE'),
  { relay: 'done', stopReason: 'end_turn' },
]

function arrange(on: On, lines: readonly unknown[]) {
  mock.clock(on)
  mock.env(on, { HOME: '/home/u' })
  agentStore(on, { a1: { harness: 'codex' } })
  on('agent.list', () => ({ value: [agentInfo({ id: 'a1', description: 'parent', type: 'via:codex' })] }))
  on('session.messages', () => ({ value: [] }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false } }))
  on('fs.write', () => ({ value: undefined }))
  on('process.run', () => ({ value: NODE }))
  on('process.spawn', async function* () {
    yield { stream: 'stdout', text: `${lines.map((l) => JSON.stringify(l)).join('\n')}\n` }
    return { value: { code: 0, signal: null } }
  })
}

async function agentCalls($: Parameters<TestBody>[0]) {
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'Delegate this.' })
  const calls: unknown[] = []
  for (let index = 0; index < 10; index++) {
    const { result } = await run($, { ...STEP, index })
    calls.push(...result.toolUses.filter((use) => use.name === 'Agent').map((use) => use.input))
    if (result.stopReason !== 'tool_use') return { calls, answer: result.answer }
  }
  throw new Error('the parent never answered')
}

test("a subagent's task is its nested agent's prompt, and a follow-up after it went idle is the next one's", async ($, on) => {
  arrange(on, RECORDED)
  const { calls, answer } = await agentCalls($)
  expect(calls).toEqual([
    { description: 'subagent', prompt: TASK, subagent_type: 'via:codex', run_in_background: true },
    { description: 'subagent', prompt: FOLLOWUP, subagent_type: 'via:codex', run_in_background: true },
  ])
  expect(answer).toContain('DONE')
})

const ROLE_RUN = (announce: unknown) => [
  RECORDED[0],
  RECORDED[1],
  announce,
  ...RECORDED.slice(3, 10),
  { relay: 'done', stopReason: 'end_turn' },
]
const announce = (description: string) => ({
  sessionId: ROOT,
  update: { sessionUpdate: 'subagent_update', sessionId: CHILD, title: 'Kestrel', description, capabilities: {} },
})

test("a subagent's role is not its task: shown beside its title", async ($, on) => {
  arrange(on, ROLE_RUN(announce('explorer')))
  expect((await agentCalls($)).calls).toEqual([
    { description: 'Kestrel (explorer)', prompt: TASK, subagent_type: 'via:codex', run_in_background: true },
  ])
})

test("codex's role `default` says nothing, so only the title shows", async ($, on) => {
  arrange(on, ROLE_RUN(announce('default')))
  expect((await agentCalls($)).calls).toEqual([
    { description: 'Kestrel', prompt: TASK, subagent_type: 'via:codex', run_in_background: true },
  ])
})

test("a task with no announcement or outgoing view still reaches the nested agent's prompt, from the child's own view", async ($, on) => {
  const lone = { ...incoming('m1', 'spawn', TASK), update: { ...incoming('m1', 'spawn', TASK).update, senderMessageId: undefined } }
  arrange(on, [
    RECORDED[0],
    RECORDED[1],
    lone,
    said(CHILD, 'r', 'KESTREL'),
    state({ state: 'idle', stopReason: 'end_turn' }),
    { relay: 'done', stopReason: 'end_turn' },
  ])
  expect((await agentCalls($)).calls).toEqual([
    { description: 'subagent', prompt: TASK, subagent_type: 'via:codex', run_in_background: true },
  ])
})

test("a follow-up sent while the subagent works is a row in its nested agent's view, said once and not its answer", async ($, on) => {
  arrange(on, [
    ...RECORDED.slice(0, 8),
    outgoing('followup', FOLLOWUP),
    incoming('01a1e585-7f86-74f0-ac63-1630d816f872', 'followup', FOLLOWUP),
    linked('followup', '01a1e585-7f86-74f0-ac63-1630d816f872'),
    said(CHILD, 'msg_resp_6', 'OSPREY'),
    state({ state: 'idle', stopReason: 'end_turn' }),
    said(ROOT, 'msg_resp_9', 'DONE'),
    { relay: 'done', stopReason: 'end_turn' },
  ])
  on('agent.spawn', (_, e) => ({ agentId: 'n1', model: e.model ?? 'codex' }))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'Delegate this.' })
  const first = await run($, STEP)
  const agent = first.chunks.find((c) => c.kind === 'tool')
  await $.agent.spawn({
    tool_use_id: agent?.kind === 'tool' ? agent.id : '',
    subagentType: 'via:codex',
    prompt: TASK,
    description: 'subagent',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'codex',
    parentAgentId: 'a1',
    background: true,
    fork: false,
  })
  await $.turn.start({ turnId: 'nested', agentId: 'n1', text: TASK })
  const nested = runTurn($, { ...STEP, turnId: 'nested', agentId: 'n1' })
  await runTurn($, { ...STEP, index: 1 })
  const { chunks, calls, result } = await nested
  const inputs = chunks.flatMap((c) => (c.kind === 'input' ? [JSON.parse(c.json)] : []))
  expect(inputs).toEqual([{ kind: 'message', title: 'From another agent' }])
  expect(JSON.stringify(calls)).toContain(FOLLOWUP)
  expect(result.answer).toBe('OSPREY\n\n— answered by codex subagent')
})
