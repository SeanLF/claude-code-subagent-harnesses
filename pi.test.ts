import { expect, mock, test } from 'claude-code/testing'

import { HELP } from './hooks/register'

const STEP = { turnId: 't1', index: 0, model: 'haiku', messageCount: 1, agentId: 'a1' }
const ROOT = new URL('.', (import.meta as ImportMeta & { url: string }).url).pathname.replace(/\/$/, '')
type Spawn = { argv: string[]; input: string | undefined; env?: Record<string, string> }
type Write = { path: string; text: string }
const AGENT = { id: 'a1', description: 'x', type: 'pi:general-purpose', status: 'running' } as const
const EVENTS = [
  { type: 'message_start', message: { role: 'assistant', provider: 'openrouter', model: 'kimi' } },
  { type: 'tool_execution_start', toolName: 'bash', args: { command: 'ls' } },
  { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'all ' } },
  { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'done' } },
  { type: 'message_end', message: { role: 'assistant', usage: { input: 3, output: 4, cacheRead: 1, cacheWrite: 2 } } },
]

async function run($: any, step: typeof STEP = STEP) {
  const chunks: any[] = []
  const stream = $.turn.step(step)
  for (;;) {
    const step = await stream.next()
    if (step.done) return { chunks, result: step.value }
    chunks.push(step.value)
  }
}

function expectPiSpawn(spawn: Spawn | undefined, root: string, extra: string[] = []) {
  expect(spawn?.argv).toEqual(['pi', '-p', '--mode', 'json', '--session-id', 'pi-a1', '-e', `${root}/pi-extension/inbox.ts`, ...extra])
  expect(spawn?.env).toEqual({ PI_INBOX: '/tmp/claude-pi-inbox/a1.jsonl' })
}

function bottom(on: any, writes?: Write[]) {
  mock.env(on, { TMPDIR: '/tmp' })
  on('agent.list', () => ({ value: [AGENT] }))
  on('fs.write', (_: any, e: any) => {
    writes?.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('turn.start', (_: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', (_: any, e: any) => e)
}

function arrange(
  on: any,
  spawns: Spawn[],
  pieces: { stream: 'stdout' | 'stderr'; text: string }[],
  code = 0,
  rows: any[] = [],
  writes?: Write[],
) {
  bottom(on, writes)
  on('session.messages', () => ({ value: rows }))
  on('process.spawn', async function* (_: any, e: any) {
    spawns.push({ argv: [...e.argv], input: e.input, env: e.env })
    yield* pieces
    return { value: { code, signal: null } }
  })
}

const split = (text: string) => [{ stream: 'stdout' as const, text: text.slice(0, 40) }, { stream: 'stdout' as const, text: text.slice(40) }]
const lines = EVENTS.map((e) => JSON.stringify(e)).join('\n') + '\n'

function hang(on: any, spawns: Spawn[], writes?: Write[]) {
  bottom(on, writes)
  on('session.messages', () => ({ value: [] }))
  on('process.spawn', async function* (_: any, e: any, next: any) {
    spawns.push({ argv: [...e.argv], input: e.input, env: e.env })
    const events = [
      { type: 'message_start', message: { role: 'assistant', provider: 'openrouter', model: 'kimi' } },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'half an answer' } },
    ]
    yield { stream: 'stdout' as const, text: events.map((event) => JSON.stringify(event)).join('\n') + '\n' }
    await new Promise<void>((resolve) => {
      if (next.signal.aborted) resolve()
      else next.signal.addEventListener('abort', () => resolve(), { once: true })
    })
    return { value: { code: 0, signal: null } }
  })
}

function hold(on: any, spawns: Spawn[], writes: Write[], before: unknown[], after: unknown[]) {
  bottom(on, writes)
  on('session.messages', () => ({ value: [] }))
  let release!: () => void
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  on('process.spawn', async function* (_: any, e: any) {
    spawns.push({ argv: [...e.argv], input: e.input, env: e.env })
    yield { stream: 'stdout' as const, text: before.map((event) => JSON.stringify(event)).join('\n') + '\n' }
    await released
    yield { stream: 'stdout' as const, text: after.map((event) => JSON.stringify(event)).join('\n') + '\n' }
    return { value: { code: 0, signal: null } }
  })
  return { release }
}

test('a pi run past the default 30 minutes is stopped with its partial answer, unsigned', async ($, on) => {
  const clock = mock.clock(on)
  const spawns: Spawn[] = []
  hang(on, spawns)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const pending = run($)
  await clock.settle()
  await clock.advance(30 * 60 * 1000)
  const { chunks, result } = await pending
  expectPiSpawn(spawns[0], ROOT)
  expect(spawns[0]?.input).toBe('go')
  expect(result.answer).toContain('half an answer')
  expect(result.answer).toContain('pi ran past 30 minutes and was stopped.')
  expect(result.answer).not.toContain('answered by pi')
  expect(result.usage).toEqual({ model: 'openrouter/kimi', input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
  expect(chunks.some((chunk) => chunk.kind === 'text' && chunk.text.includes('pi ran past 30 minutes and was stopped.'))).toBe(true)
})

test('a timeoutMinutes setting stops a silent pi at its own limit', { options: { timeoutMinutes: 5 } }, async ($, on) => {
  const clock = mock.clock(on)
  const spawns: Spawn[] = []
  hang(on, spawns)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  let finished = false
  const pending = run($).then((outcome) => {
    finished = true
    return outcome
  })
  await clock.settle()
  await clock.advance(4 * 60 * 1000)
  expect(finished).toBe(false)
  expect(spawns).toHaveLength(1)
  await clock.advance(60 * 1000)
  const { result } = await pending
  expect(result.answer).toContain('half an answer')
  expect(result.answer).toContain('pi ran past 5 minutes and was stopped.')
  expect(result.answer).not.toContain('answered by pi')
})

test('a pi that finishes before the limit is unaffected', { options: { timeoutMinutes: 1 } }, async ($, on) => {
  const clock = mock.clock(on)
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const { result } = await run($)
  await clock.advance(60 * 60 * 1000)
  expect(result.answer.endsWith('all done\n\n— answered by pi, openrouter/kimi')).toBe(true)
  expect(result.answer).not.toContain('pi ran past')
})

test('a pi agent streams pi, names its model and reports pi usage even when pieces split lines', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'pi-model: openrouter/kimi\nlist files' })
  const { chunks, result } = await run($)
  expectPiSpawn(spawns[0], ROOT, ['--model', 'openrouter/kimi'])
  expect(spawns[0]?.input).toBe('list files')
  expect(result.answer.endsWith('all done\n\n— answered by pi, openrouter/kimi')).toBe(true)
  expect(chunks.at(-1)).toEqual({
    kind: 'stop',
    stopReason: 'end_turn',
    usage: { model: 'openrouter/kimi', input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 1, cache_creation_input_tokens: 2 },
  })
})

test('pi-model and pi-tools lines are both passed and stripped from the prompt', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'pi-tools: read\npi-model: openrouter/kimi\nlist files' })
  await run($)
  expectPiSpawn(spawns[0], ROOT, ['--model', 'openrouter/kimi', '--tools', 'read'])
  expect(spawns[0]?.input).toBe('list files')
})

test('a defaultModel setting supplies --model when the prompt has no pi-model line', { options: { defaultModel: 'openrouter/kimi' } }, async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  await run($)
  expectPiSpawn(spawns[0], ROOT, ['--model', 'openrouter/kimi'])
  expect(spawns[0]?.input).toBe('go')
})

test('a pi-model line overrides the defaultModel setting', { options: { defaultModel: 'openrouter/kimi' } }, async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'pi-model: other/x\ngo' })
  await run($)
  expectPiSpawn(spawns[0], ROOT, ['--model', 'other/x'])
  expect(spawns[0]?.input).toBe('go')
})

test('an empty defaultModel setting passes no --model', { options: { defaultModel: '' } }, async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  await run($)
  expectPiSpawn(spawns[0], ROOT)
  expect(spawns[0]?.input).toBe('go')
})

test('an invalid defaultModel setting answers without spawning pi', { options: { defaultModel: 'a b' } }, async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const { result } = await run($)
  expect(spawns).toEqual([])
  expect(result.answer).toBe('The pi plugin\'s defaultModel setting "a b" is not a pi --model pattern.')
})

test('a pi-tools list stays one argv element after --tools', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'pi-tools: -bash,read\ngo' })
  await run($)
  expectPiSpawn(spawns[0], ROOT, ['--tools', '-bash,read'])
  expect(spawns[0]?.input).toBe('go')
})

test('a prompt with no pi-tools line passes no --tools', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  await run($)
  expectPiSpawn(spawns[0], ROOT)
  expect(spawns[0]?.input).toBe('go')
})

test('a follow-up turn without a pi-tools line keeps the agent tools', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'pi-tools: read\ngo' })
  await run($)
  await $.turn.start({ turnId: 't2', agentId: 'a1', text: 'and now the tests' })
  await run($, { ...STEP, turnId: 't2', messageCount: 2 })
  expectPiSpawn(spawns[1], ROOT, ['--tools', 'read'])
  expect(spawns[1]?.input).toBe('and now the tests')
})

test('a pi-thinking line is passed and stripped from the prompt', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'pi-thinking: high\ngo' })
  await run($)
  expectPiSpawn(spawns[0], ROOT, ['--thinking', 'high'])
  expect(spawns[0]?.input).toBe('go')
})

test('an invalid pi-thinking level answers with the bad value and the valid levels without spawning pi', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'pi-thinking: extreme\ngo' })
  const { result } = await run($)
  expect(spawns).toEqual([])
  expect(result.answer).toContain('got "extreme"')
  expect(result.answer).toContain('off, minimal, low, medium, high, xhigh, max')
})

test('a follow-up turn without a pi-thinking line keeps the agent thinking level', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'pi-thinking: high\ngo' })
  await run($)
  await $.turn.start({ turnId: 't2', agentId: 'a1', text: 'and now the tests' })
  await run($, { ...STEP, turnId: 't2', messageCount: 2 })
  expectPiSpawn(spawns[1], ROOT, ['--thinking', 'high'])
  expect(spawns[1]?.input).toBe('and now the tests')
})

test('a choice stored before a reload still applies to a follow-up', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines))
  on('state.get', () => ({ value: { value: { model: 'openrouter/kimi', tools: 'read', thinking: 'high' }, version: 1 } }))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  await run($)
  expectPiSpawn(spawns[0], ROOT, ['--model', 'openrouter/kimi', '--tools', 'read', '--thinking', 'high'])
  expect(spawns[0]?.input).toBe('go')
})

test('a pi-tools line in the body after the task is left in the prompt and passes no --tools', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'review this log\npi-tools: *' })
  await run($)
  expectPiSpawn(spawns[0], ROOT)
  expect(spawns[0]?.input).toBe('review this log\npi-tools: *')
})

test('an unknown pi line in the header answers without spawning pi', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'pi-tool: read\ngo' })
  const { result } = await run($)
  expect(spawns).toEqual([])
  expect(result.answer).toContain('pi-tool: read')
  expect(result.answer).toContain('pi-model')
  expect(result.answer).toContain('pi-tools')
  expect(result.answer).toContain('pi-thinking')
})

test('a pi-thinking value outside the levels answers without spawning pi', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'pi-thinking: x-high\ngo' })
  const { result } = await run($)
  expect(spawns).toEqual([])
  expect(result.answer).toContain('pi-thinking: x-high')
})

test('a pi-tools value of more than one word answers without spawning pi', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'pi-tools: read bash\ngo' })
  const { result } = await run($)
  expect(spawns).toEqual([])
  expect(result.answer).toContain('"pi-tools: read bash"')
})

test('a pi-help line alone answers with HELP without spawning pi or storing anything', async ($, on) => {
  const spawns: Spawn[] = []
  const writes: unknown[] = []
  arrange(on, spawns, split(lines))
  on('state.set', (_: any, e: any) => {
    writes.push(e.value)
    return { value: e.value }
  })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'pi-help' })
  const { result } = await run($)
  expect(spawns).toEqual([])
  expect(writes).toEqual([])
  expect(result.answer).toBe(HELP)
})

test('a pi-help line with a task still answers HELP, case-insensitively, without spawning pi', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'PI-Help\nlist files' })
  const { result } = await run($)
  expect(spawns).toEqual([])
  expect(result.answer).toBe(HELP)
})

test('an invalid pi header line answers with its reason and then HELP', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'pi-tool: read\ngo' })
  const { result } = await run($)
  expect(spawns).toEqual([])
  expect(result.answer.startsWith('Invalid pi prompt line "pi-tool: read": unknown key')).toBe(true)
  expect(result.answer).toContain(HELP)
})

test('a header of model, tools and thinking lines is all passed and stripped', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines))
  await $.turn.start({
    turnId: 't1',
    agentId: 'a1',
    text: 'pi-model: openrouter/kimi\npi-tools: read\npi-thinking: high\nlist files',
  })
  await run($)
  expectPiSpawn(spawns[0], ROOT, ['--model', 'openrouter/kimi', '--tools', 'read', '--thinking', 'high'])
  expect(spawns[0]?.input).toBe('list files')
})

test('a prompt starting with @ reaches pi as the message, not as a file argument', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: '@README.md summarise this' })
  await run($)
  expect(spawns[0]?.argv.some((arg) => arg.startsWith('@'))).toBe(false)
  expect(spawns[0]?.env).toEqual({ PI_INBOX: '/tmp/claude-pi-inbox/a1.jsonl' })
  expect(spawns[0]?.input).toBe('@README.md summarise this')
})

test('a header-only prompt sends an empty message', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'pi-model: openrouter/kimi' })
  await run($)
  expectPiSpawn(spawns[0], ROOT, ['--model', 'openrouter/kimi'])
  expect(spawns[0]?.input).toBe('')
})

test('a pi agent whose first turn carries no text runs the spawn prompt', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines))
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'a1' }))
  await $.agent.spawn({
    tool_use_id: 'toolu_pi_spawn',
    subagentType: 'pi:general-purpose',
    prompt: 'from the spawn',
    description: 'd',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'haiku',
    background: true,
    fork: false,
  })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: '' })
  await run($)
  expect(spawns[0]?.input).toBe('from the spawn')
})

test('a pi agent hands its report back through SubagentHandback when the session asks for it', async ($, on) => {
  arrange(on, [], split(lines), 0, [{ role: 'user', text: 'report via SubagentHandback', toolUses: [] }])
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const { result } = await run($)
  expect(result.stopReason).toBe('tool_use')
  expect(result.toolUses[0]?.name).toBe('SubagentHandback')
  const again = await run($)
  expect(again.result.answer).toBe('Report delivered.')
})

test('a pi that is missing answers in text, never as a Claude model', async ($, on) => {
  bottom(on)
  on('session.messages', () => ({ value: [] }))
  on('process.spawn', async function* () {
    throw new Error('spawn pi ENOENT')
  })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const { result } = await run($)
  expect(result.answer).toContain('pi could not run')
})

test('a model call pi reports as failed is named in the answer', async ($, on) => {
  const failed = [
    { type: 'message_start', message: { role: 'assistant', provider: 'openrouter', model: 'kimi' } },
    { type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: '402: more credits needed', usage: {} } },
  ]
  arrange(on, [], [{ stream: 'stdout', text: failed.map((e) => JSON.stringify(e)).join('\n') + '\n' }])
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const { result } = await run($)
  expect(result.answer).toContain("pi's model call failed: 402: more credits needed")
})

test('a retry that recovers does not read as a failed model call', async ($, on) => {
  const recovered = [
    { type: 'message_start', message: { role: 'assistant', provider: 'openrouter', model: 'kimi' } },
    { type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: '429 retry', usage: {} } },
    { type: 'message_start', message: { role: 'assistant', provider: 'openrouter', model: 'kimi' } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'recovered' } },
    { type: 'message_end', message: { role: 'assistant', usage: {} } },
  ]
  arrange(on, [], [{ stream: 'stdout', text: recovered.map((e) => JSON.stringify(e)).join('\n') + '\n' }])
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const { result } = await run($)
  expect(result.answer).toContain('recovered')
  expect(result.answer).not.toContain('model call failed')
})

test('a pi that exits non-zero reports its stderr', async ($, on) => {
  arrange(on, [], [{ stream: 'stderr', text: '\u001b[31mno key\u001b[0m' }], 1)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const { result } = await run($)
  expect(result.answer).toContain('pi exited with 1.\nno key')
})

test('a SendMessage to a live pi agent is steered into its inbox', async ($, on) => {
  const clock = mock.clock(on)
  const spawns: Spawn[] = []
  const writes: Write[] = []
  hang(on, spawns, writes)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const pending = run($)
  await clock.settle()
  const delivered = await $.tool.call({ tool: 'SendMessage', to: 'a1', message: 'also do B', tool_use_id: 't' })
  expect(delivered.result).toEqual({ success: true, message: 'Delivered to the running pi agent; pi reads it at its next step.' })
  expect(writes.at(-1)?.path).toBe('/tmp/claude-pi-inbox/a1.jsonl')
  expect(writes.at(-1)?.text.split('\n')).toContain(JSON.stringify('also do B'))
  await clock.advance(30 * 60 * 1000)
  await pending
})

test('a SendMessage to an agent with no live run becomes a follow-up', async ($, on) => {
  const writes: Write[] = []
  bottom(on, writes)
  let called = false
  on('tool.call', { tool: 'SendMessage' }, (_: any, e: any) => {
    called = true
    return { result: { success: true, message: `queued for ${e.to}` } }
  })
  const answered = await $.tool.call({ tool: 'SendMessage', to: 'a1', message: 'later', tool_use_id: 't' })
  expect(called).toBe(true)
  expect(answered.result).toEqual({ success: true, message: 'queued for a1' })
  expect(writes).toEqual([])
})

test('a SendMessage that asks for an idle notice goes on to the engine', async ($, on) => {
  const clock = mock.clock(on)
  const spawns: Spawn[] = []
  const writes: Write[] = []
  hang(on, spawns, writes)
  let called = false
  on('tool.call', { tool: 'SendMessage' }, () => {
    called = true
    return { result: { success: true, message: 'subscribed' } }
  })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const pending = run($)
  await clock.settle()
  const before = writes.length
  const answered = await $.tool.call({ tool: 'SendMessage', to: 'a1', message: 'also do B', notify_when_idle: true, tool_use_id: 't' })
  expect(called).toBe(true)
  expect(answered.result).toEqual({ success: true, message: 'subscribed' })
  expect(writes.length).toBe(before)
  await clock.advance(30 * 60 * 1000)
  await pending
})

test('the inbox is cleared when the pi run ends', async ($, on) => {
  const clock = mock.clock(on)
  const spawns: Spawn[] = []
  const writes: Write[] = []
  hang(on, spawns, writes)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const pending = run($)
  await clock.settle()
  await $.tool.call({ tool: 'SendMessage', to: 'a1', message: 'also do B', tool_use_id: 't' })
  expect(writes.at(-1)?.text).toContain('also do B')
  await clock.advance(30 * 60 * 1000)
  await pending
  expect(writes.at(-1)).toEqual({ path: '/tmp/claude-pi-inbox/a1.jsonl', text: '' })
})

test('a steer pi consumed is not reported as undelivered', async ($, on) => {
  const clock = mock.clock(on)
  const spawns: Spawn[] = []
  const writes: Write[] = []
  const prompt = [
    { type: 'message_start', message: { role: 'assistant', provider: 'openrouter', model: 'kimi' } },
    { type: 'message_end', message: { role: 'user' } },
  ]
  const steered = [
    { type: 'message_end', message: { role: 'user' } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'all done' } },
    { type: 'message_end', message: { role: 'assistant', usage: {} } },
  ]
  const runControl = hold(on, spawns, writes, prompt, steered)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const pending = run($)
  for (let i = 0; i < 20 && spawns.length === 0; i += 1) await clock.settle()
  expect(spawns).toHaveLength(1)
  const delivered = await $.tool.call({ tool: 'SendMessage', to: 'a1', message: 'also do B', tool_use_id: 't' })
  expect(delivered.result).toEqual({ success: true, message: 'Delivered to the running pi agent; pi reads it at its next step.' })
  expect(writes.at(-1)?.text).toContain('also do B')
  runControl.release()
  const { result } = await pending
  expect(result.answer).toContain('all done')
  expect(result.answer).not.toContain('Not delivered before pi finished')
})

test('a steer pi never took is named as undelivered', async ($, on) => {
  const clock = mock.clock(on)
  const spawns: Spawn[] = []
  const writes: Write[] = []
  const prompt = [
    { type: 'message_start', message: { role: 'assistant', provider: 'openrouter', model: 'kimi' } },
    { type: 'message_end', message: { role: 'user' } },
  ]
  const finished = [
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'all done' } },
    { type: 'message_end', message: { role: 'assistant', usage: {} } },
  ]
  const runControl = hold(on, spawns, writes, prompt, finished)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const pending = run($)
  for (let i = 0; i < 20 && spawns.length === 0; i += 1) await clock.settle()
  expect(spawns).toHaveLength(1)
  await $.tool.call({ tool: 'SendMessage', to: 'a1', message: 'also do B', tool_use_id: 't' })
  expect(writes.at(-1)?.text).toContain('also do B')
  runControl.release()
  const { result } = await pending
  expect(result.answer).toContain('Not delivered before pi finished (send again as a follow-up):')
  expect(result.answer).toContain('also do B')
  expect(result.answer.indexOf('Not delivered before pi finished')).toBeLessThan(result.answer.indexOf('— answered by pi'))
})

test('the session registers the agent type', async ($, on) => {
  const seen: unknown[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.register', (_, e) => {
    seen.push(e.name)
    return { value: { agent: `pi:${e.name}` } }
  })
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  expect(seen).toEqual(['general-purpose'])
})
