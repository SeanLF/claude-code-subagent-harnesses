import type { AgentSpawnInput, TurnStepChunk } from 'claude-code'
import { expect, mock, type TestBody, test } from 'claude-code/testing'

import { codexMode } from '../../hooks/adapters/codex'
import { agentInfo, agentStore, ROOT, run, runTurn, STEP } from '../helpers'

type TestOn = Parameters<TestBody>[1]
type Dialog = { question: string; header: string; multiSelect: boolean; options: { label: string; description: string }[] }[]
type Spawn = { argv: string[]; input: string | undefined; env?: Record<string, string> }
type Write = { path: string; text: string }

const SID = '01a16ecb-98d2-7c23-94a0-695ac4248d9c'
const chunk = (messageId: string, text: string) => ({
  sessionId: SID,
  update: { content: { text, type: 'text' }, messageId, sessionUpdate: 'agent_message_chunk' },
})
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
const INSTALL = '/home/u/.claude/via/acp/codex-acp-2.10.0'
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
    pause?: { first: string; until: Promise<void>; second?: { text: string; until: Promise<void> } }
    node?: string
    npm?: number
    uninstalled?: boolean
    installs?: { argv: string[]; cwd?: string }[]
    codexAt?: string[]
    projectCodex?: boolean
    homeCodex?: boolean
    nodes?: string[][]
    acp?: string[]
    step?: { called: Record<string, unknown>[]; result: () => unknown }
    unheld?: boolean
    env?: Record<string, string>
    description?: string
    dialog?: { shown: Dialog[]; answer: (questions: Dialog) => object | Promise<object> }
    timeout?: string
    agents?: Promise<void>
  } = {},
) {
  const clock = mock.clock(on)
  mock.env(on, { HOME: '/home/u', ...o.env })
  on('agent.list', async () => {
    await o.agents
    return { value: [AGENT] }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('session.messages', () => ({ value: [] }))
  const records = agentStore(on, {
    a1: { harness: 'codex', mode: o.mode ?? 'default', ...(o.description ? { description: o.description } : {}) },
  })
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
            mtimeMs: (o.acp ?? []).indexOf(name),
            isLink: false,
          }))
        : [{ name: 'config.toml', kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false }],
  }))
  on('fs.read', (_, e) => ({ value: `contents of ${e.path}` }))
  on('settings.read', (_, e, next) => (o.timeout === undefined ? next(e) : { value: { askUserQuestionTimeout: o.timeout } }))
  on('tool.call', { tool: 'AskUserQuestion' }, async (_, e) => {
    const dialog = o.dialog
    if (dialog) {
      const questions = e.questions as unknown as Dialog
      dialog.shown.push(questions)
      return { result: { questions: e.questions, ...(await dialog.answer(questions)) } as never }
    }
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
      if (o.pause.second) {
        yield { stream: 'stdout' as const, text: o.pause.second.text }
        await o.pause.second.until
      }
    }
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
  expect(chunks.some((c) => c.kind === 'input' && JSON.parse(c.json).title === 'sleep 33')).toBe(true)
  expect(chunks.some((c) => c.kind === 'text' && c.text.includes('sleep 33'))).toBe(false)
  expect(chunks.some((c) => c.kind === 'text' && c.text.includes('▸ interrupted'))).toBe(true)
})

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
    stdout: lines(CAPTURED.map((e, i) => (i === 8 ? { ...e, stopReason: 'refusal' } : e))),
  })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const { result } = await runTurn($)
  expect(result.answer).toBe('REDIRECTED\n\n— answered by codex, gpt-6.1-sol')
})

test('an interrupt the relay already ran is neither rerun nor named as undelivered', async ($, on) => {
  const spawns: Spawn[] = []
  const writes: Write[] = []
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
  expect(calls).toEqual([{ result: 'interrupted', isError: true }])
})

test('what the session says while it reopens after an interrupt is not part of the answer', async ($, on) => {
  const spawns: Spawn[] = []
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

test("read-only and bypass set codex's sandbox; dontAsk denies; every other mode, auto too, asks the person, never codex-acp's auto review, which approves its own escalations", () => {
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
  expect(calls).toContainEqual({ result: image })
})

const QUESTION = {
  relay: 'question',
  id: '7-k1-q1',
  mode: 'form',
  message: 'Which target?',
  requestedSchema: { type: 'object', properties: { target: { type: 'string', enum: ['staging', 'production'] } } },
}
const LINK = {
  relay: 'question',
  id: '7-k1-q2',
  mode: 'url',
  message: 'Sign in',
  url: 'https://example.com/login',
  elicitationId: 'e1',
}
const replied = (reply: object) => () => [{ type: 'text', text: JSON.stringify(reply) }]
const inboxOf = (writes: Write[]) => writes.filter((w) => w.path.endsWith('/inbox/codex-a1.jsonl')).flatMap((w) => w.text.split('\n'))
const picked = (label: string) => (questions: Dialog) => ({ answers: { [questions[0]?.question ?? '']: label } })
const never = () => new Promise<object>(() => {})
async function spawn($: Parameters<TestBody>[0], on: TestOn, background = true, headless = false) {
  on('agent.spawn', (_, e) => ({ model: e.model ?? '', agentId: 'a1' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  if (headless) await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  const input: AgentSpawnInput = {
    tool_use_id: 'toolu_spawn',
    subagentType: 'via:codex',
    prompt: 'go',
    description: 'd',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'haiku',
    background,
    fork: false,
  }
  await $.agent.spawn(input)
}
async function runOn($: Parameters<TestBody>[0], from: number) {
  return runTurn($, { ...STEP, index: from })
}
const sent = (chunks: TurnStepChunk[]) =>
  chunks.flatMap((c, i) => {
    const tool = chunks[i - 1]
    return c.kind === 'input' && tool?.kind === 'tool' && tool.name === 'SendMessage'
      ? [{ id: tool.id, ...(JSON.parse(c.json) as { to: string; summary: string; message: string }) }]
      : []
  })

const long = (n: number) => `The full E2E run found a scope conflict number ${n}: should the fix include the header change?`
const CODEX_FORM = {
  relay: 'question',
  id: '7-k1-q1',
  mode: 'form',
  message: 'Codex keeps working while you answer.',
  requestedSchema: {
    type: 'object',
    properties: {
      question_0: {
        type: 'string',
        title: long(1),
        oneOf: [
          { const: 'Yes', title: 'Yes' },
          { const: 'No', title: 'No' },
        ],
      },
      question_0_note: { type: 'string', title: 'Additional answer or note' },
    },
  },
}

test("codex's question is asked whole in Claude Code's AskUserQuestion dialog, and the option picked goes to codex", async ($, on) => {
  const writes: Write[] = []
  const dialog = { shown: [] as Dialog[], answer: picked('No') }
  const step = { called: [] as Record<string, unknown>[], result: replied({ action: 'decline' }) }
  arrange(on, [], { stdout: lines([...CAPTURED.slice(0, 3), CODEX_FORM, ...CAPTURED.slice(10)]) }, { writes, dialog, step })
  await spawn($, on)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const { calls } = await runTurn($)
  expect(dialog.shown).toEqual([
    [
      {
        question: `Codex keeps working while you answer.\n\n${long(1)}`,
        header: 'codex',
        multiSelect: false,
        options: [
          { label: 'Yes', description: '' },
          { label: 'No', description: '' },
          { label: 'Let Claude answer', description: 'Hand this question to the main agent, which answers it for you' },
        ],
      },
    ],
  ])
  expect(step.called).toHaveLength(0)
  expect(inboxOf(writes)).toContain(JSON.stringify({ question: '7-k1-q1', answer: { action: 'accept', content: { question_0: 'No' } } }))
  expect(calls).toContainEqual({ result: 'Answered: {"question_0":"No"}' })
})

test('text typed under "Other" goes to the note field of the question it answers', async ($, on) => {
  const writes: Write[] = []
  const dialog = { shown: [] as Dialog[], answer: picked('Only the header, not the footer') }
  arrange(on, [], { stdout: lines([...CAPTURED.slice(0, 3), CODEX_FORM, ...CAPTURED.slice(10)]) }, { writes, dialog })
  await spawn($, on)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  await runTurn($)
  const content = { question_0_note: 'Only the header, not the footer' }
  expect(inboxOf(writes)).toContain(JSON.stringify({ question: '7-k1-q1', answer: { action: 'accept', content } }))
})

test('a number outside its range is asked again with why', async ($, on) => {
  const writes: Write[] = []
  const form = {
    ...QUESTION,
    requestedSchema: {
      type: 'object',
      properties: { workers: { type: 'integer', title: 'How many workers?', minimum: 1, maximum: 8 } },
      required: ['workers'],
    },
  }
  const said = ['9', '4']
  const dialog = { shown: [] as Dialog[], answer: (q: Dialog) => picked(said.shift() ?? '')(q) }
  arrange(on, [], { stdout: lines([...CAPTURED.slice(0, 3), form, ...CAPTURED.slice(10)]) }, { writes, dialog })
  await spawn($, on)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  await runTurn($)
  expect(dialog.shown.map((d) => d[0]?.question)).toEqual([
    'Which target?\n\nHow many workers? (a whole number from 1 to 8)',
    '"Which target?\n\nHow many workers? (a whole number from 1 to 8)" needs a whole number from 1 to 8, not "9".\n\nWhich target?\n\nHow many workers? (a whole number from 1 to 8)',
  ])
  expect(dialog.shown[0]?.[0]?.options.map((o) => o.label)).toEqual(['Let Claude answer', 'Decline'])
  expect(inboxOf(writes)).toContain(JSON.stringify({ question: '7-k1-q1', answer: { action: 'accept', content: { workers: 4 } } }))
})

test('a question the step server leaves unanswered goes back to codex as a cancel', async ($, on) => {
  const writes: Write[] = []
  const step = {
    called: [] as Record<string, unknown>[],
    result: () => [{ type: 'text', text: 'via could not report this harness tool call.' }],
  }
  arrange(on, [], { stdout: lines([...CAPTURED.slice(0, 3), { ...LINK, id: '7-k1-q1' }, ...CAPTURED.slice(10)]) }, { writes, step })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const { calls } = await runTurn($)
  expect(inboxOf(writes)).toContain(JSON.stringify({ question: '7-k1-q1', answer: { action: 'cancel' } }))
  expect(calls).toContainEqual({ result: 'Not answered' })
})

test('a question codex closes before the person answers ends the wait, and nothing goes to the inbox', async ($, on) => {
  const writes: Write[] = []
  const dialog = { shown: [] as Dialog[], answer: never }
  const closed = { relay: 'question_closed', id: QUESTION.id }
  arrange(on, [], { stdout: lines([...CAPTURED.slice(0, 3), QUESTION, closed, ...CAPTURED.slice(10)]) }, { writes, dialog, unheld: true })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const { calls, result } = await runTurn($)
  expect(calls).toContainEqual({ result: 'No longer needed: the harness moved on before you answered.' })
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
        size: { type: 'string', enum: [`s${hidden}`, 'm'], default: `m${hidden}` },
        speed: { type: 'string', oneOf: [{ const: `f${hidden}` }, { const: 'slow', title: 'Slow' }] },
        [`no${hidden}te`]: { type: 'string' },
        when: { type: 'string' },
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
        when: { type: 'string' },
      },
    },
  })
  expect(step.called[1]?.question).toMatchObject({ message: 'Sign in (opens example.com)', url: 'https://example.com/login' })
  expect(step.called).toHaveLength(2)
})

const FIVE = ['A', 'B', 'C', 'D', 'E'].map((c) => ({ const: c, title: c }))
const field = (title: string) => ({ type: 'string', title, oneOf: FIVE })
const note = { type: 'string', title: 'Additional answer or note' }
const titled = (id: string, titles: string[]) => ({
  ...QUESTION,
  id,
  message: 'Codex keeps working while you answer.',
  requestedSchema: {
    type: 'object',
    properties: Object.fromEntries(
      titles.flatMap((t, i) => [
        [`question_${i}`, field(t)],
        [`question_${i}_note`, note],
      ]),
    ),
  },
})
async function shown($: Parameters<TestBody>[0], on: TestOn, forms: object[]) {
  const step = { called: [] as Record<string, unknown>[], result: replied({ action: 'decline' }) }
  arrange(on, [], { stdout: lines([...CAPTURED.slice(0, 3), ...forms, ...CAPTURED.slice(10)]) }, { step })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  await runTurn($)
  return step.called.map((c) => c.question)
}

test("a question too long for its field's title is shown whole in the form's message", async ($, on) => {
  const [one, two] = await shown($, on, [titled('7-k1-q1', [long(1)]), titled('7-k1-q2', [long(1), 'Which target?', long(2)])])
  const message = [
    'The full E2E run found a scope conflict number 1: should the fix include',
    'the header change?',
    '',
    'Codex keeps working while you answer.',
  ].join('\n')
  expect(one).toMatchObject({ message, requestedSchema: { properties: { question_0: field('Answer'), question_0_note: note } } })
  expect(two).toMatchObject({
    message,
    requestedSchema: { properties: { question_0: field('Answer'), question_1: field('Which target?'), question_2: field(long(2)) } },
  })
})

test('long questions that fit in the shown lines are numbered in the message; a 40-character title stays', async ($, on) => {
  const forty = 'Should the fix include the header change?'.slice(0, 40)
  const fortyOne = `${forty}?`
  const [form, three] = await shown($, on, [
    titled('7-k1-q1', [fortyOne, forty, `${fortyOne} Again`]),
    titled('7-k1-q2', [long(1), fortyOne]),
  ])
  expect(form).toMatchObject({
    message: [`1. ${fortyOne}`, `2. ${fortyOne} Again`, '', 'Codex keeps working while you answer.'].join('\n'),
    requestedSchema: { properties: { question_0: field('Answer 1'), question_1: field(forty), question_2: field('Answer 2') } },
  })
  expect(three).toMatchObject({
    message: [
      '1. The full E2E run found a scope conflict number 1: should the fix',
      '   include the header change?',
      `2. ${fortyOne}`,
      '',
      'Codex keeps working while you answer.',
    ].join('\n'),
    requestedSchema: { properties: { question_0: field('Answer 1'), question_1: field('Answer 2') } },
  })
})

const handoff = (why: string) =>
  [
    `The codex agent "a1" needs an answer to its harness's question: ${why}.`,
    '',
    `Codex keeps working while you answer.\n\n${long(1)}`,
    'One of: "Yes", "No", or your own text.',
    '',
    'Answer with SendMessage to "a1", the message being your answer alone.',
    '"Decline" declines. The harness waits for your answer.',
  ].join('\n')
const noQuestionAnswered = (writes: Write[]) => !inboxOf(writes).some((line) => line.includes('"question"'))

test('"Let Claude answer" hands the question to the main agent, whose message naming an option is the answer, not a steer', async ($, on) => {
  const writes: Write[] = []
  const dialog = { shown: [] as Dialog[], answer: picked('Let Claude answer') }
  arrange(on, [], { stdout: lines([...CAPTURED.slice(0, 3), CODEX_FORM, ...CAPTURED.slice(10)]) }, { writes, dialog })
  await spawn($, on)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const first = await runTurn($)
  expect(first.calls).toContainEqual({ result: 'Handed to the main agent: the person chose "Let Claude answer".' })
  expect(sent(first.chunks)).toEqual([
    {
      id: expect.stringMatching(/^toolu_via_send_/),
      to: 'main',
      summary: 'codex asks you a question',
      message: handoff('the person chose "Let Claude answer"'),
    },
  ])
  expect(noQuestionAnswered(writes)).toBe(true)
  const reply = await $.tool.call({ tool: 'SendMessage', to: 'a1', message: 'Yes, and the footer too', tool_use_id: 'm1' })
  expect(reply.result).toEqual({
    success: true,
    message: 'Answered: {"question_0":"Yes","question_0_note":"and the footer too"} for codex, which goes on.',
  })
  const content = { question_0: 'Yes', question_0_note: 'and the footer too' }
  expect(inboxOf(writes)).toContain(JSON.stringify({ question: '7-k1-q1', answer: { action: 'accept', content } }))
  expect(inboxOf(writes)).not.toContain(JSON.stringify('Yes, and the footer too'))
  const { result } = await runOn($, first.result.index + 1)
  expect(result.answer).toContain('REDIRECTED')
})

test("the main agent's answer that fits no option is refused with why, and the question stays open for the next", async ($, on) => {
  const writes: Write[] = []
  const dialog = { shown: [] as Dialog[], answer: picked('Let Claude answer') }
  arrange(on, [], { stdout: lines([...CAPTURED.slice(0, 3), QUESTION, ...CAPTURED.slice(10)]) }, { writes, dialog })
  await spawn($, on)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const first = await runTurn($)
  const wrong = await $.tool.call({ tool: 'SendMessage', to: 'a1', message: 'qa', tool_use_id: 'm1' })
  expect(wrong.result).toEqual({
    success: false,
    message: 'Not passed on: "Which target?" takes one of "staging", "production". The question is still open; send the answer again.',
  })
  expect(noQuestionAnswered(writes)).toBe(true)
  const right = await $.tool.call({ tool: 'SendMessage', to: 'a1', message: 'production', tool_use_id: 'm2' })
  expect(right.result).toMatchObject({ success: true })
  expect(inboxOf(writes)).toContain(
    JSON.stringify({ question: '7-k1-q1', answer: { action: 'accept', content: { target: 'production' } } }),
  )
  await runOn($, first.result.index + 1)
})

test("past the person's askUserQuestionTimeout the dialog goes, and the question goes to the main agent", async ($, on) => {
  const writes: Write[] = []
  const dialog = { shown: [] as Dialog[], answer: never }
  const { clock } = arrange(
    on,
    [],
    { stdout: lines([...CAPTURED.slice(0, 3), CODEX_FORM, ...CAPTURED.slice(10)]) },
    { writes, dialog, timeout: '60s' },
  )
  await spawn($, on)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  let handed = false
  const turn = runTurn($).finally(() => {
    handed = true
  })
  await clock.settle()
  expect(dialog.shown).toHaveLength(1)
  await clock.advance(59_999)
  expect(handed).toBe(false)
  await clock.advance(1)
  const first = await turn
  expect(first.calls).toContainEqual({ result: "Handed to the main agent: the person didn't answer within 1 minute." })
  expect(sent(first.chunks)[0]?.message).toBe(handoff("the person didn't answer within 1 minute"))
  await $.tool.call({ tool: 'SendMessage', to: 'a1', message: 'Decline', tool_use_id: 'm1' })
  expect(inboxOf(writes)).toContain(JSON.stringify({ question: '7-k1-q1', answer: { action: 'decline' } }))
  await runOn($, first.result.index + 1)
})

test('with no one to ask (-p) the question goes straight to the main agent', async ($, on) => {
  const writes: Write[] = []
  const dialog = { shown: [] as Dialog[], answer: picked('Yes') }
  arrange(on, [], { stdout: lines([...CAPTURED.slice(0, 3), CODEX_FORM, ...CAPTURED.slice(10)]) }, { writes, dialog })
  await spawn($, on, true, true)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const first = await runTurn($)
  expect(dialog.shown).toEqual([])
  expect(sent(first.chunks)[0]?.message).toBe(handoff('no one can be asked in this session'))
  await $.tool.call({ tool: 'SendMessage', to: 'a1', message: 'No', tool_use_id: 'm1' })
  await runOn($, first.result.index + 1)
  expect(inboxOf(writes)).toContain(JSON.stringify({ question: '7-k1-q1', answer: { action: 'accept', content: { question_0: 'No' } } }))
})

test('a question handed while another waits on the main agent goes after it, so each answer reaches its own question', async ($, on) => {
  const writes: Write[] = []
  const props = CODEX_FORM.requestedSchema.properties
  const later = {
    ...CODEX_FORM,
    id: '7-k1-q2',
    requestedSchema: { ...CODEX_FORM.requestedSchema, properties: { ...props, question_0: { ...props.question_0, title: long(2) } } },
  }
  let open!: () => void
  const until = new Promise<void>((resolve) => {
    open = resolve
  })
  const pause = { first: lines([...CAPTURED.slice(0, 3), CODEX_FORM, later]), until }
  const { clock } = arrange(on, [], { stdout: lines(CAPTURED.slice(10)) }, { writes, unheld: true, pause })
  await spawn($, on, true, true)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const first = await runTurn($)
  expect(sent(first.chunks).map((s) => s.message)).toEqual([handoff('no one can be asked in this session')])
  const rest = runOn($, first.result.index + 1)
  await clock.settle()
  const answer = await $.tool.call({ tool: 'SendMessage', to: 'a1', message: 'No', tool_use_id: 'm1' })
  expect(answer.result).toEqual({ success: true, message: 'Answered: {"question_0":"No"} for codex, which goes on.' })
  expect(inboxOf(writes)).toContain(JSON.stringify({ question: '7-k1-q1', answer: { action: 'accept', content: { question_0: 'No' } } }))
  expect(inboxOf(writes).some((line) => line.includes('7-k1-q2'))).toBe(false)
  const more = await $.tool.call({ tool: 'SendMessage', to: 'a1', message: 'Yes, and keep going', tool_use_id: 'm0' })
  expect(more.result).toEqual({ success: true, message: 'Delivered to the running codex agent; codex reads it at its next step.' })
  expect(inboxOf(writes).some((line) => line.includes('7-k1-q2'))).toBe(false)
  await clock.advance(10_000)
  const second = await rest
  expect(second.calls).toContainEqual({
    result: 'Handed to the main agent, after the question it was already asked: no one can be asked in this session.',
  })
  expect(sent(second.chunks).map((s) => s.message)).toEqual([handoff('no one can be asked in this session').replace(long(1), long(2))])
  await $.tool.call({ tool: 'SendMessage', to: 'a1', message: 'Yes', tool_use_id: 'm2' })
  expect(inboxOf(writes)).toContain(JSON.stringify({ question: '7-k1-q2', answer: { action: 'accept', content: { question_0: 'Yes' } } }))
  open()
  const { result } = await runOn($, second.result.index + 1)
  expect(result.answer).toContain('REDIRECTED')
})

test('a hand-off whose run ended while it was being made is never sent, and nothing waits on its answer', async ($, on) => {
  const writes: Write[] = []
  const dialog = { shown: [] as Dialog[], answer: picked('Let Claude answer') }
  let list!: () => void
  const listed = new Promise<void>((resolve) => {
    list = resolve
  })
  const { clock } = arrange(
    on,
    [],
    { stdout: lines([...CAPTURED.slice(0, 3), CODEX_FORM, ...CAPTURED.slice(10)]) },
    { writes, dialog, agents: listed },
  )
  await spawn($, on)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const turn = runTurn($)
  await clock.settle()
  await $.turn.complete({ turnId: 't1', agentId: 'a1', answer: '', durationMs: 0, isAborted: true, reason: 'aborted' })
  list()
  const { calls, chunks } = await turn
  expect(calls).toContainEqual({ result: 'Not answered' })
  expect(sent(chunks)).toEqual([])
  expect(noQuestionAnswered(writes)).toBe(true)
})

test("a foreground agent's question offers no hand-off: its main agent hears nothing until the agent's turn ends", async ($, on) => {
  const writes: Write[] = []
  const dialog = { shown: [] as Dialog[], answer: picked('Yes') }
  arrange(on, [], { stdout: lines([...CAPTURED.slice(0, 3), CODEX_FORM, ...CAPTURED.slice(10)]) }, { writes, dialog })
  await spawn($, on, false)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const { chunks } = await runTurn($)
  expect(dialog.shown[0]?.[0]?.options.map((o) => o.label)).toEqual(['Yes', 'No'])
  expect(sent(chunks)).toEqual([])
  expect(inboxOf(writes)).toContain(JSON.stringify({ question: '7-k1-q1', answer: { action: 'accept', content: { question_0: 'Yes' } } }))
})

test('a question no one can be asked, from a foreground agent, goes back to codex as a cancel', async ($, on) => {
  const writes: Write[] = []
  arrange(on, [], { stdout: lines([...CAPTURED.slice(0, 3), CODEX_FORM, ...CAPTURED.slice(10)]) }, { writes })
  await spawn($, on, false, true)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const { calls, chunks } = await runTurn($)
  expect(sent(chunks)).toEqual([])
  expect(calls).toContainEqual({ result: 'Not answered' })
  expect(inboxOf(writes)).toContain(JSON.stringify({ question: '7-k1-q1', answer: { action: 'cancel' } }))
})

test("once codex withdraws a handed question, the main agent's late message is an ordinary steer", async ($, on) => {
  const writes: Write[] = []
  const dialog = { shown: [] as Dialog[], answer: picked('Let Claude answer') }
  const gate = () => {
    let open!: () => void
    const until = new Promise<void>((resolve) => {
      open = resolve
    })
    return { open, until }
  }
  const [withdraw, end] = [gate(), gate()]
  const closed = { relay: 'question_closed', id: CODEX_FORM.id }
  const pause = {
    first: lines([...CAPTURED.slice(0, 3), CODEX_FORM]),
    until: withdraw.until,
    second: { text: lines([closed]), until: end.until },
  }
  const { clock } = arrange(on, [], { stdout: lines(CAPTURED.slice(10)) }, { writes, dialog, unheld: true, pause })
  await spawn($, on)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const handed = await runTurn($)
  expect(sent(handed.chunks)).toHaveLength(1)
  const rest = runOn($, handed.result.index + 1)
  withdraw.open()
  await clock.settle()
  const late = await $.tool.call({ tool: 'SendMessage', to: 'a1', message: 'Yes', tool_use_id: 'm1' })
  expect(late.result).toEqual({ success: true, message: 'Delivered to the running codex agent; codex reads it at its next step.' })
  expect(inboxOf(writes)).toContain(JSON.stringify('Yes'))
  expect(noQuestionAnswered(writes)).toBe(true)
  end.open()
  await rest
})

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
  expect(result.answer).toContain('could not install codex-acp-2.10.0')
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

const COUNTER = {
  name: 'wait-counter',
  register(on: TestOn) {
    on('clock.after', async ($, e, next) => {
      await $.fs.write('/wait', `${e.ms}`)
      return next(e)
    })
  },
}

test(
  'a command that runs silent past the hook budget is waited on through the bounded engine wait',
  { plugins: [COUNTER] },
  async ($, on) => {
    const spawns: Spawn[] = []
    let finish!: () => void
    const finished = new Promise<void>((resolve) => {
      finish = resolve
    })
    const started = lines(CAPTURED.slice(0, 7))
    const ended = lines([
      {
        sessionId: SID,
        update: { toolCallId: 'exec-b50f', status: 'completed', rawOutput: { stdout: 'done\n' }, sessionUpdate: 'tool_call_update' },
      },
      chunk('msg_b', 'It finished.'),
      { relay: 'prompt_done', stopReason: 'end_turn', usage: null },
      { relay: 'done', stopReason: 'end_turn' },
    ])
    const writes: Write[] = []
    const waitsSoFar = () => writes.filter((w) => w.path === '/wait' && w.text === '5000').length
    const { clock } = arrange(on, spawns, { stdout: ended }, { writes, pause: { first: started, until: finished } })
    await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'run the long command' })
    const first = await run($)
    const tool = first.chunks.find((c) => c.kind === 'tool')
    expect(tool?.kind === 'tool' && tool.name).toBe('mcp__plugin_via_step__step')
    let answered = false
    const call = $.tool
      .call({
        tool: 'mcp__plugin_via_step__step',
        tool_use_id: tool?.kind === 'tool' ? tool.id : '',
        kind: 'execute',
        title: 'sleep 33',
      } as never)
      .then((r) => {
        answered = true
        return r
      })
    await clock.settle()
    const before = waitsSoFar()
    for (let s = 0; s < 6; s += 1) await clock.advance(5_000)
    expect(answered).toBe(false)
    expect(waitsSoFar() - before).toBeGreaterThanOrEqual(6)
    finish()
    expect(await call).not.toHaveProperty('deny')
    expect(JSON.stringify(await call)).toContain('done')
  },
)

test('with VIA_TRACE=1 a codex run asks the relay for a trace under ~/.claude/via/traces', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, undefined, { env: { VIA_TRACE: '1' } })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'run the tests' })
  await runTurn($)
  expect(spawns[0]?.env?.RELAY_TRACE).toMatch(/^\/home\/u\/\.claude\/via\/traces\/a1-\d+\.jsonl$/)
})

test('without VIA_TRACE a codex run asks for no trace', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'run the tests' })
  await runTurn($)
  expect(spawns[0]?.env).not.toHaveProperty('RELAY_TRACE')
})

test("a codex run hands the relay its Agent description as the new session's title", async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, undefined, { description: 'Review the parser' })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'run the tests' })
  await runTurn($)
  expect(spawns[0]?.env?.RELAY_TITLE).toBe('Review the parser')
})
