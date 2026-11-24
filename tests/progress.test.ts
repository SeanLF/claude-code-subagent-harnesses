import { expect, test } from 'claude-code/testing'
import { drawCall, drawGroup, NO_OUTPUT } from '../hooks/acp/render'
import { pi } from '../hooks/adapters/pi'
import { run as runHook } from '../hooks/run'
import { testWorld } from './helpers'

const START = { type: 'message_start', message: { role: 'assistant', provider: 'openrouter', model: 'kimi' } }
// No call id: a text line. pi's calls carry ids and become steps instead (tests/adapters/pi.test.ts pins that).
const TOOL = { type: 'tool_execution_start', toolName: 'bash', args: { command: 'npm test' } }
const call = (over: Partial<Parameters<typeof drawCall>[0]>): Parameters<typeof drawCall>[0] => ({
  tool_use_id: 't',
  tool: 'mcp__plugin_via_step__step',
  input: { kind: 'execute', title: 'npm test' },
  isRunning: false,
  isErrored: false,
  isInterrupted: false,
  ...over,
})
const texts = (node: unknown): string[] =>
  typeof node === 'string'
    ? [node]
    : typeof node === 'object' && node !== null && 'children' in node
      ? ((node as { children?: unknown[] }).children ?? []).flatMap(texts)
      : []

test("a harness command's row says it runs, then ran; any other call shows its own title", () => {
  expect(texts(drawCall(call({ isRunning: true }))).join('')).toBe('Running npm test')
  expect(texts(drawCall(call({ output: 'ok' }))).join('|')).toBe('Ran| |npm test|  ⎿  ok')
  expect(texts(drawCall(call({ input: { kind: 'read', title: "Read file 'src/a.ts'" } }))).join('')).toBe("Read file 'src/a.ts'")
  expect(texts(drawCall(call({ input: { kind: 'read', title: 'List files' }, isRunning: true }))).join('')).toBe('List files…')
  expect(texts(drawCall(call({ isErrored: true }))).join('')).toBe('Failed npm test')
  // A call that reported nothing shows no output line.
  expect(texts(drawCall(call({ output: NO_OUTPUT }))).join('|')).toBe('Ran| |npm test')
})

test("a harness call's row shows three lines of output unless expanded, and no control characters", () => {
  const output = 'a\nb\nc\nd\ne'
  expect(texts(drawCall(call({ output }))).join('|')).toBe('Ran| |npm test|  ⎿  a|     b|     c|     … 2 more lines (ctrl+o to expand)')
  expect(texts(drawCall(call({ output, isExpanded: true }))).length).toBe(8)
  expect(texts(drawCall(call({ input: { kind: 'execute', title: 'rm\u001b[2J -rf' } }))).join('')).toBe('Ran rm[2J -rf')
  // Nor bidirectional, zero-width or tag characters, which could make a row read as another command.
  expect(
    texts(drawCall(call({ input: { kind: 'execute', title: 'ls \u202egnp.exe\u200b\u{e0041}' }, output: 'ok\u2066' }))).join('|'),
  ).toBe('Ran| |ls gnp.exe|  ⎿  ok')
})

test("an edit's row colours the lines it took out and put in, and shows more of them before folding", () => {
  const row = drawCall(call({ input: { kind: 'edit', title: 'Edit notes.txt' }, output: 'notes.txt\n- a\n+ A' }))
  const found = (node: unknown, color: string): string[] =>
    typeof node === 'object' && node !== null
      ? [
          ...((node as { props?: { color?: string } }).props?.color === color ? texts(node) : []),
          ...((node as { children?: unknown[] }).children ?? []).flatMap((child) => found(child, color)),
        ]
      : []
  expect(found(row, 'diffRemoved')).toEqual(['- a'])
  expect(found(row, 'diffAdded')).toEqual(['+ A'])
  const long = Array.from({ length: 20 }, (_, i) => `+ line ${i}`).join('\n')
  expect(texts(drawCall(call({ input: { kind: 'edit', title: 'Edit a.ts' }, output: long }))).join('|')).toContain('… 8 more lines')
})

test("a plan's row is titled Plan and lists its entries", () => {
  expect(texts(drawCall(call({ input: { kind: 'plan', title: 'Plan' }, output: '☑ read\n◐ fix' }))).join('|')).toBe(
    'Plan|  ⎿  ☑ read|     ◐ fix',
  )
})

test('a call that names a file links its title to it', () => {
  const row = drawCall(call({ input: { kind: 'read', title: "Read file 'a.ts'", path: '/repo/a.ts' } })) as {
    children: { children: unknown[] }[]
  }
  const link = JSON.stringify(row.children[0])
  expect(link).toContain('"type":"Link"')
  expect(link).toContain('file:///repo/a.ts')
  const odd = JSON.stringify(drawCall(call({ input: { kind: 'read', title: 'x', path: '/my repo/#1.ts' } })))
  expect(odd).toContain('file:///my%20repo/%231.ts')
  expect(JSON.stringify(drawCall(call({ input: { kind: 'read', title: 'x', path: '/a/what?.ts' } })))).toContain('file:///a/what%3F.ts')
  expect(JSON.stringify(drawCall(call({ input: { kind: 'read', title: 'x', path: 'rel/a.ts' } })))).not.toContain('Link')
})

const group = (kinds: unknown[], isActive = false): Parameters<typeof drawGroup>[0] => ({
  calls: kinds.map((kind, i) => ({
    tool: 'mcp__plugin_via_step__step',
    input: { kind, title: `x${i + 1}` },
    isRunning: isActive && i === kinds.length - 1,
    isErrored: false,
    isInterrupted: false,
  })),
  isActive,
  isExpanded: false,
  isCallsOnly: true,
})

test('a folded run of harness calls is counted by what each did, in the order each kind first came', () => {
  expect(texts(drawGroup(group(['read', 'read', 'search']))).join('')).toBe('Read 2 files, searched 1 pattern')
  expect(texts(drawGroup(group(['execute', 'read', 'execute']))).join('')).toBe('Ran 2 commands, read 1 file')
  expect(texts(drawGroup(group(['read'], true))).join('')).toBe('Reading 1 file… · x1')
  // A kind ACP adds later, or none at all, still counts.
  expect(texts(drawGroup(group(['think', undefined]))).join('')).toBe('2 other steps')
})

test('a folded run stays one line from its first call: the running title rides on it, failures and waits are words', () => {
  const lines = (props: Parameters<typeof drawGroup>[0]) => (drawGroup(props) as { children: unknown[] }).children.length
  const first = group(['execute'], true)
  expect(texts(drawGroup(first)).join('')).toBe('Running 1 command… · x1')
  const later = group(['execute', 'execute', 'execute'], true)
  expect(texts(drawGroup(later)).join('')).toBe('Running 3 commands… · x3')
  const done = { ...later, isActive: false, calls: later.calls.map((call) => ({ ...call, isRunning: false })) }
  expect(texts(drawGroup(done)).join('')).toBe('Ran 3 commands')
  const failed = { ...done, isCallsOnly: false, calls: done.calls.map((call, i) => ({ ...call, isErrored: i === 1 })) }
  expect(texts(drawGroup(failed)).join('')).toBe('Ran 3 commands, 1 failed')
  // A command still running after a step went by is not counted again.
  expect(texts(drawGroup(group(['execute', 'wait', 'wait']))).join('')).toBe('Ran 1 command')
  expect(texts(drawGroup(group(['wait']))).join('')).toBe('Waited on 1 step')
  for (const props of [first, later, done, failed]) expect(lines(props)).toBe(1)
})

test('a failed call keeps its group on the via line instead of the engine count', async ($, on) => {
  const seen: unknown[] = []
  on('ui.render', (_, e) => {
    seen.push(e)
    return { type: 'Text', children: ['native'] }
  })
  const props = group(['execute', 'execute'])
  const failed = { ...props, isCallsOnly: false, calls: props.calls.map((call, i) => ({ ...call, isErrored: i === 1 })) }
  const drawn = await $.ui.render({ surface: 'terminal', component: 'ToolGroup', requestId: 'g', props: failed })
  expect(texts(drawn).join('')).toBe('Ran 2 commands, 1 failed')
  // Other rows than calls, with no failed call, keep the engine's own drawing.
  await $.ui.render({ surface: 'terminal', component: 'ToolGroup', requestId: 'g', props: { ...props, isCallsOnly: false } })
  expect(seen).toHaveLength(1)
})

test('a run ended from outside while parked between pieces stops its harness', async () => {
  let killed = false
  const world = testWorld({ adapters: new Map([['pi', pi]]) })
  const $ = {
    env: { get: async () => undefined },
    fs: { write: async () => {} },
    clock: { after: () => ({ cancel: () => {} }) },
    process: {
      spawn: async function* () {
        try {
          yield { stream: 'stdout' as const, text: `${[START, TOOL].map((event) => JSON.stringify(event)).join('\n')}\n` }
          await new Promise(() => {})
        } finally {
          // The engine kills the child when its stream is returned.
          killed = true
        }
      },
    },
    plugin: { root: '/' },
  } as unknown as Parameters<typeof runHook>[2]
  const input = { agentId: 'a1', choice: {}, prompt: 'go', signal: new AbortController().signal, mode: 'default' as const }
  const stream = runHook(world, pi, $, { ...input, save: async () => {} } as never)
  // Parked at its first chunk, as after a step that read this far; then ended, as endJob or an Esc does.
  await stream.next()
  await stream.return(undefined as never)
  expect(killed).toBe(true)
})
