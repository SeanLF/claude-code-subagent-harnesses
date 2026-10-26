import { expect, test } from 'claude-code/testing'
import { compactionOutput, relayEvents } from '../hooks/acp/events'
import { drawCall } from '../hooks/acp/render'
import { pi } from '../hooks/adapters/pi'
import { arrange, runTurn } from './helpers'

const update = (u: Record<string, unknown>) => JSON.stringify({ sessionId: 's', update: u })
const texts = (node: unknown): string[] =>
  typeof node === 'string'
    ? [node]
    : typeof node === 'object' && node !== null && 'children' in node
      ? ((node as { children?: unknown[] }).children ?? []).flatMap(texts)
      : []

test("an ACP agent's compaction is one row, its summary the row's output after the context it started from", () => {
  const parse = relayEvents()
  parse(JSON.stringify({ relay: 'steered' }))
  parse(update({ sessionUpdate: 'usage_update', used: 412_345, size: 1_000_000 }))
  expect(parse(update({ sessionUpdate: 'compaction_update', compactionId: 'c1', status: 'in_progress' }))).toEqual([
    { k: 'call', id: 'compaction:c1', kind: 'compact', title: 'conversation' },
  ])
  parse(update({ sessionUpdate: 'compaction_summary_chunk', compactionId: 'c1', content: { type: 'text', text: 'Kept the ' } }))
  parse(update({ sessionUpdate: 'compaction_summary_chunk', compactionId: 'c1', content: { type: 'text', text: 'plan.' } }))
  expect(parse(update({ sessionUpdate: 'compaction_update', compactionId: 'c1', status: 'completed' }))).toEqual([
    { k: 'called', id: 'compaction:c1', output: '412k tokens\n\nKept the plan.', failed: false },
  ])
  // A repeated terminal update ends nothing twice.
  expect(parse(update({ sessionUpdate: 'compaction_update', compactionId: 'c1', status: 'completed' }))).toEqual([])
})

test('a compaction that fails says why, one never seen starting is announced as it ends', () => {
  const parse = relayEvents()
  parse(JSON.stringify({ relay: 'steered' }))
  expect(parse(update({ sessionUpdate: 'compaction_update', compactionId: 'c2', status: 'failed', error: 'model refused' }))).toEqual([
    { k: 'call', id: 'compaction:c2', kind: 'compact', title: 'conversation' },
    { k: 'called', id: 'compaction:c2', output: 'model refused', failed: true },
  ])
})

test("pi's compaction is a row with its sizes and summary; a failed one names its error", () => {
  const parse = pi.events()
  const line = (e: Record<string, unknown>) => parse(JSON.stringify(e))
  expect(line({ type: 'compaction_start', reason: 'threshold' })).toEqual([
    { k: 'call', id: 'pi-compaction-1', kind: 'compact', title: 'conversation' },
  ])
  // pi's docs/json.md sample, as written there.
  const result = {
    summary: 'Summary of conversation...',
    firstKeptEntryId: 'abc123',
    tokensBefore: 150000,
    estimatedTokensAfter: 32000,
    usage: { '...': '...' },
    details: {},
  }
  expect(line({ type: 'compaction_end', reason: 'threshold', result, aborted: false, willRetry: false })).toEqual([
    { k: 'called', id: 'pi-compaction-1', output: '150k → 32k tokens\n\nSummary of conversation...', failed: false },
  ])
  line({ type: 'compaction_start', reason: 'overflow' })
  expect(line({ type: 'compaction_end', reason: 'overflow', aborted: false, willRetry: false, errorMessage: '429' })).toEqual([
    { k: 'called', id: 'pi-compaction-2', output: '429', failed: true },
  ])
})

test('the reason shows unless it is the usual threshold', () => {
  expect(compactionOutput({ before: 500, why: 'manual' })).toBe('500 tokens · manual')
  expect(compactionOutput({})).toBe('')
})

test('a compaction row reads as Claude Code reads its own: one line, the summary behind ctrl+o', () => {
  const props = {
    tool_use_id: 't',
    tool: 'mcp__plugin_via_step__step',
    input: { kind: 'compact', title: 'conversation' },
    isRunning: false,
    isErrored: false,
    isInterrupted: false,
    output: '180k → 12k tokens\n\nKept the plan.',
  }
  expect(texts(drawCall({ ...props, isRunning: true, output: undefined })).join('')).toBe('Compacting conversation')
  const folded = texts(drawCall(props)).join('|')
  expect(folded).toContain('Compacted| |conversation|  ⎿  180k → 12k tokens')
  expect(folded).not.toContain('Kept the plan.')
  expect(folded).toContain('ctrl+o to expand')
  expect(texts(drawCall({ ...props, isExpanded: true })).join('|')).toContain('Kept the plan.')
})

const PI_START = { type: 'message_start', message: { role: 'assistant', provider: 'openrouter', model: 'kimi' } }
const piRun = (events: unknown[]) => [{ stream: 'stdout' as const, text: `${events.map((e) => JSON.stringify(e)).join('\n')}\n` }]
const summary = { summary: 's', firstKeptEntryId: 'e', tokensBefore: 9000, estimatedTokensAfter: 1000 }

test('a task that compacted on the way and then said nothing still ended with no answer', async ($, on) => {
  arrange(
    on,
    [],
    piRun([
      PI_START,
      { type: 'compaction_start', reason: 'threshold' },
      { type: 'compaction_end', reason: 'threshold', result: summary, aborted: false, willRetry: false },
    ]),
  )
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const { result } = await runTurn($)
  expect(result.answer).toContain('pi ended with no answer')
})

test('a /compact whose compaction failed is not answered as compacted', async ($, on) => {
  arrange(
    on,
    [],
    piRun([
      PI_START,
      { type: 'compaction_start', reason: 'manual' },
      { type: 'compaction_end', reason: 'manual', aborted: false, willRetry: false, errorMessage: 'no model' },
    ]),
  )
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: '/compact' })
  const { result } = await runTurn($)
  expect(result.answer).not.toContain('Compacted the conversation.')
  expect(result.answer).toContain('pi ended with no answer')
})

test('a /compact that compacted and said nothing answers that it compacted', async ($, on) => {
  arrange(
    on,
    [],
    piRun([
      PI_START,
      { type: 'compaction_start', reason: 'manual' },
      { type: 'compaction_end', reason: 'manual', result: summary, aborted: false, willRetry: false },
    ]),
  )
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: '/compact' })
  const { result } = await runTurn($)
  expect(result.answer).toContain('Compacted the conversation.')
})
