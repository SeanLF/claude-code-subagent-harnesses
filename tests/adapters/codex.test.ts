import { expect, mock, type TestBody, test } from 'claude-code/testing'

import { codexMode } from '../../hooks/adapters/codex'
import { agentInfo, agentStore, ROOT, run, runTurn, STEP } from '../helpers'

type TestOn = Parameters<TestBody>[1]
type Spawn = { argv: string[]; input: string | undefined; env?: Record<string, string> }
type Write = { path: string; text: string }

const SID = '01a16ecb-98d2-7c23-94a0-695ac4248d9c'
const chunk = (messageId: string, text: string) => ({
  sessionId: SID,
  update: { content: { text, type: 'text' }, messageId, sessionUpdate: 'agent_message_chunk' },
})
// Captured from relay/relay.mjs over @agentclientprotocol/codex-acp 2.2.2 (codex-cli 0.163.0,
// 2026-10-24): a sentence, a `sleep 33` an interrupt cancelled, then the interrupt's answer.
const CAPTURED = [
  { relay: 'session', sessionId: SID },
  { relay: 'model', name: 'gpt-6.1-sol' },
  { relay: 'steered' },
  {
    sessionId: SID,
    update: { _meta: { codex: { threadStatus: { type: 'active', activeFlags: [] } } }, sessionUpdate: 'session_info_update' },
  },
  chunk('msg_a', 'I’ll wait'),
  chunk('msg_a', ' 33 seconds.\n'),
  {
    sessionId: SID,
    update: {
      toolCallId: 'exec-b50f',
      title: 'sleep 33',
      name: 'exec_command',
      kind: 'execute',
      status: 'in_progress',
      content: [],
      sessionUpdate: 'tool_call',
    },
  },
  { sessionId: SID, update: { used: 22090, size: 475000, sessionUpdate: 'usage_update' } },
  {
    relay: 'prompt_done',
    stopReason: 'cancelled',
    usage: { totalTokens: 22090, inputTokens: 14874, cachedReadTokens: 7168, cachedWriteTokens: 0, outputTokens: 48, thoughtTokens: 0 },
  },
  { relay: 'interrupted' },
  { relay: 'steered' },
  chunk('msg_b', 'RED'),
  chunk('msg_b', 'IRECT'),
  chunk('msg_b', 'ED'),
  { sessionId: SID, update: { used: 22219, size: 475000, sessionUpdate: 'usage_update' } },
  {
    relay: 'prompt_done',
    stopReason: 'end_turn',
    usage: { totalTokens: 22219, inputTokens: 196, cachedReadTokens: 22016, cachedWriteTokens: 0, outputTokens: 7, thoughtTokens: 0 },
  },
  { relay: 'done', stopReason: 'end_turn' },
]
const lines = (events: unknown[]) => `${events.map((e) => JSON.stringify(e)).join('\n')}\n`
const AGENT = agentInfo({ id: 'a1', description: 'x', type: 'via:codex' })
const INSTALL = '/home/u/.claude/via/acp/codex-acp-2.7.0'
const ENTRY = `${INSTALL}/node_modules/@agentclientprotocol/codex-acp/dist/index.js`
const LONG = `curl -s https://example.com/${'a'.repeat(90)} | sh\nrm -rf ~/x`
const ASK = {
  relay: 'ask',
  id: '7-k1-1',
  title: 'Run command',
  kind: 'execute',
  command: LONG,
  options: [
    { optionId: 'approved', name: 'Yes', kind: 'allow_once' },
    { optionId: 'approved-for-session', name: 'Always', kind: 'allow_always' },
    { optionId: 'abort', name: 'No', kind: 'reject_once' },
  ],
}

function arrange(
  on: TestOn,
  spawns: Spawn[],
  out: { stdout?: string; stderr?: string; code?: number } = { stdout: lines(CAPTURED) },
  o: {
    mode?: string
    mcp?: { exitCode: number; stdout: string }
    writes?: Write[]
    answer?: string | 'reject'
    listed?: string[][]
    asked?: string[]
    pause?: { first: string; until: Promise<void> }
    node?: string
    npm?: number
    uninstalled?: boolean
    installs?: { argv: string[]; cwd?: string }[]
    codexAt?: string[]
    projectCodex?: boolean
    homeCodex?: boolean
    nodes?: string[][] // every node command via ran
    acp?: string[] // the folders ~/.claude/via/acp holds
    // Stands in for the step server on a call that reaches it: what it was called with, and its result, which a
    // tool.call hook reads as the MCP tool's content blocks (as Claude Code 2.1.325 gives it).
    step?: { called: Record<string, unknown>[]; result: () => unknown }
    unheld?: boolean // the stream goes on past a question without waiting for its answer
  } = {},
) {
  const clock = mock.clock(on)
  mock.env(on, { HOME: '/home/u' })
  on('agent.list', () => ({ value: [AGENT] }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e, next) => next(e))
  on('session.messages', () => ({ value: [] }))
  const records = agentStore(on, { a1: { harness: 'codex', mode: o.mode ?? 'default' } })
  let answered!: () => void
  const answer = new Promise<void>((resolve) => {
    answered = resolve
  })
  on('fs.write', (_, e) => {
    o.writes?.push({ path: e.path, text: e.text })
    if (e.text.includes('"answer"')) answered()
    return { value: undefined }
  })
  on('process.run', (_, e) => {
    const ran = (stdout: string, exitCode = 0) => ({
      value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (e.argv[0] === 'node') {
      o.nodes?.push([...e.argv])
      return ran(o.node ?? '26.12.1\n')
    }
    if (e.argv[0] === 'npm') {
      o.installs?.push({ argv: [...e.argv], cwd: e.init?.cwd })
      return ran('', o.npm ?? 0)
    }
    o.listed?.push([...e.argv])
    return ran(o.mcp?.stdout ?? '[]', o.mcp?.exitCode ?? 0)
  })
  // The pinned codex-acp is installed unless a test says otherwise; no folder holds a .codex unless
  // a test names one.
  on('fs.stat', (_, e) => {
    if (e.path === ENTRY) {
      if (o.uninstalled) throw new Error('ENOENT')
      return { value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false } }
    }
    if (o.homeCodex && e.path.endsWith('/.codex'))
      return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: '/home/u/.codex' } }
    const projectCodex = o.projectCodex === true && !e.path.startsWith('/home/u/')
    if (e.path.endsWith('/.codex') && !projectCodex && !o.codexAt?.includes(e.path)) throw new Error('ENOENT')
    if (e.path.endsWith('/.codex')) return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: e.path } }
    return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: e.path } }
  })
  on('fs.list', (_, e) => ({
    value:
      e.path === '/home/u/.claude/via/acp'
        ? (o.acp ?? []).map((name) => ({
            name,
            kind: 'dir' as const,
            size: 0,
            mtimeMs: (o.acp ?? []).indexOf(name), // installed in list order, oldest first
            isLink: false,
          }))
        : [{ name: 'config.toml', kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false }],
  }))
  on('fs.read', (_, e) => ({ value: `contents of ${e.path}` }))
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
    if (o.answer === 'reject') throw new Error('dismissed')
    const question = e.questions[0]?.question ?? ''
    o.asked?.push(question, ...(e.questions[0]?.options ?? []).map((x: { label: string }) => x.label))
    return { result: { questions: e.questions, answers: { [question]: o.answer ?? 'Allow once' } } }
  })
  const step = o.step
  if (step)
    on('tool.call', { tool: 'mcp__plugin_via_step__step' as 'Bash' }, (_, e) => {
      step.called.push({ ...e })
      return { result: step.result() as never }
    })
  on('process.spawn', async function* (_, e) {
    spawns.push({ argv: [...e.argv], input: e.input, env: e.env })
    if (o.pause) {
      yield { stream: 'stdout' as const, text: o.pause.first }
      await o.pause.until
    }
    // Like the relay, a stream with a question waits for its answer before going on.
    const [before, after] = o.unheld ? [out.stdout ?? ''] : (out.stdout ?? '').split(/(?<="relay":"(?:ask|question)"[^\n]*\n)/)
    if (before) yield { stream: 'stdout' as const, text: before }
    if (after !== undefined) {
      await answer
      yield { stream: 'stdout' as const, text: after }
    }
    if (out.stderr) yield { stream: 'stderr' as const, text: out.stderr }
    return { value: { code: out.code ?? 0, signal: null } }
  })
  return { clock, records }
}

test('a codex agent runs codex-acp behind the relay, with its prompt on stdin', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'run the tests' })
  await runTurn($)
  expect(spawns[0]?.argv.slice(1)).toEqual([`${ROOT}/relay/relay.mjs`, '--', 'node', ENTRY])
  expect(spawns[0]?.argv[0]).toBe('node')
  expect(spawns[0]?.input).toBe('run the tests')
  expect(spawns[0]?.env).toMatchObject({
    RELAY_POLICY: 'ask',
    RELAY_AGENT_MODE: 'workspace-write',
    CODEX_PATH: 'codex',
    RELAY_INBOX: '/home/u/.claude/via/inbox/codex-a1.jsonl',
    RELAY_FILES: '/home/u/.claude/via/files/codex-a1',
    RELAY_STEER: 'steering',
  })
})

test('only the last message is the answer, signed with the model the session runs on, and usage is its context', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const { chunks, result } = await runTurn($)
  expect(result.answer).toBe('REDIRECTED\n\n— answered by codex, gpt-6.1-sol')
  expect(result.usage).toEqual({
    model: 'gpt-6.1-sol',
    input_tokens: 22219,
    output_tokens: 7,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  })
  // codex's command is a call to via's tool, not text in the answer.
  expect(chunks.some((c) => c.kind === 'input' && JSON.parse(c.json).title === 'sleep 33')).toBe(true)
  expect(chunks.some((c) => c.kind === 'text' && c.text.includes('sleep 33'))).toBe(false)
  expect(chunks.some((c) => c.kind === 'text' && c.text.includes('▸ interrupted'))).toBe(true)
})

// codex-acp 2.6.0 sends its warnings as notices once the client takes them (src/SessionNotice.ts).
const NOTICE = {
  sessionId: SID,
  update: {
    sessionUpdate: 'notice',
    severity: 'warning',
    title: 'This session was recorded with model `gpt-6-luna` but is resuming with `gpt-6.1-sol`.',
  },
}
test('a warning codex sends as a notice follows the answer, apart from it, never inside it', async ($, on) => {
  const spawns: Spawn[] = []
  const withNotice = CAPTURED.flatMap((e) => (e === CAPTURED[CAPTURED.length - 6] ? [NOTICE, e] : [e]))
  arrange(on, spawns, { stdout: lines(withNotice) })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const { result } = await runTurn($)
  expect(result.answer).toBe(
    'REDIRECTED\n\nWarning: This session was recorded with model `gpt-6-luna` but is resuming with `gpt-6.1-sol`.\n\n— answered by codex, gpt-6.1-sol',
  )
})

test('a notice survives a failed run, said before why it failed', async ($, on) => {
  const spawns: Spawn[] = []
  const failed = [
    { relay: 'session', sessionId: SID },
    { relay: 'steered' },
    { sessionId: SID, update: { sessionUpdate: 'notice', severity: 'error', title: 'Model unavailable' } },
    { relay: 'error', message: 'Internal error: the model is overloaded' },
  ]
  arrange(on, spawns, { stdout: lines(failed), code: 1 })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const { result } = await runTurn($)
  expect(result.answer.startsWith('Error: Model unavailable\n\n')).toBe(true)
  expect(result.answer).toContain('overloaded')
})

// No model refuses on demand: the captured run's last prompt is given each stop reason in turn.
const stoppedWith = (stopReason: string) => CAPTURED.map((e, i) => (i >= CAPTURED.length - 2 ? { ...e, stopReason } : e))

const STOPPED: Record<string, string> = {
  refusal: "codex did not finish: it refused this request, and its next turn won't include this message.",
  max_tokens: 'codex did not finish: its reply reached the output token limit.',
  max_turn_requests: 'codex did not finish: it reached its limit of model requests for this turn.',
}
for (const [stopReason, said] of Object.entries(STOPPED))
  test(`a prompt that stops with ${stopReason} keeps what codex said, then says why in place of the signature`, async ($, on) => {
    arrange(on, [], { stdout: lines(stoppedWith(stopReason)) })
    await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
    const { chunks, result } = await runTurn($)
    expect(result.answer).toBe(`REDIRECTED\n\n${said}`)
    expect(result.usage).toBeNull()
    expect(chunks.some((c) => c.kind === 'text' && c.text.includes('answered by'))).toBe(false)
  })

test('a refused prompt that a later prompt answers is signed: the last prompt is the answer', async ($, on) => {
  arrange(on, [], {
    // The interrupted prompt's stop reason, refused in its place.
    stdout: lines(CAPTURED.map((e, i) => (i === 8 ? { ...e, stopReason: 'refusal' } : e))),
  })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const { result } = await runTurn($)
  expect(result.answer).toBe('REDIRECTED\n\n— answered by codex, gpt-6.1-sol')
})

test('an interrupt the relay already ran is neither rerun nor named as undelivered', async ($, on) => {
  const spawns: Spawn[] = []
  const writes: Write[] = []
  // The stream pauses mid-turn until the interrupt reaches the inbox, as a real one would.
  const before = lines(CAPTURED.slice(0, 8))
  const after = lines(CAPTURED.slice(8))
  let sent!: () => void
  const interrupted = new Promise<void>((resolve) => {
    sent = resolve
  })
  const { clock } = arrange(on, spawns, { stdout: after }, { writes, pause: { first: before, until: interrupted } })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const pending = runTurn($)
  await clock.settle()
  const reply = await $.tool.call({
    tool: 'SendMessage',
    to: 'a1',
    message: 'interrupt: Stop. Reply with only the word REDIRECTED.',
    tool_use_id: 'i',
  })
  expect(reply.result).toEqual({
    success: true,
    message: 'Interrupting the running codex agent: it stops its current step, then takes this message.',
  })
  sent()
  const { result, calls } = await pending
  expect(spawns).toHaveLength(1)
  expect(result.answer).toBe('REDIRECTED\n\n— answered by codex, gpt-6.1-sol')
  expect(result.answer).not.toContain('Not delivered')
  // The command the interrupt cut off is closed when the relay reports the interrupt, not left running.
  expect(calls).toEqual([{ result: 'interrupted', isError: true }])
})

test('what the session says while it reopens after an interrupt is not part of the answer', async ($, on) => {
  const spawns: Spawn[] = []
  // The relay closes the session to stop the interrupted step's commands, then resumes it: codex can speak
  // in between, as it does when the resumed thread's recorded model differs from its default.
  const at = CAPTURED.findIndex((e) => 'relay' in e && e.relay === 'interrupted') + 1
  const reopened = [...CAPTURED.slice(0, at), chunk('msg_w', 'Warning: resuming with another model.\n'), ...CAPTURED.slice(at)]
  arrange(on, spawns, { stdout: lines(reopened) })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const { chunks, result } = await runTurn($)
  expect(result.answer).toBe('REDIRECTED\n\n— answered by codex, gpt-6.1-sol')
  expect(chunks.some((c) => c.kind === 'text' && c.text.includes('Warning'))).toBe(false)
})

test('a resumed read-only follow-up keeps its session, read-only mode and MCP guard together', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, undefined, { mcp: { exitCode: 0, stdout: JSON.stringify([{ name: 'node_repl' }]) } })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'tools: read\nlook' })
  await runTurn($)
  await $.turn.start({ turnId: 't2', agentId: 'a1', text: 'and the tests' })
  await runTurn($, { ...STEP, turnId: 't2', messageCount: 2 })
  expect(spawns[1]?.env).toMatchObject({ RELAY_SESSION: SID, RELAY_AGENT_MODE: 'read-only', RELAY_POLICY: 'deny' })
  expect(spawns[1]?.env?.CODEX_CONFIG).toContain('node_repl')
})

test("a plan-mode spawn's first step runs read-only, from the mode the spawn carried", async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, undefined, { mcp: { exitCode: 0, stdout: '[]' } })
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'a1' }))
  await $.agent.spawn({
    tool_use_id: 'toolu_s',
    subagentType: 'via:codex',
    prompt: 'look',
    description: 'd',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'haiku',
    background: true,
    fork: false,
    permissionMode: 'plan',
  })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'look' })
  await runTurn($)
  expect(spawns[0]?.env).toMatchObject({ RELAY_AGENT_MODE: 'read-only', RELAY_POLICY: 'deny' })
})

test('the session id is saved, and a follow-up resumes it without replaying its history into the answer', async ($, on) => {
  const spawns: Spawn[] = []
  // On session/load the agent replays its history before the relay's first prompt.
  const replayed = [{ relay: 'session', sessionId: SID }, chunk('msg_old', 'OLD ANSWER'), ...CAPTURED.slice(1)]
  const { records } = arrange(on, spawns, { stdout: lines(replayed) })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const { chunks, result } = await runTurn($)
  expect(records.record('a1')?.session).toBe(SID)
  expect(result.answer).not.toContain('OLD ANSWER')
  expect(chunks.some((c) => c.kind === 'text' && c.text.includes('OLD ANSWER'))).toBe(false)
  await $.turn.start({ turnId: 't2', agentId: 'a1', text: 'and again' })
  await runTurn($, { ...STEP, turnId: 't2', messageCount: 2 })
  expect(spawns[1]?.env?.RELAY_SESSION).toBe(SID)
})

// Seen live 2026-11-11: a SendMessage to an answered agent resumes it through agent.spawn, which must keep
// the session and the model its first turn chose.
test("a resumed agent keeps its session and model: a resume's spawn is the same agent", async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns)
  on('agent.spawn', () => ({ model: 'codex', agentId: 'a1' }))
  const spawn = (resume?: true) =>
    $.agent.spawn({
      tool_use_id: resume ? 'toolu_resume' : 'toolu_first',
      subagentType: 'via:codex',
      prompt: resume ? 'and again' : 'model: gpt-6-luna\ngo',
      description: 'd',
      provider: { plugin: 'engine', tier: 'core' },
      parentModel: 'haiku',
      background: true,
      fork: false,
      ...(resume ? { resume: { agentId: 'a1' } } : {}),
    })
  await spawn()
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'model: gpt-6-luna\ngo' })
  await runTurn($)
  await spawn(true)
  await $.turn.start({ turnId: 't2', agentId: 'a1', text: 'and again' })
  await runTurn($, { ...STEP, turnId: 't2', messageCount: 2 })
  expect(spawns[1]?.env?.RELAY_SESSION).toBe(SID)
  expect(spawns[1]?.env?.RELAY_MODEL).toBe('gpt-6-luna')
})

test("read-only and bypass set codex's sandbox; otherwise the permission mode decides how its questions are answered", () => {
  // Never codex-acp's own default, auto review, which approves escalations itself.
  expect(codexMode({}, 'default')).toEqual({ agentMode: 'workspace-write', policy: 'ask' })
  expect(codexMode({}, 'acceptEdits')).toEqual({ agentMode: 'workspace-write', policy: 'ask' })
  expect(codexMode({}, 'auto')).toEqual({ agentMode: 'workspace-write', policy: 'ask' })
  expect(codexMode({}, 'bypassPermissions')).toEqual({ agentMode: 'agent-full-access', policy: 'allow' })
  expect(codexMode({}, 'dontAsk')).toEqual({ agentMode: 'workspace-write', policy: 'deny' })
  expect(codexMode({}, 'plan')).toEqual({ agentMode: 'read-only', policy: 'deny' })
  expect(codexMode({ tools: 'read' }, 'bypassPermissions')).toEqual({ agentMode: 'read-only', policy: 'deny' })
})

test('a read-only run switches off every MCP server codex lists, and plugins, in CODEX_CONFIG', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, undefined, { mcp: { exitCode: 0, stdout: JSON.stringify([{ name: 'node_repl' }, { name: 'a.dotted-name' }]) } })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'tools: read\nlook' })
  await runTurn($)
  expect(spawns[0]?.env?.RELAY_AGENT_MODE).toBe('read-only')
  expect(spawns[0]?.env?.RELAY_POLICY).toBe('deny')
  expect(JSON.parse(spawns[0]?.env?.CODEX_CONFIG ?? '{}')).toEqual({
    mcp_servers: { node_repl: { enabled: false }, 'a.dotted-name': { enabled: false } },
    features: { plugins: false },
  })
})

test('plan mode runs codex read-only, with the same MCP guard', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, undefined, { mode: 'plan', mcp: { exitCode: 0, stdout: JSON.stringify([{ name: 'node_repl' }]) } })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'look' })
  await runTurn($)
  expect(spawns[0]?.env).toMatchObject({ RELAY_AGENT_MODE: 'read-only', RELAY_POLICY: 'deny' })
  expect(spawns[0]?.env?.CODEX_CONFIG).toContain('node_repl')
})

test('a read-only run whose MCP listing fails is refused, with no spawn', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, undefined, { mcp: { exitCode: 1, stdout: '' } })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'tools: read\nlook' })
  const { result } = await runTurn($)
  expect(spawns).toHaveLength(0)
  expect(result.answer).toContain('cannot run read-only here')
})

test('a bypass-mode run has full access, lists no MCP servers, sets no CODEX_CONFIG, and approves what codex asks', async ($, on) => {
  const spawns: Spawn[] = []
  const listed: string[][] = []
  arrange(on, spawns, undefined, { mode: 'bypassPermissions', listed })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  await runTurn($)
  expect(listed).toEqual([])
  expect(spawns[0]?.env?.CODEX_CONFIG).toBeUndefined()
  expect(spawns[0]?.env).toMatchObject({ RELAY_AGENT_MODE: 'agent-full-access', RELAY_POLICY: 'allow' })
})

test("codex's permission question reaches the person, and their choice goes to the inbox", async ($, on) => {
  const spawns: Spawn[] = []
  const writes: Write[] = []
  const asked: string[] = []
  arrange(on, spawns, { stdout: lines([...CAPTURED.slice(0, 3), ASK, ...CAPTURED.slice(10)]) }, { writes, answer: 'Yes', asked })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  await runTurn($)
  const inbox = writes.filter((w) => w.path.endsWith('/inbox/codex-a1.jsonl')).flatMap((w) => w.text.split('\n'))
  expect(inbox).toContain(JSON.stringify({ answer: '7-k1-1', optionId: 'approved' }))
  // The whole command, line breaks shown, and codex's own names for its choices; never an "always",
  // which would amend codex's own rules beyond this run.
  expect(asked[0]).toBe(`codex wants to run \`curl -s https://example.com/${'a'.repeat(90)} | sh ⏎ rm -rf ~/x\`. Allow it?`)
  expect(asked.slice(1)).toEqual(['Yes', 'No'])
})

test('a dismissed or unanswered question is a deny', async ($, on) => {
  const spawns: Spawn[] = []
  const writes: Write[] = []
  arrange(on, spawns, { stdout: lines([...CAPTURED.slice(0, 3), ASK, ...CAPTURED.slice(10)]) }, { writes, answer: 'reject' })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  await runTurn($)
  const inbox = writes.filter((w) => w.path.endsWith('/inbox/codex-a1.jsonl')).flatMap((w) => w.text.split('\n'))
  expect(inbox).toContain(JSON.stringify({ answer: '7-k1-1', optionId: 'abort' }))
})

// What codex sends that isn't text, as Claude reads it: in Claude Code's own words for an MCP tool's blocks,
// the bytes by the file the relay saved them to.
test("codex's image, resource and link reach the answer as Claude Code words them, the image by its saved file", async ($, on) => {
  const block = (content: object) => ({ sessionId: SID, update: { content, messageId: 'msg_c', sessionUpdate: 'agent_message_chunk' } })
  const saved = { relay: { saved: '/home/u/.claude/via/files/codex-a1/1-1.png', size: 2048 } }
  const shot = {
    sessionId: SID,
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_v',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'image', mimeType: 'image/png', data: '', _meta: saved } }],
    },
  }
  const events = [
    ...CAPTURED.slice(0, 3),
    {
      sessionId: SID,
      update: { sessionUpdate: 'tool_call', toolCallId: 'call_v', title: 'View screenshot', kind: 'read', status: 'in_progress' },
    },
    shot,
    block({ type: 'text', text: 'Here:' }),
    block({ type: 'image', mimeType: 'image/png', data: '', _meta: saved }),
    block({ type: 'resource', resource: { uri: 'file:///w/notes.md', text: 'the notes' } }),
    block({ type: 'resource_link', uri: 'file:///w/report.pdf', name: 'report.pdf', description: 'the report' }),
    ...CAPTURED.slice(-2),
  ]
  arrange(on, [], { stdout: lines(events) })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const { calls, result } = await runTurn($)
  const image = '[Image from codex] Binary content (image/png, 2.0 KB) saved to /home/u/.claude/via/files/codex-a1/1-1.png'
  expect(result.answer).toContain(`Here:\n${image}\n`)
  expect(result.answer).toContain('[Resource from codex at file:///w/notes.md] the notes')
  expect(result.answer).toContain('[Resource link: report.pdf] file:///w/report.pdf (the report)')
  // A tool's image, in its row.
  expect(calls).toContainEqual({ result: image })
})

const QUESTION = {
  relay: 'question',
  id: '7-k1-q1',
  mode: 'form',
  message: 'Which target?',
  requestedSchema: { type: 'object', properties: { target: { type: 'string', enum: ['staging', 'production'] } } },
}
const replied = (reply: object) => () => [{ type: 'text', text: JSON.stringify(reply) }]
const inboxOf = (writes: Write[]) => writes.filter((w) => w.path.endsWith('/inbox/codex-a1.jsonl')).flatMap((w) => w.text.split('\n'))

test("codex's question goes to the step server, which asks in Claude Code's own form, and the reply goes to the inbox", async ($, on) => {
  const writes: Write[] = []
  const step = { called: [] as Record<string, unknown>[], result: replied({ action: 'accept', content: { target: 'staging' } }) }
  arrange(on, [], { stdout: lines([...CAPTURED.slice(0, 3), QUESTION, ...CAPTURED.slice(10)]) }, { writes, step })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const { calls } = await runTurn($)
  const { relay: _, ...question } = QUESTION
  expect(step.called).toHaveLength(1)
  expect(step.called[0]).toMatchObject({ kind: 'question', title: 'Which target?', question })
  expect(inboxOf(writes)).toContain(JSON.stringify({ question: '7-k1-q1', answer: { action: 'accept', content: { target: 'staging' } } }))
  // The row says what the person answered.
  expect(calls).toContainEqual({ result: 'Answered: {"target":"staging"}' })
})

test('a question the step server leaves unanswered goes back to codex as a cancel', async ($, on) => {
  const writes: Write[] = []
  const step = {
    called: [] as Record<string, unknown>[],
    result: () => [{ type: 'text', text: 'via could not report this harness tool call.' }],
  }
  arrange(on, [], { stdout: lines([...CAPTURED.slice(0, 3), QUESTION, ...CAPTURED.slice(10)]) }, { writes, step })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const { calls } = await runTurn($)
  expect(inboxOf(writes)).toContain(JSON.stringify({ question: '7-k1-q1', answer: { action: 'cancel' } }))
  expect(calls).toContainEqual({ result: 'Not answered' })
})

test('a question codex closes before the person answers ends the wait, and nothing goes to the inbox', async ($, on) => {
  const writes: Write[] = []
  // The person never answers: the turn ends only if the closed line ends the wait, and with no answer nothing
  // can reach the inbox.
  const step = { called: [] as Record<string, unknown>[], result: () => new Promise(() => {}) }
  const closed = { relay: 'question_closed', id: QUESTION.id }
  arrange(on, [], { stdout: lines([...CAPTURED.slice(0, 3), QUESTION, closed, ...CAPTURED.slice(10)]) }, { writes, step, unheld: true })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const { calls, result } = await runTurn($)
  expect(calls).toContainEqual({ result: 'No longer needed: the harness moved on before you answered.' })
  // The run read on: codex's answer after the question is the agent's.
  expect(result.answer).toContain('REDIRECTED')
  expect(inboxOf(writes).some((line) => line.includes('"question"'))).toBe(false)
})

test("a question's shown text loses the characters that hide or reorder it; its values, and a link's site, are kept", async ($, on) => {
  const hidden = '\u202e\u200b'
  const sneaky = {
    ...QUESTION,
    message: `Which${hidden} target?`,
    requestedSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', title: `Tar${hidden}get`, enum: [`a${hidden}`, 'b'], enumNames: [`A${hidden}`, 'B'] },
        // Shown by their values: given cleaned names, the values kept.
        size: { type: 'string', enum: [`s${hidden}`, 'm'], default: `m${hidden}` },
        speed: { type: 'string', oneOf: [{ const: `f${hidden}` }, { const: 'slow', title: 'Slow' }] },
        [`no${hidden}te`]: { type: 'string' },
      },
    },
  }
  const link = {
    relay: 'question',
    id: '7-k1-q2',
    mode: 'url',
    message: `Sign${hidden} in`,
    url: 'https://example.com/login',
    elicitationId: 'e1',
  }
  const step = { called: [] as Record<string, unknown>[], result: replied({ action: 'decline' }) }
  // A link to a file never becomes a question, whatever line carries it.
  const file = { ...link, id: '7-k1-q3', url: 'file:///etc/passwd' }
  arrange(on, [], { stdout: lines([...CAPTURED.slice(0, 3), sneaky, link, file, ...CAPTURED.slice(10)]) }, { step })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  await runTurn($)
  expect(step.called[0]?.question).toEqual({
    id: '7-k1-q1',
    mode: 'form',
    message: 'Which target?',
    requestedSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', title: 'Target', enum: [`a${hidden}`, 'b'], enumNames: ['A', 'B'] },
        size: { type: 'string', enum: [`s${hidden}`, 'm'], enumNames: ['s', 'm'], default: 'm' },
        speed: {
          type: 'string',
          oneOf: [
            { const: `f${hidden}`, title: 'f' },
            { const: 'slow', title: 'Slow' },
          ],
        },
        [`no${hidden}te`]: { type: 'string', title: 'note' },
      },
    },
  })
  expect(step.called[1]?.question).toMatchObject({ message: 'Sign in (opens example.com)', url: 'https://example.com/login' })
  expect(step.called).toHaveLength(2)
})

// The question call is the one step call that reaches Claude Code's permission check: auto mode's classifier
// gave it no verdict live (2026-11-16), so via settles the mode's ask on its own question call, and only that.
test("via settles only the mode's ask on its own question call: a deny, a rule's ask, or another call's still stands", async ($, on) => {
  const step = { called: [] as Record<string, unknown>[], result: replied({ action: 'decline' }) }
  arrange(on, [], { stdout: lines([...CAPTURED.slice(0, 3), QUESTION, ...CAPTURED.slice(10)]) }, { step })
  let verdict: { decision: 'allow' | 'ask' | 'deny'; rule?: string } = { decision: 'ask' }
  on('tool.check', () => verdict)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const first = await run($)
  const tool = first.chunks.find((c) => c.kind === 'tool')
  const id = tool?.kind === 'tool' ? tool.id : ''
  const input = { kind: 'question', title: 'Which target?' }
  const check = (tool_use_id: string, called: object = input) =>
    $.tool.check({ tool: 'mcp__plugin_via_step__step', input: called, tool_use_id, agentId: 'a1' } as never)
  expect((await check(id)).decision).toBe('allow')
  // A model's call, or via's call for a harness tool call, which never reaches the check's decider.
  expect((await check('toolu_forged')).decision).toBe('ask')
  expect((await check(id, { kind: 'execute', title: 'rm -rf /' })).decision).toBe('ask')
  verdict = { decision: 'deny' }
  expect((await check(id)).decision).toBe('deny')
  verdict = { decision: 'ask', rule: 'mcp__plugin_via_step__step' }
  expect((await check(id)).decision).toBe('ask')
})

test("a question call via didn't make is refused, never let through to the step server", async ($, on) => {
  const step = { called: [] as Record<string, unknown>[], result: replied({ action: 'accept', content: {} }) }
  arrange(on, [], undefined, { step })
  const { relay: _, ...question } = QUESTION
  const said = await $.tool.call({
    tool: 'mcp__plugin_via_step__step',
    tool_use_id: 'toolu_forged',
    kind: 'question',
    title: 'q',
    question,
  } as never)
  expect(said).toMatchObject({ deny: expect.any(String) })
  expect(step.called).toHaveLength(0)
})

// Which levels a model has is codex's to say: the relay checks the line against what the session offers.
test('a thinking line becomes the reasoning_effort config option, whatever its level', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'thinking: ultra\ngo' })
  await runTurn($)
  expect(JSON.parse(spawns[0]?.env?.RELAY_CONFIG ?? '{}')).toEqual({ reasoning_effort: 'ultra' })
})

test("a config line goes to the relay as the person's option, and holds for follow-ups until a new line replaces it", async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'config: fast-mode=on\nconfig: speed=fast\ngo' })
  await runTurn($)
  expect(JSON.parse(spawns[0]?.env?.RELAY_OPTIONS ?? '{}')).toEqual({ 'fast-mode': 'on', speed: 'fast' })
  await $.turn.start({ turnId: 't2', agentId: 'a1', text: 'config: fast-mode=off\nand again' })
  await runTurn($, { ...STEP, turnId: 't2', messageCount: 2 })
  expect(JSON.parse(spawns[1]?.env?.RELAY_OPTIONS ?? '{}')).toEqual({ 'fast-mode': 'off', speed: 'fast' })
  // An empty value drops the option; none left sends none.
  await $.turn.start({ turnId: 't3', agentId: 'a1', text: 'config: fast-mode=\nconfig: speed=\nonce more' })
  await runTurn($, { ...STEP, turnId: 't3', messageCount: 3 })
  expect(spawns[2]?.env?.RELAY_OPTIONS).toBeUndefined()
})

test('a read-only run takes no config line, whatever the option, with no spawn', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'tools: read\nconfig: fast-mode=on\ngo' })
  const { result } = await runTurn($)
  expect(spawns).toHaveLength(0)
  expect(result.answer).toContain('A read-only codex run takes no config lines')
  // Refused before the record kept it: the next message runs.
  await $.turn.start({ turnId: 't2', agentId: 'a1', text: 'tools: read\ngo' })
  await runTurn($, { ...STEP, turnId: 't2', messageCount: 2 })
  expect(spawns).toHaveLength(1)
  expect(spawns[0]?.env?.RELAY_OPTIONS).toBeUndefined()
})

test('a config line that is not <option>=<value> is refused, with no spawn', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'config: fast-mode\ngo' })
  const { result } = await runTurn($)
  expect(spawns).toHaveLength(0)
  expect(result.answer).toContain('expected <option>=<value>, such as fast-mode=on, or <option>= to drop it.')
})

test('a lost session is forgotten, so the next message starts fresh', async ($, on) => {
  const spawns: Spawn[] = []
  const { records } = arrange(on, spawns, {
    stdout: lines([{ relay: 'session_lost', message: 'Resource not found' }]),
    stderr: 'acp relay: session lost: Resource not found\n',
    code: 1,
  })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const { result } = await runTurn($)
  expect(result.answer).toContain("could not find this agent's earlier session")
  expect(records.record('a1')?.session).toBe('')
})

test('a model the agent refuses is a failure in plain words, unsigned', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, {
    stdout: lines([
      { relay: 'session', sessionId: SID },
      { relay: 'error', message: 'the agent refused model no-such-model: Invalid params' },
    ]),
    stderr: 'acp relay: the agent refused model no-such-model\n',
    code: 1,
  })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'model: no-such-model\ngo' })
  const { result } = await runTurn($)
  expect(result.answer).toContain('refused model no-such-model')
  expect(result.answer).not.toContain('answered by')
  expect(result.usage).toBeNull()
})

test('a refused model names the closest models codex offers', async ($, on) => {
  arrange(on, [], {
    stdout: lines([
      { relay: 'session', sessionId: SID },
      { relay: 'error', message: 'the agent refused model gpt-6-lunar: Invalid params' },
    ]),
    code: 1,
  })
  on('store.get', { key: 'models.codex' }, () => ({ value: ['gpt-6.1-sol', 'gpt-6-luna', 'o9-mini'] }))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'model: gpt-6-lunar\ngo' })
  const { result } = await runTurn($)
  expect(result.answer).toContain('refused model gpt-6-lunar')
  expect(result.answer).toContain('Did you mean gpt-6-luna, gpt-6.1-sol?')
})

test('a failure that names an offered model, such as a rate limit, suggests nothing', async ($, on) => {
  arrange(on, [], {
    stdout: lines([
      { relay: 'session', sessionId: SID },
      { relay: 'error', message: 'rate limited for gpt-6-luna, try again later' },
    ]),
    code: 1,
  })
  on('store.get', { key: 'models.codex' }, () => ({ value: ['gpt-6.1-sol', 'gpt-6-luna'] }))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'model: gpt-6-luna\ngo' })
  const { result } = await runTurn($)
  expect(result.answer).toContain('rate limited for gpt-6-luna')
  expect(result.answer).not.toContain('Did you mean')
})

test('the first codex run installs the pinned codex-acp with npm ci, no scripts and no Codex binary, then runs it', async ($, on) => {
  const spawns: Spawn[] = []
  const writes: Write[] = []
  const installs: { argv: string[]; cwd?: string }[] = []
  arrange(on, spawns, undefined, { uninstalled: true, installs, writes })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  await runTurn($)
  expect(writes.map((w) => w.path)).toEqual(expect.arrayContaining([`${INSTALL}/package.json`, `${INSTALL}/package-lock.json`]))
  expect(installs).toEqual([{ argv: ['npm', 'ci', '--ignore-scripts', '--omit=optional', '--no-audit', '--no-fund'], cwd: INSTALL }])
  expect(spawns[0]?.argv.at(-1)).toBe(ENTRY)
})

test('a fresh install keeps the release before it and removes older codex-acp versions, and nothing else', async ($, on) => {
  const nodes: string[][] = []
  const acp = [
    'codex-acp-2.3.0',
    'codex-acp-2.3.1-preview.9',
    'codex-acp-2.5.0',
    INSTALL.split('/').at(-1) as string,
    'latest',
    'other-acp-1.0.0',
  ]
  const { clock } = arrange(on, [], undefined, { uninstalled: true, nodes, acp })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  await runTurn($)
  await clock.settle()
  const removed = nodes.find((argv) => argv[1] === '-e')
  // 2.5.0, the release before, stays for a session still running it.
  expect(removed?.slice(3).sort()).toEqual(['/home/u/.claude/via/acp/codex-acp-2.3.0', '/home/u/.claude/via/acp/codex-acp-2.3.1-preview.9'])
})

test('an install already in place removes nothing', async ($, on) => {
  const nodes: string[][] = []
  const { clock } = arrange(on, [], undefined, { nodes, acp: ['codex-acp-2.5.0', INSTALL.split('/').at(-1) as string] })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  await runTurn($)
  await clock.settle()
  expect(nodes.some((argv) => argv[1] === '-e')).toBe(false)
})

test('a failed install refuses the run rather than fetch an unpinned codex-acp', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, undefined, { uninstalled: true, npm: 1 })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const { result } = await runTurn($)
  expect(spawns).toHaveLength(0)
  expect(result.answer).toContain('could not install codex-acp-2.7.0')
})

test('a Node older than 22.18 refuses the run in plain words', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, undefined, { node: '22.17.1\n' })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const { result } = await runTurn($)
  expect(spawns).toHaveLength(0)
  expect(result.answer).toContain('via needs Node 22.18 or later on PATH to run codex, not 22.17.1')
})

test("read-only is refused under a project's .codex folder, whose config codex-acp would load as trusted", async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, undefined, { projectCodex: true })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'tools: read\nlook' })
  const { result } = await runTurn($)
  expect(spawns).toHaveLength(0)
  expect(result.answer).toContain('codex cannot run read-only here: codex-acp trusts the working folder')
})

test("the person's own ~/.codex does not void read-only", async ($, on) => {
  const spawns: Spawn[] = []
  // A session inside the home folder: walking up reaches ~/.codex, which resolves to the person's own.
  arrange(on, spawns, undefined, { codexAt: ['/home/u/.codex'], homeCodex: true })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'tools: read\nlook' })
  await runTurn($)
  expect(spawns).toHaveLength(1)
})

test('the dialog drops bidirectional and zero-width characters that could disguise a command', async ($, on) => {
  const spawns: Spawn[] = []
  const asked: string[] = []
  const sneaky = { ...ASK, command: 'echo safe\u202e; rm -rf ~\u200b\u00ad\u{e0041}' }
  arrange(on, spawns, { stdout: lines([...CAPTURED.slice(0, 3), sneaky, ...CAPTURED.slice(10)]) }, { asked })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  await runTurn($)
  expect(asked[0]).toBe('codex wants to run `echo safe; rm -rf ~`. Allow it?')
})

test('a /compact turn shows the compaction as a row and answers that it compacted, not that codex said nothing', async ($, on) => {
  const spawns: Spawn[] = []
  const compaction = (status: string) => ({ sessionId: SID, update: { sessionUpdate: 'compaction_update', compactionId: 'c1', status } })
  const stdout = lines([
    { relay: 'session', sessionId: SID },
    { relay: 'model', name: 'gpt-6-luna' },
    { relay: 'steered' },
    compaction('in_progress'),
    compaction('completed'),
    { relay: 'prompt_done', stopReason: 'end_turn' },
    { relay: 'done', stopReason: 'end_turn' },
  ])
  arrange(on, spawns, { stdout })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: '/compact' })
  const { chunks, result } = await runTurn($)
  expect(chunks.some((c) => c.kind === 'input' && JSON.parse(c.json).kind === 'compact')).toBe(true)
  expect(result.answer).toBe('Compacted the conversation.\n\n— answered by codex, gpt-6-luna')
})
