// The real `opencode acp` behind the real relay, with the model a local fake (support/fake-model.mts): no
// tokens, no network. As OpenCode's own ACP tests (packages/cli/test/acp/subprocess.ts): an isolated home,
// XDG folders and database, and a config whose one provider is an OpenAI-compatible one at the fake. The
// config goes in OPENCODE_CONFIG_DIR, leaving OPENCODE_CONFIG_CONTENT to via, as its read-only mode uses it.
// Skipped when opencode is not on PATH.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { chatText, chatToolCall, type FakeModel, hang, startFakeModel } from './support/fake-model.mts'
import {
  alive,
  answer,
  created,
  get,
  installed,
  relayEvent,
  relayEvents,
  relayEventsNamed,
  runRelay,
  sandbox,
  send,
  sessionOf,
  sleeping,
  spoken,
  startRelay,
  toolCalls,
} from './support/relay-run.mts'

const skip = installed('opencode') ? false : 'opencode is not on PATH'

let fake: FakeModel
beforeEach(async () => {
  fake = await startFakeModel()
  // OpenCode names each new session with a model request of its own, alongside the turn's.
  fake.aside((body) => String(body.messages?.[0]?.content).startsWith('You name conversations'), chatText('Fake title'))
})
afterEach(async () => {
  await fake.close()
})

const MODEL = {
  capabilities: { tools: true, input: ['text'], output: ['text'] },
  cost: { input: 0, output: 0 },
  limit: { context: 100_000, output: 10_000 },
}
const box = () => {
  const b = sandbox()
  const config = join(b.root, 'config')
  mkdirSync(config)
  writeFileSync(
    join(config, 'opencode.json'),
    JSON.stringify({
      update: 'disable',
      model: 'fake/fake-model',
      providers: {
        fake: {
          name: 'Fake',
          package: 'aisdk:@ai-sdk/openai-compatible',
          settings: { apiKey: 'fake-key', baseURL: fake.baseUrl },
          models: { 'fake-model': { ...MODEL, name: 'Fake Model' } },
        },
      },
    }),
  )
  writeFileSync(join(b.root, 'models.json'), '{}')
  const env = {
    HOME: b.home,
    OPENCODE_CONFIG_DIR: config,
    OPENCODE_DB: join(b.root, 'opencode.db'),
    OPENCODE_DISABLE_AUTOUPDATE: 'true',
    OPENCODE_DISABLE_FILEWATCHER: 'true',
    OPENCODE_DISABLE_MODELS_FETCH: 'true',
    OPENCODE_MODELS_PATH: join(b.root, 'models.json'),
    XDG_CACHE_HOME: join(b.root, 'cache'),
    XDG_CONFIG_HOME: join(b.root, 'xdg-config'),
    XDG_DATA_HOME: join(b.root, 'data'),
    XDG_STATE_HOME: join(b.root, 'state'),
  }
  return { ...b, env }
}
type Box = ReturnType<typeof box>

const opencode = (b: Box, prompt: string, env: Record<string, string> = {}) =>
  runRelay({ agent: ['opencode', 'acp'], prompt, cwd: b.work, env: { ...b.env, ...env } })

/** What request `n` carried, by role. */
const said = (n: number, role: string) =>
  (fake.requests[n]?.messages ?? []).filter((m) => m.role === role).map((m) => JSON.stringify(m.content))

test('a scripted answer arrives as the answer, and the run ends done', { skip }, async () => {
  const b = box()
  fake.enqueue(chatText('PO', 'NG'))
  const run = await opencode(b, 'Reply with only the word PONG.')
  assert.equal(run.status, 0, run.stderr)
  assert.equal(answer(run.events), 'PONG')
  assert.equal(relayEvent(run.events, 'model')?.name, 'fake/fake-model')
  assert.equal(relayEvent(run.events, 'done')?.stopReason, 'end_turn')
  assert.deepEqual(fake.unexpected, [])
})

test('a scripted shell command arrives as a tool call with its output, and OpenCode hands the output back', { skip }, async () => {
  const b = box()
  fake.enqueue(chatToolCall('call_shell', 'shell', { command: 'echo shell-ok' }), chatText('ran it'))
  // via's bypass mode: every question approved.
  const run = await opencode(b, 'Run echo shell-ok.', { RELAY_POLICY: 'allow' })
  assert.equal(run.status, 0, run.stderr)
  const calls = toolCalls(run.events)
  assert.equal(calls[0]?.toolCallId, 'call_shell')
  assert.equal(calls[0]?.kind, 'execute')
  assert.ok(calls.some((u) => get(u, 'rawInput', 'command') === 'echo shell-ok'))
  const done = calls.find((u) => u.status === 'completed')
  assert.deepEqual(done?.content, [{ type: 'content', content: { type: 'text', text: 'shell-ok\n' } }])
  assert.equal(answer(run.events), 'ran it')
  const output = fake.requests[1]?.messages?.find((m) => m.role === 'tool' && m.tool_call_id === 'call_shell')
  assert.match(JSON.stringify(output), /shell-ok/)
  assert.deepEqual(fake.unexpected, [])
})

test('a follow-up resumes the session, and OpenCode sends the model the earlier turn', { skip }, async () => {
  const b = box()
  fake.enqueue(chatText('PONG'))
  const first = await opencode(b, 'Reply with only the word PONG.')
  assert.equal(first.status, 0, first.stderr)
  const sessionId = sessionOf(first.events)
  fake.enqueue(chatText('You said PONG.'))
  const second = await opencode(b, 'What did you reply?', { RELAY_SESSION: sessionId })
  assert.equal(second.status, 0, second.stderr)
  assert.equal(sessionOf(second.events), sessionId)
  // The resumed session replays its history before the new prompt's answer.
  assert.deepEqual(spoken(second.events), { replayed: 'PONG', answered: 'You said PONG.' })
  assert.match(said(1, 'user').join(), /Reply with only the word PONG\./)
  assert.match(said(1, 'assistant').join(), /PONG/)
  assert.match(said(1, 'user').join(), /What did you reply\?/)
})

test('an interrupt cancels the turn and runs its text next, in the same session', { skip }, async () => {
  const b = box()
  fake.enqueue(hang(), chatText('REDIRECTED'))
  const run = startRelay({
    agent: ['opencode', 'acp'],
    prompt: 'Think for a long time.',
    cwd: b.work,
    env: { ...b.env, RELAY_INBOX: b.inbox },
  })
  await fake.requested(1, run.exited)
  send(b.inbox, { interrupt: 'Stop. Reply with only the word REDIRECTED.' })
  assert.equal(await run.exited, 0, run.stderr)
  assert.deepEqual(relayEvents(run.events), ['session', 'model', 'steered', 'prompt_done', 'interrupted', 'steered', 'prompt_done', 'done'])
  assert.deepEqual(
    relayEventsNamed(run.events, 'prompt_done').map((e) => e.stopReason),
    ['cancelled', 'end_turn'],
  )
  assert.equal(answer(run.events), 'REDIRECTED')
  assert.match(JSON.stringify(fake.requests.at(-1)?.messages), /Stop\. Reply with only the word REDIRECTED\./)
})

/** Starts a run whose model asks for a long `sleep`, and resolves once the sleep runs, with its pid. */
async function sleepingRun(b: Box, seconds: number, env: Record<string, string>) {
  const pidFile = join(b.work, 'sleep.pid')
  fake.enqueue(chatToolCall('call_sleep', 'shell', { command: sleeping(seconds, pidFile) }), chatText('REDIRECTED'))
  const run = startRelay({ agent: ['opencode', 'acp'], prompt: 'Sleep.', cwd: b.work, env: { ...b.env, RELAY_POLICY: 'allow', ...env } })
  // The command says when its sleep runs.
  await created(pidFile, run.exited)
  const pid = Number(readFileSync(pidFile, 'utf8'))
  assert.equal(alive(pid), true)
  return { run, pid }
}

// OpenCode runs commands in their own process group, so a group kill once left a `sleep` running. OpenCode
// 2.2.7 ends the command on SIGTERM itself (with the relay's cancel and close removed, no `sleep` is left), so
// what this guards today is that the stop's cancel or close ends the turn.
test('a stopped run ends its running shell command, leaving no process behind', { skip }, async () => {
  const b = box()
  const { run, pid } = await sleepingRun(b, 61.3, {})
  run.stop()
  await run.exited
  assert.equal(alive(pid), false)
  // The stop's cancel ends OpenCode's turn, which the relay reports as it ended.
  assert.equal(relayEvent(run.events, 'prompt_done')?.stopReason, 'cancelled')
})

test('an interrupt during a shell command ends the command, leaving no process behind', { skip }, async () => {
  const b = box()
  const { run, pid } = await sleepingRun(b, 41.7, { RELAY_INBOX: b.inbox })
  send(b.inbox, { interrupt: 'Stop. Reply with only the word REDIRECTED.' })
  assert.equal(await run.exited, 0, run.stderr)
  assert.equal(alive(pid), false)
  assert.equal(answer(run.events), 'REDIRECTED')
  assert.match(JSON.stringify(fake.requests.at(-1)?.messages), /Stop\. Reply with only the word REDIRECTED\./)
})

test('RELAY_DELETE deletes the session, so resuming it afterwards finds it lost', { skip }, async () => {
  const b = box()
  fake.enqueue(chatText('PONG'))
  const first = await opencode(b, 'Reply with only the word PONG.')
  assert.equal(first.status, 0, first.stderr)
  const sessionId = sessionOf(first.events)
  const deleted = await opencode(b, '', { RELAY_DELETE: sessionId })
  assert.equal(deleted.status, 0, deleted.stderr)
  assert.deepEqual(relayEvent(deleted.events, 'forgotten'), { relay: 'forgotten', sessionId, how: 'deleted' })
  const again = await opencode(b, 'What did you reply?', { RELAY_SESSION: sessionId })
  assert.ok(relayEvent(again.events, 'session_lost'), again.stderr)
})
