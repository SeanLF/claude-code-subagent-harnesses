import { expect, mock, test } from 'claude-code/testing'

import { pi } from '../hooks/adapters/pi'
import { stepOf } from '../hooks/progress'
import { run as runHook } from '../hooks/run'
import type { World } from '../hooks/world'
import { ENV, hang, hold, run, type Spawn, type Write } from './helpers'

const START = { type: 'message_start', message: { role: 'assistant', provider: 'openrouter', model: 'kimi' } }
const TOOL = { type: 'tool_execution_start', toolName: 'bash', args: { command: 'npm test' } }
const END = { type: 'message_end', message: { role: 'assistant', usage: { input: 1, output: 1 } } }
const TEXT = { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'done' } }
const ROW = '/home/u/.claude/via/rows/a1.jsonl'
const rows = (writes: Write[]) => writes.filter((write) => write.path === ROW).map((write) => write.text)

async function spawn($: Parameters<typeof run>[0], description: string) {
  await $.agent.spawn({
    tool_use_id: 'toolu_spawn',
    subagentType: 'via:pi',
    prompt: 'run the tests',
    description,
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'haiku',
    background: false,
    fork: false,
  })
}

test("a running via agent writes its latest step to its agent-panel row", async ($, on) => {
  const clock = mock.clock(on)
  const spawns: Spawn[] = []
  const writes: Write[] = []
  const { release } = hold(on, spawns, writes, [START, TOOL], [TEXT, END])
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'a1' }))
  await spawn($, 'run the tests')
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: '' })
  const pending = run($)
  await clock.settle()
  expect(writes.filter((write) => write.path === ROW).at(-1)?.text).toBe(
    `${JSON.stringify({ id: 'a1', content: 'via:pi · run the tests · ▸ bash: {"command":"npm test"} · 1 step' })}\n`,
  )
  release()
  await pending
})

test('a finished via agent clears its agent-panel row', async ($, on) => {
  const clock = mock.clock(on)
  const spawns: Spawn[] = []
  const writes: Write[] = []
  const { release } = hold(on, spawns, writes, [START, TOOL], [TEXT, END])
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'a1' }))
  await spawn($, 'run the tests')
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: '' })
  const pending = run($)
  await clock.settle()
  release()
  await pending
  expect(writes.filter((write) => write.path === ROW).at(-1)?.text).toBe('')
})

test('a description and tool name with escape sequences reach the row without control characters', async ($, on) => {
  const clock = mock.clock(on)
  const spawns: Spawn[] = []
  const writes: Write[] = []
  const evil = { ...TOOL, toolName: 'bash\u001b[2J\u0007' }
  const { release } = hold(on, spawns, writes, [START, evil], [TEXT, END])
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'a1' }))
  await spawn($, 'run\u001b[2J tests')
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: '' })
  const pending = run($)
  await clock.settle()
  const content = (JSON.parse(writes.filter((write) => write.path === ROW).at(-1)?.text ?? '""') as { content: string }).content
  expect(content).toBe('via:pi · run[2J tests · ▸ bash[2J: {"command":"npm test"} · 1 step')
  expect(content).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/)
  release()
  await pending
})

test('a run starts by clearing its agent-panel row, before its first step', async ($, on) => {
  const clock = mock.clock(on)
  const spawns: Spawn[] = []
  const writes: Write[] = []
  const { release } = hold(on, spawns, writes, [START, TOOL], [TEXT, END])
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'a1' }))
  await spawn($, 'run the tests')
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: '' })
  const pending = run($)
  await clock.settle()
  const rows = writes.filter((write) => write.path === ROW)
  expect(rows[0]?.text).toBe('')
  expect(rows[1]?.text).toContain('▸ bash')
  release()
  await pending
})

test('an aborted run clears its agent-panel row', async () => {
  const writes: Write[] = []
  const stop = new AbortController()
  let stepped!: () => void
  const step = new Promise<void>((resolve) => {
    stepped = resolve
  })
  const world: World = {
    adapters: new Map([['pi', pi]]),
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
  const $ = {
    env: { get: async (name: string) => (name === 'HOME' ? '/home/u' : undefined) },
    fs: {
      write: async (path: string, text: string) => {
        writes.push({ path, text })
        if (text.includes('▸ bash')) stepped()
      },
    },
    clock: { after: () => ({ cancel: () => {} }) },
    process: {
      spawn: async function* () {
        yield { stream: 'stdout' as const, text: [START, TOOL].map((event) => JSON.stringify(event)).join('\n') + '\n' }
        await new Promise<void>((resolve) => {
          if (stop.signal.aborted) resolve()
          else stop.signal.addEventListener('abort', () => resolve(), { once: true })
        })
        return { code: 0, signal: null }
      },
    },
    plugin: { root: '/' },
  } as unknown as Parameters<typeof runHook>[2]
  const input = { agentId: 'a1', choice: {}, prompt: 'go', signal: stop.signal, inbox: undefined, session: undefined, guard: undefined, mode: 'default' as const }
  const stream = runHook(world, pi, $, { turnId: 't1', index: 0 }, { ...input, probe: async () => undefined, save: async () => {} })
  const pending = (async () => {
    for (;;) if ((await stream.next()).done) return
  })()
  await step
  stop.abort()
  await pending
  expect(rows(writes)).toEqual(['', expect.stringContaining('▸ bash'), ''])
})

test('a run stopped at the time limit clears its agent-panel row', async ($, on) => {
  const clock = mock.clock(on)
  const spawns: Spawn[] = []
  const writes: Write[] = []
  hang(on, spawns, writes, ENV, [START, TOOL])
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const pending = run($)
  await clock.settle()
  await clock.advance(30 * 60 * 1000)
  await pending
  expect(rows(writes).slice(-2)).toEqual([expect.stringContaining('▸ bash'), ''])
})

test('an empty description leaves out its agent-panel row segment', async ($, on) => {
  const clock = mock.clock(on)
  const spawns: Spawn[] = []
  const writes: Write[] = []
  const { release } = hold(on, spawns, writes, [START, TOOL], [TEXT, END])
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'a1' }))
  await spawn($, '')
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: '' })
  const pending = run($)
  await clock.settle()
  const row = writes.filter((write) => write.path === ROW).at(-1)?.text ?? ''
  expect((JSON.parse(row) as { content: string }).content).toBe('via:pi · ▸ bash: {"command":"npm test"} · 1 step')
  release()
  await pending
})

test('with no home folder no agent-panel row is written', async ($, on) => {
  const clock = mock.clock(on)
  const spawns: Spawn[] = []
  const writes: Write[] = []
  const { release } = hold(on, spawns, writes, [START, TOOL], [TEXT, END], { TMPDIR: '/tmp' })
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'a1' }))
  await spawn($, 'run the tests')
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: '' })
  const pending = run($)
  await clock.settle()
  release()
  await pending
  expect(writes.some((write) => write.path.includes('/.claude/via/rows/'))).toBe(false)
})

test('a step drops control characters, so a harness tool name cannot send escape sequences to the terminal', () => {
  expect(stepOf('\n▸ evil\u001b[2J\u001b]0;pwned\u0007: {"a":1}\n')).toBe('evil[2J]0;pwned: {"a":1}')
})
