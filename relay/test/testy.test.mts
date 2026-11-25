import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { SessionUpdate } from '@agentclientprotocol/sdk/unstable'
import {
  answer,
  get,
  relayEvent,
  relayEvents,
  relayEventsNamed,
  runRelay,
  sandbox,
  send,
  startRelay,
  toolCalls,
  updates,
} from './support/relay-run.mts'

const built = join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'via/testy')
const testy = process.env.ACP_TESTY ?? join(built, 'debug/testy')
const skip = existsSync(testy)
  ? false
  : `testy is not at ${testy}: cargo build --manifest-path ci/testy/Cargo.toml --target-dir ${built}, or set ACP_TESTY`
const QUIET = { RUST_LOG: 'error' }

const run = (prompt: string, env: Record<string, string> = {}) =>
  runRelay({ agent: [testy], prompt, cwd: sandbox().work, env: { ...QUIET, ...env } })

test('an echo streams back as the answer, and the run ends done', { skip }, async () => {
  const r = await run('echo hello from via')
  assert.equal(r.status, 0, r.stderr)
  assert.equal(answer(r.events), 'hello from via')
  assert.deepEqual(relayEvents(r.events), ['session', 'steered', 'prompt_done', 'done'])
  assert.equal(relayEvent(r.events, 'done')?.stopReason, 'end_turn')
})

test("session_updates: every kind of update testy sends reaches the relay's output", { skip }, async () => {
  const r = await run('session_updates')
  assert.equal(r.status, 0, r.stderr)
  const kinds = new Set(updates(r.events).map((u) => u.sessionUpdate))
  const sent: readonly SessionUpdate['sessionUpdate'][] = [
    'session_info_update',
    'current_mode_update',
    'config_option_update',
    'available_commands_update',
    'usage_update',
    'user_message_chunk',
    'agent_thought_chunk',
    'agent_message_chunk',
    'tool_call',
    'tool_call_update',
    'plan',
  ]
  for (const kind of sent) assert.ok(kinds.has(kind), `no ${kind} reached the relay's output`)
  const blocks = new Set(updates(r.events).flatMap((u) => (u.sessionUpdate === 'agent_message_chunk' ? [u.content.type] : [])))
  assert.deepEqual([...blocks].sort(), ['audio', 'image', 'resource', 'resource_link', 'text'])
})

test('session_updates: each block testy sends as bytes is saved to RELAY_FILES, the file holding exactly its bytes', { skip }, async () => {
  const bytesOf = (events: Parameters<typeof updates>[0]) =>
    updates(events).flatMap((u) => {
      if (u.sessionUpdate !== 'agent_message_chunk') return []
      const c = u.content
      if (c.type === 'image' || c.type === 'audio') return [{ data: c.data, meta: c._meta }]
      return c.type === 'resource' && 'blob' in c.resource ? [{ data: c.resource.blob, meta: c._meta }] : []
    })
  const sent = bytesOf((await run('session_updates')).events)
  assert.ok(sent.length >= 2, 'testy sent no bytes')
  const files = join(sandbox().root, 'files')
  const r = await run('session_updates', { RELAY_FILES: files })
  assert.equal(r.status, 0, r.stderr)
  const printed = bytesOf(r.events)
  assert.equal(printed.length, sent.length)
  for (const [i, block] of printed.entries()) {
    assert.equal(block.data, '')
    const saved = String(get(block.meta, 'relay', 'saved'))
    assert.ok(saved.startsWith(`${files}/`), saved)
    assert.deepEqual(readFileSync(saved), Buffer.from(sent[i]?.data ?? '', 'base64'))
  }
})

test("tool_calls: each call reaches the output through its lifecycle, its paths in the session's folder", { skip }, async () => {
  const r = await run('tool_calls')
  assert.equal(r.status, 0, r.stderr)
  const cwd = String(relayEvent(r.events, 'session')?.cwd)
  const calls = toolCalls(r.events)
  const ids = [...new Set(calls.map((u) => u.toolCallId))]
  assert.ok(ids.length >= 2)
  for (const id of ids) {
    const seen = calls.filter((u) => u.toolCallId === id)
    assert.equal(seen[0]?.sessionUpdate, 'tool_call')
    assert.equal(seen.at(-1)?.status, 'completed')
  }
  const paths = calls.flatMap((u) => [
    ...(u.locations ?? []).map((l) => l.path),
    ...(u.content ?? []).flatMap((c) => (c.type === 'diff' ? [c.path] : [])),
  ])
  assert.ok(paths.length > 0)
  for (const path of paths) assert.ok(path.startsWith(`${cwd}/`), `${path} is outside the session's folder`)
  assert.ok(
    calls.some((u) => (u.content ?? []).some((c) => c.type === 'diff')),
    'no diff reached the output',
  )
})

test('an interrupt cancels a running turn, and its text runs next as the answer', { skip }, async () => {
  const b = sandbox()
  const r = startRelay({ agent: [testy], prompt: 'wait_for_cancel', cwd: b.work, env: { ...QUIET, RELAY_INBOX: b.inbox } })
  await r.until((line) => relayEvent([line], 'steered') !== undefined)
  send(b.inbox, { interrupt: 'echo after the interrupt' })
  assert.equal(await r.exited, 0, r.stderr)
  assert.deepEqual(relayEvents(r.events), ['session', 'steered', 'prompt_done', 'interrupted', 'steered', 'prompt_done', 'done'])
  assert.deepEqual(
    relayEventsNamed(r.events, 'prompt_done').map((e) => e.stopReason),
    ['cancelled', 'end_turn'],
  )
  assert.equal(answer(r.events), 'after the interrupt')
})

test('a steer sent as a second prompt is answered while the first turn still runs', { skip }, async () => {
  const b = sandbox()
  const r = startRelay({
    agent: [testy],
    prompt: 'wait_for_cancel',
    cwd: b.work,
    env: { ...QUIET, RELAY_INBOX: b.inbox, RELAY_STEER: 'prompt' },
  })
  await r.until((line) => relayEvent([line], 'steered') !== undefined)
  send(b.inbox, 'echo steer')
  await r.until((line) => answer([line]) === 'steer')
  send(b.inbox, { interrupt: 'echo after' })
  assert.equal(await r.exited, 0, r.stderr)
  assert.equal(answer(r.events), 'steerafter')
})

test("a mode testy offers is set; a model it doesn't offer ends the run with testy's reason", { skip }, async () => {
  const moded = await run('session_updates', { RELAY_AGENT_MODE: 'plan' })
  assert.equal(moded.status, 0, moded.stderr)
  const mode = updates(moded.events).find((u) => u.sessionUpdate === 'current_mode_update')
  assert.equal(mode?.sessionUpdate === 'current_mode_update' ? mode.currentModeId : undefined, 'plan')
  const r = await run('echo hi', { RELAY_MODEL: 'gpt-6-luna' })
  assert.equal(r.status, 1)
  assert.match(
    String(relayEvent(r.events, 'error')?.message),
    /^the agent refused model gpt-6-luna: Invalid params: unsupported config option `model`/,
  )
})

const REPLIES = [
  { action: 'accept', content: { name: 'via' } },
  { action: 'decline' },
  { action: 'cancel' },
  { action: 'accept' },
  { action: 'decline' },
]
const answerQuestions = async (r: ReturnType<typeof startRelay>, inbox: string) => {
  for (const [i, reply] of REPLIES.entries()) {
    await r.until(() => relayEventsNamed(r.events, 'question').length > i)
    send(inbox, { question: relayEventsNamed(r.events, 'question')[i]?.id, answer: reply })
  }
}

test('callbacks: a permission ask reaches the plugin, and its answer goes back to testy', { skip }, async () => {
  const b = sandbox()
  const r = startRelay({
    agent: [testy],
    prompt: 'callbacks',
    cwd: b.work,
    env: { ...QUIET, RELAY_POLICY: 'ask', RELAY_INBOX: b.inbox },
    backstopMs: 10_000,
  })
  await r.until((line) => relayEvent([line], 'ask') !== undefined)
  const ask = relayEvent(r.events, 'ask')
  assert.ok(ask)
  assert.equal(ask.kind, 'execute')
  const options = get(ask, 'options')
  assert.ok(Array.isArray(options))
  assert.ok(options.some((o) => get(o, 'optionId') === 'reject_once'))
  send(b.inbox, { answer: ask.id, optionId: 'reject_once' })
  await answerQuestions(r, b.inbox)
  await r.exited
  assert.equal(r.stderr.includes('stopped after'), false, r.stderr)
  assert.equal(relayEventsNamed(r.events, 'ask').length, 1)
})

test("elicitations: each of testy's questions reaches the plugin, form and link, and each answer goes back", { skip }, async () => {
  const b = sandbox()
  const r = startRelay({ agent: [testy], prompt: 'elicitations', cwd: b.work, env: { ...QUIET, RELAY_INBOX: b.inbox }, backstopMs: 10_000 })
  await answerQuestions(r, b.inbox)
  assert.equal(await r.exited, 0, r.stderr)
  assert.equal(r.stderr.includes('stopped after'), false, r.stderr)
  const asked = relayEventsNamed(r.events, 'question')
  assert.deepEqual(
    asked.map((q) => q.mode),
    ['form', 'form', 'form', 'url', 'url'],
  )
  for (const q of asked) assert.equal(q.mode === 'url' ? typeof q.url : typeof q.requestedSchema, q.mode === 'url' ? 'string' : 'object')
  assert.equal(new Set(asked.map((q) => q.id)).size, asked.length)
})
