import { expect, test } from 'claude-code/testing'

import { agy } from '../hooks/adapters/agy'
import { codex } from '../hooks/adapters/codex'
import { opencode } from '../hooks/adapters/opencode'
import { pi } from '../hooks/adapters/pi'
import { descriptionOf, helpOf, promptOf } from '../hooks/prompt'

const HELP = helpOf(pi)
import { arrange, expectPiSpawn, lines, ROOT, run, split, STEP, STUB, type Spawn } from './helpers'

test('pi-model and pi-tools lines are both passed and stripped from the prompt', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'pi-tools: read\npi-model: openrouter/kimi\nlist files' })
  await run($)
  expectPiSpawn(spawns[0], ROOT, ['--model', 'openrouter/kimi', '--tools', 'read', '-na'])
  expect(spawns[0]?.input).toBe('list files')
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
  expectPiSpawn(spawns[1], ROOT, ['--tools', 'read', '-na'])
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
  on('state.set', (_, e, next) => {
    writes.push(e.value)
    return next(e)
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
  expectPiSpawn(spawns[0], ROOT, ['--model', 'openrouter/kimi', '--tools', 'read', '-na', '--thinking', 'high'])
  expect(spawns[0]?.input).toBe('list files')
})

test('a header-only prompt sends an empty message', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'pi-model: openrouter/kimi' })
  await run($)
  expectPiSpawn(spawns[0], ROOT, ['--model', 'openrouter/kimi'])
  expect(spawns[0]?.input).toBe('')
})

test('neutral model, tools and thinking lines are passed and stripped', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'model: openrouter/kimi\ntools: read\nthinking: high\nlist files' })
  await run($)
  expectPiSpawn(spawns[0], ROOT, ['--model', 'openrouter/kimi', '--tools', 'read', '-na', '--thinking', 'high'])
  expect(spawns[0]?.input).toBe('list files')
})

test('pi- prompt lines remain aliases beside the neutral ones', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'model: openrouter/kimi\npi-tools: read\npi-thinking: high\ngo' })
  await run($)
  expectPiSpawn(spawns[0], ROOT, ['--model', 'openrouter/kimi', '--tools', 'read', '-na', '--thinking', 'high'])
  expect(spawns[0]?.input).toBe('go')
})

test('a via-help line answers with HELP without spawning pi', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'via-help' })
  const { result } = await run($)
  expect(spawns).toEqual([])
  expect(result.answer).toBe(HELP)
})

test('prose that merely starts with a key word is not a header', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'models are hard\nthinking about it\ngo' })
  await run($)
  expectPiSpawn(spawns[0], ROOT)
  expect(spawns[0]?.input).toBe('models are hard\nthinking about it\ngo')
})

test('a tools line is refused on an adapter that cannot enforce read-only', () => {
  const refused = promptOf('tools: read\ngo', STUB)
  expect(refused.error).toContain('stub cannot enforce read-only tools')
  expect(refused.prompt).toBe('tools: read\ngo')
  expect(promptOf('thinking: low\ngo', STUB).thinking).toBe('low')
  expect(promptOf('thinking: extreme\ngo', STUB).error).toContain('low, high')
})

test('help is generated from the adapter fields', () => {
  const stubHelp = helpOf(STUB)
  expect(stubHelp).toContain('refused: stub cannot enforce read-only tools')
  expect(stubHelp).toContain('low, high')
  expect(stubHelp).toContain('no mid-run steering')
  expect(stubHelp).toContain('— answered by stub')
  expect(HELP).toContain('off, minimal, low, medium, high, xhigh, max')
  expect(HELP).toContain('passed to pi as its tool list')
  expect(HELP).toContain('read is read-only; any other list, such as -bash,read, can still edit')
  expect(HELP).toContain('at its next step')
  expect(HELP).toContain('interrupt:')
})

test('help and description say an ACP harness queues a message until it finishes its current answer', () => {
  for (const adapter of [codex, opencode]) {
    const help = helpOf(adapter)
    expect(help).toContain('waits until it finishes its current answer')
    expect(help).toContain('runs read-only and cannot edit files')
    expect(help).not.toContain('sandbox')
    expect(descriptionOf(adapter)).not.toContain('mid-run')
  }
  expect(descriptionOf(pi)).toContain('steers it mid-run')
})


test('only a harness that steers tells Claude about interrupt:', () => {
  expect(descriptionOf(pi)).toContain('`interrupt:`')
  expect(descriptionOf(codex)).toContain('`interrupt:`')
  expect(descriptionOf(agy)).not.toContain('interrupt')
})

test('a model line starting with - is refused, so it can never be read as a flag', () => {
  expect(promptOf('model: --dangerously-skip-permissions\ngo', pi).error).toBeDefined()
  expect(promptOf('model: openrouter/x-y\ngo', pi).error).toBeUndefined()
  expect(promptOf('tools: -bash,read\ngo', pi).error).toBeUndefined()
})
