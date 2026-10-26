import { expect, mock, test } from 'claude-code/testing'
import { pi } from '../../hooks/adapters/pi'
import { arrange, lines, run, runTurn, type Spawn, split } from '../helpers'

const CWD = '/work/repo'
// Captured from `pi -p --mode json` (pi 1.4.0, OpenRouter GLM flash, 2026-10-25), trimmed to the fields read.
const CAPTURED = [
  { type: 'session', version: 3, id: 'cap', cwd: CWD },
  { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'read', args: { path: 'a.txt' } },
  {
    type: 'tool_execution_end',
    toolCallId: 'c1',
    toolName: 'read',
    result: { content: [{ type: 'text', text: 'hello\nworld\n' }] },
    isError: false,
  },
  {
    type: 'tool_execution_start',
    toolCallId: 'c2',
    toolName: 'edit',
    args: { edits: [{ newText: 'there', oldText: 'world' }], path: 'a.txt' },
  },
  {
    type: 'tool_execution_end',
    toolCallId: 'c2',
    toolName: 'edit',
    result: {
      content: [{ type: 'text', text: 'Successfully replaced 1 block(s) in a.txt.' }],
      details: { diff: ' 1 hello\n-2 world\n+2 there', patch: '--- a.txt\n+++ a.txt\n@@ -1,2 +1,2 @@\n hello\n-world\n+there\n' },
    },
    isError: false,
  },
  { type: 'tool_execution_start', toolCallId: 'c3', toolName: 'write', args: { content: 'new', path: `${CWD}/b.txt` } },
  {
    type: 'tool_execution_end',
    toolCallId: 'c3',
    toolName: 'write',
    result: { content: [{ type: 'text', text: 'Successfully wrote to b.txt' }] },
    isError: false,
  },
  { type: 'tool_execution_start', toolCallId: 'c4', toolName: 'bash', args: { command: 'ls; exit 3', timeout: 30 } },
  { type: 'tool_execution_update', toolCallId: 'c4', toolName: 'bash', partialResult: { content: [{ type: 'text', text: 'a.txt\n' }] } },
  {
    type: 'tool_execution_end',
    toolCallId: 'c4',
    toolName: 'bash',
    result: { content: [{ type: 'text', text: 'a.txt\nb.txt\n\n\nCommand exited with code 3' }], isError: true },
    isError: true,
  },
  { type: 'tool_execution_start', toolCallId: 'c5', toolName: 'mcp__radius__query', args: { q: 'x' } },
]

test('a prompt starting with @ reaches pi as the message, not as a file argument', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: '@README.md summarise this' })
  await run($)
  expect(spawns[0]?.argv.some((arg) => arg.startsWith('@'))).toBe(false)
  expect(spawns[0]?.env).toEqual({ PI_INBOX: '/home/u/.claude/via/inbox/pi-a1.jsonl' })
  expect(spawns[0]?.input).toBe('@README.md summarise this')
})

test('the session registers an agent type only for a harness on PATH', async ($, on) => {
  const seen: unknown[] = []
  mock.env(on, { PATH: '/usr/bin:/opt/pi/bin' })
  on('fs.stat', (_, e) => {
    if (e.path !== '/opt/pi/bin/pi') throw new Error('ENOENT')
    return { value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const tools: unknown[] = []
  on('agent.register', (_, e) => {
    seen.push(e.name)
    tools.push(...(e.tools ?? []))
    return { value: { agent: `pi:${e.name}` } }
  })
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  expect(seen).toEqual(['pi'])
  // Its agent can call the tool of via's step server, which reports the harness's tool calls.
  expect(tools).toEqual(['mcp__plugin_via_step__step'])
})

test('a read-only tool list ignores the project trust-gated .pi resources; a list with a writing tool keeps them', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'tools: read,grep,find,ls\ngo' })
  await run($)
  expect(spawns[0]?.argv.slice(-3)).toEqual(['--tools', 'read,grep,find,ls', '-na'])
  await $.turn.start({ turnId: 't2', agentId: 'a1', text: 'tools: read,bash\ngo' })
  await run($, { turnId: 't2', index: 0, model: 'haiku', messageCount: 2, agentId: 'a1' })
  expect(spawns[1]?.argv.slice(-2)).toEqual(['--tools', 'read,bash'])
})

test('pi needs a current Node too, for the step server, and says so instead of running', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines), 0, [], undefined, '20.19.0\n')
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const { result } = await run($)
  expect(spawns).toHaveLength(0)
  expect(result.answer).toContain('via needs Node 22.18 or later on PATH to run pi, not 20.19.0')
})

test("pi's tool calls become rows: an edit as its patch's changed lines, a write as its lines, a failed command with its output", () => {
  const parse = pi.events()
  expect(CAPTURED.flatMap((e) => parse(JSON.stringify(e)))).toEqual([
    { k: 'call', id: 'c1', kind: 'read', title: 'Read a.txt', path: `${CWD}/a.txt` },
    { k: 'called', id: 'c1', output: 'hello\nworld', failed: false },
    { k: 'call', id: 'c2', kind: 'edit', title: 'Edit a.txt', path: `${CWD}/a.txt` },
    { k: 'called', id: 'c2', output: 'a.txt\n- world\n+ there', failed: false },
    { k: 'call', id: 'c3', kind: 'edit', title: 'Write b.txt', path: `${CWD}/b.txt` },
    { k: 'called', id: 'c3', output: 'b.txt\n+ new', failed: false },
    { k: 'call', id: 'c4', kind: 'execute', title: 'ls; exit 3' },
    { k: 'called', id: 'c4', output: 'a.txt\nb.txt\n\n\nCommand exited with code 3', failed: true },
    { k: 'call', id: 'c5', kind: 'other', title: 'mcp__radius__query: {"q":"x"}' },
  ])
})

test("an edit's removed line that starts with -- is a changed line, not the patch header", () => {
  const parse = pi.events()
  parse(JSON.stringify({ type: 'tool_execution_start', toolCallId: 'e', toolName: 'edit', args: { path: 'a.md' } }))
  const patch = '--- a.md\n+++ a.md\n@@ -1 +1 @@\n--- old rule\n+--- new rule\n'
  expect(parse(JSON.stringify({ type: 'tool_execution_end', toolCallId: 'e', toolName: 'edit', result: { details: { patch } } }))).toEqual([
    { k: 'called', id: 'e', output: 'a.md\n- -- old rule\n+ --- new rule', failed: false },
  ])
})

test('an edit whose patch has no hunk reports its text, not the patch header as changed lines', () => {
  const parse = pi.events()
  parse(JSON.stringify({ type: 'tool_execution_start', toolCallId: 'e', toolName: 'edit', args: { path: 'a.md' } }))
  const result = { content: [{ type: 'text', text: 'No changes made to a.md.' }], details: { patch: '--- a.md\n+++ a.md\n' } }
  expect(parse(JSON.stringify({ type: 'tool_execution_end', toolCallId: 'e', toolName: 'edit', result }))).toEqual([
    { k: 'called', id: 'e', output: 'No changes made to a.md.', failed: false },
  ])
})

test('a failed write reports its error, not lines that never landed', () => {
  const parse = pi.events()
  parse(JSON.stringify({ type: 'tool_execution_start', toolCallId: 'w', toolName: 'write', args: { path: 'b.txt', content: 'new' } }))
  const result = { content: [{ type: 'text', text: 'EACCES: permission denied, open b.txt' }] }
  expect(parse(JSON.stringify({ type: 'tool_execution_end', toolCallId: 'w', toolName: 'write', result, isError: true }))).toEqual([
    { k: 'called', id: 'w', output: 'EACCES: permission denied, open b.txt', failed: true },
  ])
})

test("a long failing command keeps its end, where the error and pi's exit code are", () => {
  const parse = pi.events()
  parse(JSON.stringify({ type: 'tool_execution_start', toolCallId: 'b', toolName: 'bash', args: { command: 'npm test' } }))
  const passing = Array.from({ length: 200 }, (_, i) => `ok test ${i}`).join('\n')
  const text = `${passing}\nFAIL: assertion\n\n\nCommand exited with code 1`
  const [called] = parse(
    JSON.stringify({
      type: 'tool_execution_end',
      toolCallId: 'b',
      toolName: 'bash',
      result: { content: [{ type: 'text', text }] },
      isError: true,
    }),
  )
  if (called?.k !== 'called') throw new Error('no called event')
  expect(called.output.startsWith('…')).toBe(true)
  expect(called.output.endsWith('FAIL: assertion\n\n\nCommand exited with code 1')).toBe(true)
  expect(called.failed).toBe(true)
})

test("pi's command ends the step with a call to via's tool, and the turn ends with its answer", async ($, on) => {
  const spawns: Spawn[] = []
  const events = [
    { type: 'message_start', message: { role: 'assistant', provider: 'openrouter', model: 'kimi' } },
    { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: { command: 'ls' } },
    {
      type: 'tool_execution_end',
      toolCallId: 'c1',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'a.txt' }] },
      isError: false,
    },
    { type: 'message_start', message: { role: 'assistant', provider: 'openrouter', model: 'kimi' } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'done' } },
    { type: 'message_end', message: { role: 'assistant', usage: { input: 3, output: 4, cacheRead: 1, cacheWrite: 2 } } },
  ]
  arrange(on, spawns, [{ stream: 'stdout', text: `${events.map((e) => JSON.stringify(e)).join('\n')}\n` }])
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const { result, calls } = await runTurn($)
  expect(calls).toEqual([{ result: 'a.txt' }])
  expect(result.answer).toBe('done\n\n— answered by pi, openrouter/kimi')
  expect(spawns).toHaveLength(1)
})
