import { expect, mock, type TestBody, test } from 'claude-code/testing'
import type { AgentRecord } from '../../hooks/record'
import { agentInfo, agentStore, ROOT, runTurn, STEP } from '../helpers'

type TestOn = Parameters<TestBody>[1]
type Spawn = { argv: string[]; input: string | undefined; env?: Record<string, string> }

const SID = 'ab90f86d-4ea3-4fc4-8e4c-be096307339b'
const update = (u: Record<string, unknown>) => ({ sessionId: SID, update: u })
const text = (sessionUpdate: string, t: string) => update({ content: { text: t, type: 'text' }, sessionUpdate })
const used = (n: number) => update({ used: n, size: 1048576, sessionUpdate: 'usage_update' })
// Captured from relay/relay.mjs over `agy acp --sandbox` (agy 1.5.16, gemini-3.8-flash, thought_level medium,
// 2026-11-24), trimmed: the folder written /w, rawInput, config options and commands dropped, thinking cut short.
// agy sends no message ids, a command's output under its own header, and its context in each usage_update.
const CAPTURED = [
  { relay: 'session', sessionId: SID, cwd: '/w' },
  { relay: 'model', name: 'gemini-3.8-flash' },
  { relay: 'steered' },
  used(0),
  update({ title: 'Editing File Contents Script', sessionUpdate: 'session_info_update' }),
  text('agent_thought_chunk', 'First, the task involves editing a file.\n\n\n'),
  used(10830),
  update({
    toolCallId: 'call_10587621314089194412',
    title: 'File a.txt',
    kind: 'read',
    status: 'in_progress',
    locations: [{ path: '/w/a.txt' }],
    sessionUpdate: 'tool_call',
  }),
  update({
    toolCallId: 'call_10587621314089194412',
    kind: 'read',
    status: 'completed',
    title: 'File a.txt',
    locations: [{ path: '/w/a.txt' }],
    sessionUpdate: 'tool_call_update',
  }),
  text('agent_message_chunk', 'Editing now'),
  text('agent_message_chunk', '.'),
  used(11581),
  update({
    toolCallId: 'call_11636866082623614902',
    title: 'File a.txt',
    kind: 'edit',
    status: 'in_progress',
    locations: [{ path: '/w/a.txt' }],
    sessionUpdate: 'tool_call',
  }),
  update({
    toolCallId: 'call_11636866082623614902',
    kind: 'edit',
    status: 'completed',
    title: 'File a.txt',
    content: [{ path: '/w/a.txt', oldText: 'one\n', newText: 'two\n', type: 'diff' }],
    locations: [{ path: '/w/a.txt' }],
    rawOutput: {},
    sessionUpdate: 'tool_call_update',
  }),
  used(11916),
  update({
    toolCallId: 'call_5038519635910113615',
    title: 'cat a.txt',
    kind: 'execute',
    status: 'in_progress',
    sessionUpdate: 'tool_call',
  }),
  update({
    toolCallId: 'call_5038519635910113615',
    kind: 'execute',
    status: 'completed',
    title: 'cat a.txt',
    content: [
      {
        content: {
          text: 'Created At: 2026-11-24T02:59:20-05:00\nCompleted At: 2026-11-24T02:59:20-05:00\nCommand exited with code 0.\n\nCommand output:\ntwo\r\n',
          type: 'text',
        },
        type: 'content',
      },
    ],
    rawOutput: {
      output:
        'Created At: 2026-11-24T02:59:20-05:00\nCompleted At: 2026-11-24T02:59:20-05:00\nCommand exited with code 0.\n\nCommand output:\ntwo\r\n',
      exit_code: 0,
    },
    sessionUpdate: 'tool_call_update',
  }),
  text('agent_message_chunk', '\n\ntwo'),
  used(12038),
  {
    relay: 'prompt_done',
    stopReason: 'end_turn',
    usage: {
      inputTokens: 18113,
      outputTokens: 1152,
      cachedReadTokens: 27100,
      cachedWriteTokens: 0,
      thoughtTokens: 924,
      totalTokens: 46365,
    },
  },
  { relay: 'done', stopReason: 'end_turn' },
]
// Captured the same way: a command that exits 1. agy reports it completed.
const FAILED = [
  { relay: 'session', sessionId: SID, cwd: '/w' },
  { relay: 'model', name: 'gemini-3.8-flash' },
  { relay: 'steered' },
  update({
    toolCallId: 'call_16018841989160972162',
    title: 'ls missing-file',
    kind: 'execute',
    status: 'in_progress',
    sessionUpdate: 'tool_call',
  }),
  update({
    toolCallId: 'call_16018841989160972162',
    kind: 'execute',
    status: 'completed',
    title: 'ls missing-file',
    content: [
      {
        content: {
          text: 'Created At: 2026-11-24T03:00:10-05:00\nCompleted At: 2026-11-24T03:00:11-05:00\nCommand exited with code 1.\n\nCommand output:\nls: missing-file: No such file or directory\r\n',
          type: 'text',
        },
        type: 'content',
      },
    ],
    rawOutput: {
      output:
        'Created At: 2026-11-24T03:00:10-05:00\nCompleted At: 2026-11-24T03:00:11-05:00\nCommand exited with code 1.\n\nCommand output:\nls: missing-file: No such file or directory\r\n',
      exit_code: 1,
    },
    sessionUpdate: 'tool_call_update',
  }),
  text('agent_message_chunk', 'DONE'),
  {
    relay: 'prompt_done',
    stopReason: 'end_turn',
    usage: { inputTokens: 12588, outputTokens: 39, cachedReadTokens: 8365, cachedWriteTokens: 0, thoughtTokens: 0, totalTokens: 20992 },
  },
  { relay: 'done', stopReason: 'end_turn' },
]
const lines = (events: unknown[]) => `${events.map((e) => JSON.stringify(e)).join('\n')}\n`
const AGENT = agentInfo({ id: 'a1', description: 'x', type: 'via:agy' })

function arrange(
  on: TestOn,
  spawns: Spawn[],
  // record: what the agent's record holds at the start, as an earlier turn or process left it.
  out: { stdout?: string; stderr?: string; code?: number; record?: Partial<AgentRecord> } = { stdout: lines(CAPTURED) },
) {
  mock.clock(on)
  mock.env(on, { HOME: '/home/u' })
  on('agent.list', () => ({ value: [AGENT] }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e, next) => next(e))
  on('session.messages', () => ({ value: [] }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '26.12.1\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.write', () => ({ value: undefined }))
  const records = agentStore(on, { a1: { harness: 'agy', mode: 'default', ...out.record } })
  on('process.spawn', async function* (_, e) {
    spawns.push({ argv: [...e.argv], input: e.input, env: e.env })
    if (out.stdout) yield { stream: 'stdout' as const, text: out.stdout }
    if (out.stderr) yield { stream: 'stderr' as const, text: out.stderr }
    return { value: { code: out.code ?? 0, signal: null } }
  })
  return records
}

test('an agy agent runs `agy acp --sandbox` behind the relay; a prompt starting with /, @ or -- goes as text on stdin', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: '/model --help @README.md' })
  await runTurn($)
  expect(spawns[0]?.argv).toEqual(['node', `${ROOT}/relay/relay.mjs`, '--', 'agy', 'acp', '--sandbox'])
  expect(spawns[0]?.input).toBe('/model --help @README.md')
})

test('only the text after the last tool call is the answer, signed with the session model; reads, edits, commands and thinking show', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const { chunks, result, calls } = await runTurn($)
  expect(result.answer).toBe('two\n\n— answered by agy, gemini-3.8-flash')
  expect(chunks.some((c) => c.kind === 'text' && c.text.includes('Editing now'))).toBe(true)
  const inputs = chunks.flatMap((c) => (c.kind === 'input' ? [JSON.parse(c.json) as unknown] : []))
  expect(inputs).toEqual([
    { kind: 'read', title: 'File a.txt', path: '/w/a.txt' },
    { kind: 'edit', title: 'File a.txt', path: '/w/a.txt' },
    { kind: 'execute', title: 'cat a.txt' },
  ])
  // What Claude reads back from the edit and the command: the command's output without agy's header.
  expect(calls[1]).toEqual({ result: 'a.txt\n- one\n+ two' })
  expect(calls[2]).toEqual({ result: 'two' })
  expect(chunks.some((c) => c.kind === 'thinking' && c.text.includes('editing a file'))).toBe(true)
})

test('a command that exits nonzero ends as failed, with its output and exit code', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, { stdout: lines(FAILED) })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const { result, calls } = await runTurn($)
  expect(calls).toEqual([{ result: 'ls: missing-file: No such file or directory\nexit code 1', isError: true }])
  expect(result.answer).toBe('DONE\n\n— answered by agy, gemini-3.8-flash')
})

test("model and thinking lines become the relay's model and agy's thought_level, which the relay checks", async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'model: gemini-3.8-flash\nthinking: max\ngo' })
  await runTurn($)
  expect(spawns[0]?.env?.RELAY_MODEL).toBe('gemini-3.8-flash')
  expect(JSON.parse(spawns[0]?.env?.RELAY_CONFIG ?? '{}')).toEqual({ thought_level: 'max' })
})

test("agy's own questions reach the person, and a message to it running steers it with a second prompt", async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  await runTurn($)
  expect(spawns[0]?.env?.RELAY_POLICY).toBe('ask')
  expect(spawns[0]?.env?.RELAY_INBOX).toBe('/home/u/.claude/via/inbox/agy-a1.jsonl')
  expect(spawns[0]?.env?.RELAY_STEER).toBe('prompt')
})

test("bypass mode approves what agy asks, and runs its commands outside agy's sandbox, as Codex has full access there", async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, { stdout: lines(CAPTURED), record: { mode: 'bypassPermissions' } })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  await runTurn($)
  expect(spawns[0]?.env?.RELAY_POLICY).toBe('allow')
  expect(spawns[0]?.env?.RELAY_AGENT_MODE).toBeUndefined()
  expect(spawns[0]?.argv).toEqual(['node', `${ROOT}/relay/relay.mjs`, '--', 'agy', 'acp'])
})

// Live on agy 1.5.16, every question denied: under its strict setting accept-edits made the edit and ran no command;
// under request-review auto did both, and default neither. strict holds auto to its own rules.
for (const [mode, agentMode] of [
  ['acceptEdits', 'accept-edits'],
  ['auto', 'auto'],
] as const)
  test(`${mode} mode runs agy in its own ${agentMode} mode, sandboxed, and asks the person what that mode leaves to them`, async ($, on) => {
    const spawns: Spawn[] = []
    arrange(on, spawns, { stdout: lines(CAPTURED), record: { mode } })
    await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
    await runTurn($)
    expect(spawns[0]?.env).toMatchObject({ RELAY_AGENT_MODE: agentMode, RELAY_POLICY: 'ask' })
    expect(spawns[0]?.argv).toEqual(['node', `${ROOT}/relay/relay.mjs`, '--', 'agy', 'acp', '--sandbox'])
  })

test('dontAsk mode denies what agy asks, sandboxed', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, { stdout: lines(CAPTURED), record: { mode: 'dontAsk' } })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  await runTurn($)
  expect(spawns[0]?.env?.RELAY_POLICY).toBe('deny')
  expect(spawns[0]?.argv).toEqual(['node', `${ROOT}/relay/relay.mjs`, '--', 'agy', 'acp', '--sandbox'])
})

test('the session is saved, and a follow-up loads it', async ($, on) => {
  const spawns: Spawn[] = []
  const records = arrange(on, spawns)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  await runTurn($)
  expect(records.record('a1')?.session).toBe(SID)
  await $.turn.start({ turnId: 't2', agentId: 'a1', text: 'go on' })
  await runTurn($, { ...STEP, turnId: 't2', messageCount: 2 })
  expect(spawns[1]?.env?.RELAY_SESSION).toBe(SID)
})

test('a lost session fails in plain words and is forgotten', async ($, on) => {
  const spawns: Spawn[] = []
  const records = arrange(on, spawns, {
    stdout: lines([{ relay: 'session_lost', message: 'Session not found: 00000000-0000-0000-0000-000000000000' }]),
    stderr: 'acp relay: session lost: Session not found: 00000000-0000-0000-0000-000000000000\n',
    code: 1,
    record: { session: '00000000-0000-0000-0000-000000000000' },
  })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const { result } = await runTurn($)
  expect(result.answer).toContain("agy could not find this agent's earlier session, so this message did not run")
  expect(records.record('a1')?.session).toBe('')
})

test('a tools line is refused: agy has no read-only mode', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'tools: read\nlook around' })
  const { result } = await runTurn($)
  expect(spawns).toHaveLength(0)
  expect(result.answer).toContain('agy cannot enforce read-only tools, so a tools line is refused.')
})

test('plan mode refuses agy, which has no read-only mode via can enforce', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, { stdout: lines(CAPTURED), record: { mode: 'plan' } })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'look around' })
  const { result } = await runTurn($)
  expect(spawns).toHaveLength(0)
  expect(result.answer).toContain('agy cannot run in plan mode')
})
