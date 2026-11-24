import { expect, mock, type TestBody, test } from 'claude-code/testing'
import type { AgentRecord } from '../hooks/record'
import { agentInfo, agentStore, ENV, hang, lines, NODE, node, ROOT, run, type Spawn } from './helpers'

// The agents tool as Claude calls it: what it reads back, what via runs, and what via's store holds after.
const TOOL = 'mcp__via__agents'
const MINUTE = 60_000
type Seeded = Partial<AgentRecord> & { harness: string }
type Ran = { argv: string[]; cwd?: string; env?: Record<string, string>; stdin?: string }
type TestOn = Parameters<TestBody>[1]
type TestDollar = Parameters<TestBody>[0]

// via's store as another session left it: records, and the index in spawn order (oldest first).
function stored(on: TestOn, records: Record<string, Seeded>) {
  const store = agentStore(on, records)
  store.held.set('agent-ids', Object.keys(records))
  return store
}

// Every process the tool runs, answered by `answer` (by argv); Node's own version check is answered as current.
function processes(on: TestOn, answer: (argv: string[]) => { exitCode: number; stdout: string } = () => ({ exitCode: 0, stdout: '' })) {
  const ran: Ran[] = []
  on('process.run', (_, e) => {
    if (e.argv[0] === 'node' && e.argv[1] === '-p') return { value: NODE }
    ran.push({ argv: [...e.argv], cwd: e.init?.cwd, env: e.init?.env, stdin: e.init?.stdin })
    return { value: { stderr: '', isStdoutTruncated: false, isStderrTruncated: false, ...answer([...e.argv]) } }
  })
  return ran
}

// Claude Code's dialog, answered with `label`, or dismissed; each question it was asked is kept.
function dialog(on: TestOn, label: string | 'dismiss') {
  const asked: string[] = []
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
    const questions = e.questions as { question: string }[]
    asked.push(...questions.map((q) => q.question))
    if (label === 'dismiss') return { deny: 'dismissed' }
    return { result: { questions, answers: { [questions[0]?.question ?? '']: label } } }
  })
  return asked
}

const call = async ($: TestDollar, input: Record<string, unknown>) => {
  const done = await $.tool.call({ tool: TOOL, tool_use_id: 'u1', ...input } as never)
  return { text: String(done.result), isError: 'isError' in done && done.isError === true }
}
const listed = async ($: TestDollar) => JSON.parse((await call($, { action: 'list' })).text) as Record<string, unknown>[]

const SERVICE_UP = (argv: string[]) => ({
  exitCode: 0,
  stdout: argv.join(' ') === 'opencode service status' ? 'http://127.0.0.1:4096\n' : '',
})

test("list shows via's agents newest first, each with the command that opens it in its harness, from the folder it ran in", async ($, on) => {
  mock.env(on, ENV)
  stored(on, {
    c1: { harness: 'codex', session: 'cs-1', cwd: '/work/my repo', description: 'fix the build' },
    n1: { harness: 'codex', nested: true, description: 'a subagent' },
    o1: { harness: 'opencode', session: 'ses_1', cwd: '/work/app', description: 'review' },
    p1: { harness: 'pi', cwd: '/work/app', description: 'docs' },
    g1: { harness: 'agy', session: 'conv-1', cwd: "/work/it's", description: 'plan' },
  })
  const ran = processes(on, SERVICE_UP)
  expect(await listed($)).toEqual([
    { agent: 'g1', harness: 'agy', title: 'plan', running: false, command: "cd '/work/it'\\''s' && agy --conversation conv-1" },
    { agent: 'p1', harness: 'pi', title: 'docs', running: false, command: 'cd /work/app && pi --session pi-p1' },
    {
      agent: 'o1',
      harness: 'opencode',
      title: 'review',
      running: false,
      command: 'cd /work/app && opencode -s ses_1',
      note: expect.stringContaining('same opencode version as the running service'),
    },
    { agent: 'c1', harness: 'codex', title: 'fix the build', running: false, command: "cd '/work/my repo' && codex resume cs-1" },
  ])
  // The service check runs from home, where opencode loads no project's plugins.
  expect(ran).toEqual([{ argv: ['opencode', 'service', 'status'], cwd: '/home/u', env: undefined, stdin: undefined }])
})

test('an OpenCode session is not offered while no background service runs, which opening it would start', async ($, on) => {
  mock.env(on, ENV)
  stored(on, { o1: { harness: 'opencode', session: 'ses_1', cwd: '/w' }, o2: { harness: 'opencode', session: 'ses_2', cwd: '/w' } })
  const ran = processes(on, () => ({ exitCode: 0, stdout: 'stopped\n' }))
  const agents = await listed($)
  expect(agents.map((a) => a.command)).toEqual([undefined, undefined])
  expect(String(agents[0]?.why)).toContain('`opencode service start`')
  // Asked once for the whole list.
  expect(ran).toHaveLength(1)
  const open = await call($, { action: 'open', agent: 'o1' })
  expect(open.isError).toBe(true)
  expect(open.text).toContain('anomalyco/opencode#51213')
})

test('open answers the command alone, and says when via has no folder for it', async ($, on) => {
  mock.env(on, ENV)
  stored(on, { c1: { harness: 'codex', session: 'cs-1', cwd: '/w' }, c2: { harness: 'codex', session: 'cs-2' }, c3: { harness: 'codex' } })
  processes(on)
  expect(await call($, { action: 'open', agent: 'c1' })).toEqual({ text: 'cd /w && codex resume cs-1', isError: false })
  expect((await call($, { action: 'open', agent: 'c2' })).text).toBe(
    'codex resume cs-2\n\nRun it in the folder the agent worked in: via did not record it.',
  )
  expect(await call($, { action: 'open', agent: 'c3' })).toEqual({
    text: "c3 can't be opened now: it has no codex session yet.",
    isError: true,
  })
  expect((await call($, { action: 'open', agent: 'zz' })).text).toBe('via has no record of agent zz: list shows the ones it has.')
})

test('a running pi agent is listed as running, and is not offered for opening until its run ends', async ($, on) => {
  const clock = mock.clock(on)
  const spawns: Spawn[] = []
  const store = hang(on, spawns)
  store.seed('a1', { harness: 'pi', cwd: '/w', description: 'long job' })
  store.held.set('agent-ids', ['a1'])
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const pending = run($)
  await clock.settle()
  expect(spawns).toHaveLength(1)
  const agents = await listed($)
  expect(agents[0]).toMatchObject({ agent: 'a1', running: true, why: expect.stringContaining('it is running') })
  const forgot = await call($, { action: 'forget', agent: 'a1' })
  expect(forgot).toEqual({ text: 'a1 is running: stop it, or wait for its answer, before forgetting it.', isError: true })
  await clock.advance(30 * 60 * 1000)
  await pending
})

test("forget, once the person says yes, has the relay delete the OpenCode session from home, then drops via's record", async ($, on) => {
  mock.env(on, ENV)
  const store = stored(on, {
    o1: { harness: 'opencode', session: 'ses_1', cwd: '/w', description: 'review' },
    c1: { harness: 'codex', session: 'cs-1', cwd: '/w' },
  })
  const asked = dialog(on, 'Forget it')
  const ran = processes(on, (argv) =>
    argv[1]?.endsWith('relay.mjs')
      ? { exitCode: 0, stdout: `${JSON.stringify({ relay: 'forgotten', sessionId: 'ses_1', how: 'deleted' })}\n` }
      : SERVICE_UP(argv),
  )
  const forgot = await call($, { action: 'forget', agent: 'o1' })
  expect(forgot).toEqual({ text: "Forgot o1: opencode session ses_1 deleted, and via's record removed.", isError: false })
  expect(asked).toEqual([
    'Forget the opencode agent "review" (o1)? This deletes its opencode session (ses_1) and via\'s record of it, so it can\'t be resumed.',
  ])
  expect(ran).toEqual([
    {
      argv: ['node', `${ROOT}/relay/relay.mjs`, '--', 'opencode', 'acp'],
      cwd: '/home/u',
      env: { RELAY_DELETE: 'ses_1' },
      stdin: '',
    },
  ])
  expect(store.record('o1')).toBeUndefined()
  expect(store.held.get('agent-ids')).toEqual(['c1'])
  expect((await listed($)).map((a) => a.agent)).toEqual(['c1'])
})

test('forget of a Codex agent says Codex keeps the session archived, and how to bring it back', async ($, on) => {
  mock.env(on, ENV)
  stored(on, { c1: { harness: 'codex', session: 'cs-1', cwd: '/w' } })
  dialog(on, 'Forget it')
  // codex-acp, installed as via installs it.
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false } }))
  const ran = processes(on, () => ({
    exitCode: 0,
    stdout: `${JSON.stringify({ relay: 'forgotten', sessionId: 'cs-1', how: 'deleted' })}\n`,
  }))
  const forgot = await call($, { action: 'forget', agent: 'c1' })
  expect(forgot.text).toBe(
    "Forgot c1: codex session cs-1 deleted (Codex keeps it archived: `codex unarchive cs-1` brings it back.), and via's record removed.",
  )
  expect(ran[0]?.argv.slice(0, 4)).toEqual(['node', `${ROOT}/relay/relay.mjs`, '--', 'node'])
  expect(ran[0]?.env).toEqual({ RELAY_DELETE: 'cs-1', CODEX_PATH: 'codex' })
})

test('forget does nothing when the person keeps the agent, or nobody answers', async ($, on) => {
  mock.env(on, ENV)
  const store = stored(on, { o1: { harness: 'opencode', session: 'ses_1', cwd: '/w' } })
  const ran = processes(on)
  dialog(on, 'Keep it')
  expect(await call($, { action: 'forget', agent: 'o1' })).toEqual({ text: 'Not forgotten: the person chose "Keep it".', isError: false })
  expect(ran).toEqual([])
  expect(store.record('o1')).toBeDefined()
})

test('a dismissed forget dialog deletes nothing', async ($, on) => {
  mock.env(on, ENV)
  const store = stored(on, { o1: { harness: 'opencode', session: 'ses_1', cwd: '/w' } })
  const ran = processes(on)
  dialog(on, 'dismiss')
  const forgot = await call($, { action: 'forget', agent: 'o1' })
  expect(forgot.isError).toBe(true)
  expect(forgot.text).toContain('Not forgotten: nobody answered')
  expect(ran).toEqual([])
  expect(store.record('o1')).toBeDefined()
})

test('forget is refused, with no dialog, for a harness that offers no delete', async ($, on) => {
  mock.env(on, ENV)
  const store = stored(on, { g1: { harness: 'agy', session: 'conv-1' }, p1: { harness: 'pi' } })
  const asked = dialog(on, 'Forget it')
  const ran = processes(on)
  for (const [agent, harness] of [
    ['g1', 'agy'],
    ['p1', 'pi'],
  ]) {
    const forgot = await call($, { action: 'forget', agent })
    expect(forgot).toEqual({
      text: `${harness} offers via no way to delete its sessions, so via keeps this agent: its session stays in ${harness}'s history.`,
      isError: true,
    })
  }
  expect(asked).toEqual([])
  expect(ran).toEqual([])
  expect(store.record('g1')).toBeDefined()
})

test('a delete the harness refuses keeps the record, and says why', async ($, on) => {
  mock.env(on, ENV)
  const store = stored(on, { o1: { harness: 'opencode', session: 'ses_1', cwd: '/w' } })
  dialog(on, 'Forget it')
  processes(on, () => ({
    exitCode: 1,
    stdout: `${JSON.stringify({ relay: 'error', message: 'the agent offers no way to delete or archive a session' })}\n`,
  }))
  const forgot = await call($, { action: 'forget', agent: 'o1' })
  expect(forgot).toEqual({
    text: 'Not forgotten: opencode did not delete session ses_1: the agent offers no way to delete or archive a session. via kept its record.',
    isError: true,
  })
  expect(store.record('o1')).toBeDefined()
})

test("a spawn records the session's folder, which a resume keeps", async ($, on) => {
  mock.env(on, ENV)
  const store = agentStore(on)
  let cwd = '/work/first'
  on('session.cwd', () => ({ value: cwd }))
  on('agent.spawn', () => ({ model: 'gpt', agentId: 'c1' }))
  const spawn = { tool_use_id: 'toolu_1', subagentType: 'via:codex', prompt: 'go', description: 'd' }
  const engine = { provider: { plugin: 'engine', tier: 'core' }, parentModel: 'haiku', background: true, fork: false } as const
  await $.agent.spawn({ ...spawn, ...engine })
  expect(store.record('c1')?.cwd).toBe('/work/first')
  cwd = '/work/second'
  await $.agent.spawn({ ...spawn, ...engine, resume: 'c1' } as never)
  expect(store.record('c1')?.cwd).toBe('/work/first')
})

test('the tool is registered at session start, behind ToolSearch', async ($, on) => {
  mock.env(on, { PATH: '', HOME: '/home/u' })
  on('session.model', () => ({ value: 'claude-haiku-5-5' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const registered: { name: string; isDeferred?: unknown; description: string }[] = []
  on('tool.register', (_, e) => {
    registered.push({ name: e.name, isDeferred: e.isDeferred, description: e.description })
    return { value: { tool: `mcp__via__${e.name}` } }
  })
  await $.session.start({ cwd: '/', surface: null, isInteractive: true })
  expect(registered).toEqual([{ name: 'agents', isDeferred: true, description: expect.stringContaining('- forget (agent)') }])
})

test("an agent another Claude Code session is running shows as running, and can't be opened mid-run or forgotten", async ($, on) => {
  mock.clock(on)
  mock.env(on, ENV)
  // Marked by the other session's run, which holds them for another minute.
  stored(on, {
    o1: { harness: 'opencode', session: 'ses_1', cwd: '/w', runningUntil: MINUTE },
    c1: { harness: 'codex', session: 'cs-1', cwd: '/w', runningUntil: MINUTE },
  })
  const asked = dialog(on, 'Forget it')
  const ran = processes(on, SERVICE_UP)
  const agents = await listed($)
  expect(agents.map((a) => [a.agent, a.running, a.command ?? a.why])).toEqual([
    ['c1', true, 'cd /w && codex resume cs-1'],
    ['o1', true, expect.stringContaining('it is running')],
  ])
  expect(await call($, { action: 'forget', agent: 'c1' })).toEqual({
    text: 'c1 is running: stop it, or wait for its answer, before forgetting it.',
    isError: true,
  })
  expect(asked).toEqual([])
  expect(ran.filter((r) => r.argv[1]?.endsWith('relay.mjs'))).toEqual([])
})

test('a run mark past its deadline is a session that died mid-run, and no longer holds its agent', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, ENV)
  stored(on, { p1: { harness: 'pi', cwd: '/w', runningUntil: 31 * MINUTE } })
  await clock.advance(31 * MINUTE)
  expect((await listed($))[0]).toMatchObject({ running: false, command: 'cd /w && pi --session pi-p1' })
})

test('a pi run marks its record while it runs, and clears the mark when it ends', async ($, on) => {
  const clock = mock.clock(on)
  const spawns: Spawn[] = []
  const store = hang(on, spawns)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const pending = run($)
  await clock.settle()
  // Held until its own 30 minutes are up, and a minute past.
  expect(store.record('a1')?.runningUntil).toBe(31 * MINUTE)
  await clock.advance(30 * 60 * 1000)
  await pending
  expect(store.record('a1')?.runningUntil).toBeUndefined()
})

test('forget deletes the session the store holds now, which another session may have set since this one last read it', async ($, on) => {
  mock.env(on, ENV)
  const store = stored(on, { o1: { harness: 'opencode', cwd: '/w' } })
  const asked = dialog(on, 'Forget it')
  const ran = processes(on, (argv) =>
    argv[1]?.endsWith('relay.mjs')
      ? { exitCode: 0, stdout: `${JSON.stringify({ relay: 'forgotten', sessionId: 'ses_new', how: 'deleted' })}\n` }
      : SERVICE_UP(argv),
  )
  // Read once here: no session yet.
  expect((await listed($))[0]?.why).toBe('it has no opencode session yet.')
  // Then another session's run gets one.
  store.seed('o1', { harness: 'opencode', session: 'ses_new' })
  expect((await call($, { action: 'forget', agent: 'o1' })).text).toBe(
    "Forgot o1: opencode session ses_new deleted, and via's record removed.",
  )
  expect(asked[0]).toContain('(ses_new)')
  expect(ran.find((r) => r.argv[1]?.endsWith('relay.mjs'))?.env).toEqual({ RELAY_DELETE: 'ses_new' })
})

test('forget deletes nothing when the session changes, or a run starts, while the person is asked', async ($, on) => {
  mock.clock(on)
  mock.env(on, ENV)
  const store = stored(on, {
    o1: { harness: 'opencode', session: 'ses_1', cwd: '/w' },
    o2: { harness: 'opencode', session: 'ses_2', cwd: '/w' },
  })
  const ran = processes(on)
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
    const questions = e.questions as { question: string }[]
    const question = questions[0]?.question ?? ''
    // Meanwhile, elsewhere: o1's session is replaced; o2 starts a run.
    if (question.includes('(o1)')) store.seed('o1', { session: 'ses_9' })
    else store.seed('o2', { runningUntil: MINUTE })
    return { result: { questions, answers: { [question]: 'Forget it' } } }
  })
  expect(await call($, { action: 'forget', agent: 'o1' })).toEqual({
    text: "Not forgotten: o1's session changed while you were asked. Ask again.",
    isError: true,
  })
  expect(await call($, { action: 'forget', agent: 'o2' })).toEqual({
    text: 'o2 is running: stop it, or wait for its answer, before forgetting it.',
    isError: true,
  })
  expect(ran).toEqual([])
  expect(store.record('o1')).toBeDefined()
  expect(store.record('o2')).toBeDefined()
})

test(
  "a pi agent's mark is held by its own timeoutMinutes, and an interrupt's run holds it again from then",
  { options: { timeoutMinutes: 120 } },
  async ($, on) => {
    const clock = mock.clock(on)
    mock.env(on, ENV)
    const store = agentStore(on, { a1: { harness: 'pi' } })
    on('agent.list', () => ({ value: [agentInfo({ id: 'a1', description: 'x', type: 'via:pi' })] }))
    on('turn.start', (_, e) => ({ turnId: e.turnId }))
    on('turn.complete', (_, e, next) => next(e))
    on('session.messages', () => ({ value: [] }))
    node(on)
    let interrupted!: () => void
    const asked = new Promise<void>((resolve) => {
      interrupted = resolve
    })
    on('fs.write', (_, e) => {
      if (e.text.includes('"interrupt"')) interrupted()
      return { value: undefined }
    })
    const marks: (number | undefined)[] = []
    let spawned = 0
    on('process.spawn', async function* () {
      spawned += 1
      marks.push(store.record('a1')?.runningUntil)
      if (spawned === 1) {
        yield {
          stream: 'stdout' as const,
          text: `${JSON.stringify({ type: 'message_start', message: { role: 'assistant', provider: 'openrouter', model: 'kimi' } })}\n`,
        }
        await asked
        // What pi prints when its extension aborts the step.
        const aborted = {
          type: 'message_end',
          message: { role: 'assistant', stopReason: 'error', errorMessage: 'This operation was aborted', usage: { input: 1, output: 1 } },
        }
        yield { stream: 'stdout' as const, text: `${JSON.stringify(aborted)}\n` }
        return { value: { code: 0, signal: null } }
      }
      yield { stream: 'stdout' as const, text: lines }
      return { value: { code: 0, signal: null } }
    })
    await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
    const pending = run($)
    await clock.settle()
    await clock.advance(100 * MINUTE)
    await $.tool.call({ tool: 'SendMessage', to: 'a1', message: 'interrupt: now do C', tool_use_id: 'i' })
    await pending
    // The first run until 121 minutes; the interrupt's, started at 100, until 221.
    expect(marks).toEqual([121 * MINUTE, 221 * MINUTE])
    expect(store.record('a1')?.runningUntil).toBeUndefined()
  },
)
