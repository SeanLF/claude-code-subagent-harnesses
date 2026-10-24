import type { TurnStepChunk } from 'claude-code'
import { expect, mock, test, type TestBody } from 'claude-code/testing'

import { opencode, opencodeRun } from '../../hooks/adapters/opencode'
import { run as runHook } from '../../hooks/run'
import type { World } from '../../hooks/world'
import { ROOT, STEP } from '../helpers'

type TestOn = Parameters<TestBody>[1]
type Spawn = { argv: string[]; input: string | undefined; env?: Record<string, string> }
type Write = { path: string; text: string }

const SID = 'ses_e91343cb9ffesi5kO9k3QFHJV4'
const chunk = (messageId: string, text: string) => ({ sessionId: SID, update: { content: { text, type: 'text' }, messageId, sessionUpdate: 'agent_message_chunk' } })
// Captured from relay/relay.mjs over `opencode acp` (opencode 1.19.4, OpenRouter DeepSeek, 2026-10-24):
// opencode names a tool `bash` first and its command only in the update that starts it.
const CAPTURED = [
  { via: 'session', sessionId: SID },
  { via: 'model', name: 'openrouter/~deepseek/deepseek-flash-latest' },
  { via: 'steered' },
  chunk('msg_1', 'Running it.'),
  { sessionId: SID, update: { toolCallId: 'call_1', title: 'bash', kind: 'execute', status: 'pending', sessionUpdate: 'tool_call' } },
  { sessionId: SID, update: { toolCallId: 'call_1', title: 'echo hi > asked.txt', kind: 'execute', status: 'in_progress', sessionUpdate: 'tool_call_update' } },
  { sessionId: SID, update: { toolCallId: 'call_1', title: 'echo hi > asked.txt', kind: 'execute', status: 'completed', sessionUpdate: 'tool_call_update' } },
  chunk('msg_2', 'DONE'),
  { sessionId: SID, update: { used: 11136, size: 1048576, cost: { amount: 0.00022576, currency: 'USD' }, sessionUpdate: 'usage_update' } },
  { via: 'prompt_done', stopReason: 'end_turn', usage: { inputTokens: 9344, outputTokens: 12, totalTokens: 11148, cachedReadTokens: 1792 } },
  { via: 'done', stopReason: 'end_turn' },
]
const lines = (events: unknown[]) => events.map((e) => JSON.stringify(e)).join('\n') + '\n'
const AGENT = { id: 'a1', description: 'x', type: 'via:opencode', status: 'running' } as const

function arrange(on: TestOn, spawns: Spawn[], out: { stdout?: string; stderr?: string; code?: number } = { stdout: lines(CAPTURED) }, o: { mode?: string; writes?: Write[] } = {}) {
  mock.clock(on)
  mock.env(on, { HOME: '/home/u' })
  on('agent.list', () => ({ value: [AGENT] }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e, next) => next(e))
  on('session.messages', () => ({ value: [] }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '24.11.0\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('state.get', (_, e, next) => (e.key === 'modes' && o.mode ? { value: { value: o.mode, version: 1 } } : next(e)))
  on('fs.write', (_, e) => {
    o.writes?.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('process.spawn', async function* (_, e) {
    spawns.push({ argv: [...e.argv], input: e.input, env: e.env })
    if (out.stdout) yield { stream: 'stdout' as const, text: out.stdout }
    if (out.stderr) yield { stream: 'stderr' as const, text: out.stderr }
    return { value: { code: out.code ?? 0, signal: null } }
  })
}

async function run($: Parameters<TestBody>[0], step: typeof STEP = STEP) {
  const chunks: TurnStepChunk[] = []
  const stream = $.turn.step(step)
  for (;;) {
    const next = await stream.next()
    if (next.done) return { chunks, result: next.value }
    chunks.push(next.value)
  }
}

const injected = (spawn: Spawn | undefined) => JSON.parse(spawn?.env?.OPENCODE_CONFIG_CONTENT ?? '{}') as { lsp?: boolean; agent?: Record<string, { permission: Record<string, unknown> }> }

test('an opencode agent runs `opencode acp` behind the relay, with its prompt on stdin', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'run the tests' })
  await run($)
  expect(spawns[0]?.argv).toEqual(['node', `${ROOT}/relay/relay.mjs`, '--', 'opencode', 'acp'])
  expect(spawns[0]?.input).toBe('run the tests')
})

test('only the last message is the answer, signed with the session model; a tool shows once, with its command', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const { chunks, result } = await run($)
  expect(result.answer).toBe('DONE\n\n— answered by opencode, openrouter/~deepseek/deepseek-flash-latest')
  expect(result.usage?.input_tokens).toBe(11136)
  const tools = chunks.filter((c) => c.kind === 'text' && c.text.includes('▸ execute'))
  expect(tools.map((c) => (c as { text: string }).text)).toEqual(['\n▸ execute: echo hi > asked.txt\n'])
})

test("outside read-only via injects no agent: opencode runs with the person's own permissions, and its questions reach them", async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  await run($)
  expect(spawns[0]?.env?.OPENCODE_CONFIG_CONTENT).toBeUndefined()
  expect(spawns[0]?.env?.OPENCODE_DISABLE_PROJECT_CONFIG).toBeUndefined()
  expect(spawns[0]?.env?.VIA_POLICY).toBe('ask')
})

test("only read-only injects an agent; otherwise the permission mode decides how opencode's own questions are answered", () => {
  expect(opencodeRun({}, 'default', 'a1')).toEqual({ policy: 'ask' })
  expect(opencodeRun({}, 'acceptEdits', 'a1')).toEqual({ policy: 'ask' })
  expect(opencodeRun({}, 'auto', 'a1')).toEqual({ policy: 'ask' })
  expect(opencodeRun({}, 'bypassPermissions', 'a1')).toEqual({ policy: 'allow' })
  expect(opencodeRun({}, 'dontAsk', 'a1')).toEqual({ policy: 'deny' })
  expect(opencodeRun({}, 'plan', 'a1')).toEqual({ agent: 'via-read-a1', policy: 'deny' })
  expect(opencodeRun({ tools: 'read' }, 'bypassPermissions', 'a1')).toEqual({ agent: 'via-read-a1', policy: 'deny' })
})

test('tools: read runs a deny-by-default agent with no project config, no LSP, no web, and .env unreadable', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns)
  tree(on, () => undefined)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'tools: read\nlook' })
  await run($)
  const config = injected(spawns[0])
  const permission = config.agent?.['via-read-a1']?.permission ?? {}
  expect(config.lsp).toBe(false)
  expect(permission['*']).toBe('deny')
  expect(permission.bash).toBeUndefined()
  expect(permission.webfetch).toBeUndefined()
  expect(permission.read).toEqual({ '*': 'allow', '*.env': 'deny', '*.env.*': 'deny', '*.env.example': 'allow' })
  expect(spawns[0]?.env).toMatchObject({ OPENCODE_DISABLE_PROJECT_CONFIG: '1', VIA_POLICY: 'deny', VIA_CONFIG: JSON.stringify({ mode: 'via-read-a1' }) })
})

test("a bypass-mode run injects nothing, so the person's own opencode setup applies", async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, undefined, { mode: 'bypassPermissions' })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  await run($)
  expect(spawns[0]?.env?.OPENCODE_CONFIG_CONTENT).toBeUndefined()
  expect(spawns[0]?.env?.VIA_CONFIG).toBeUndefined()
  expect(spawns[0]?.env?.VIA_POLICY).toBe('allow')
})

test("a thinking line becomes opencode's effort config option", async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'thinking: high\ngo' })
  await run($)
  expect(JSON.parse(spawns[0]?.env?.VIA_CONFIG ?? '{}')).toEqual({ effort: 'high' })
})

test('a lost session fails in plain words and is forgotten', async ($, on) => {
  const spawns: Spawn[] = []
  const saved: unknown[] = []
  arrange(on, spawns, { stdout: lines([{ via: 'session_lost', message: 'Session not found' }]), stderr: 'via relay: session lost: Session not found\n', code: 1 })
  on('state.set', (_, e, next) => {
    if (e.key === 'sessions') saved.push(e.value)
    return next(e)
  })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const { result } = await run($)
  expect(result.answer).toContain("opencode could not find this agent's earlier session")
  expect(saved).toEqual([''])
})

test('an aborted run saves a session id in an unterminated tail without showing its text', async () => {
  const saved: unknown[] = []
  const world: World = {
    adapters: new Map([['opencode', opencode]]),
    defaultModel: '',
    codexAcp: 'pinned',
    installs: new Map(),
    timeoutMinutes: 30,
    turns: new Map(),
    seeds: new Map(),
    handbacks: new Map(),
    modes: new Map(),
    agents: new Map(),
    others: new Set(),
    inboxes: new Map(),
    descriptions: new Map(),
    activity: new Map(),
  }
  const stop = new AbortController()
  let read!: () => void
  const readPiece = new Promise<void>((resolve) => {
    read = resolve
  })
  const child = async function* () {
    yield { stream: 'stdout' as const, text: `${JSON.stringify({ via: 'steered' })}\n${JSON.stringify(chunk('m', 'trailing text'))}\n${JSON.stringify({ via: 'session', sessionId: SID })}` }
    read()
    await new Promise<void>((resolve) => stop.signal.addEventListener('abort', () => resolve(), { once: true }))
    return { code: 0, signal: null }
  }
  const $ = {
    env: { get: async () => undefined },
    fs: { write: async () => undefined },
    clock: { after: () => ({ cancel: () => {} }) },
    process: { spawn: child },
    plugin: { root: '/' },
  } as unknown as Parameters<typeof runHook>[2]
  const stream = runHook(world, opencode, $, { turnId: 't1', index: 0 }, {
    agentId: 'a1',
    choice: {},
    prompt: 'long job',
    signal: stop.signal,
    inbox: undefined,
    session: undefined,
    guard: undefined,
    mode: 'default',
    probe: async () => undefined,
    save: async (id) => {
      saved.push(id)
    },
  })
  const pending = (async () => {
    for (;;) if ((await stream.next()).done) return
  })()
  await readPiece
  stop.abort()
  await pending
  expect(saved).toEqual([SID])
})

function tree(on: TestOn, at: (cwd: string) => { path: string; holds: string[] } | undefined) {
  let cwd: string | undefined
  on('fs.stat', (_, e) => {
    cwd ??= e.path.replace(/\/\.opencode$/, '')
    if (e.path.endsWith('/.opencode') && e.path !== at(cwd)?.path) throw new Error('ENOENT')
    return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: e.path } }
  })
  on('fs.list', (_, e) => ({ value: (at(cwd ?? '')?.holds ?? []).map((name) => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })) }))
}
const parent = (path: string) => path.replace(/\/[^/]+$/, '') || '/'

test('tools: read is refused under a .opencode folder, which opencode runs code from on every run', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns)
  tree(on, (cwd) => ({ path: `${parent(cwd)}/.opencode`, holds: ['agents', 'opencode.json'] }))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'tools: read\nlook around' })
  const { result } = await run($)
  expect(spawns).toHaveLength(0)
  expect(result.answer).toContain('opencode cannot run read-only here')
  expect(result.answer).toContain('/.opencode)')
})

test('plan mode is refused under a .opencode folder too', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, undefined, { mode: 'plan' })
  tree(on, (cwd) => ({ path: `${parent(cwd)}/.opencode`, holds: ['plugins'] }))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'look around' })
  const { result } = await run($)
  expect(spawns).toHaveLength(0)
  expect(result.answer).toContain('opencode cannot run read-only here')
})

test('~/.opencode as the installer and opencode leave it (bin, .gitignore) does not void read-only', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns)
  tree(on, (cwd) => ({ path: `${parent(cwd)}/.opencode`, holds: ['bin', '.gitignore'] }))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'tools: read\nlook around' })
  await run($)
  expect(spawns[0]?.env?.VIA_CONFIG).toBe(JSON.stringify({ mode: 'via-read-a1' }))
})

test('a walk that cannot finish, as when a hook withholds realPath, refuses read-only rather than assuming it is safe', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns)
  on('fs.stat', (_, e) => {
    if (e.path.endsWith('/.opencode')) throw new Error('ENOENT')
    return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } }
  })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'tools: read\nlook around' })
  const { result } = await run($)
  expect(spawns).toHaveLength(0)
  expect(result.answer).toContain('could not all be checked for .opencode')
})
