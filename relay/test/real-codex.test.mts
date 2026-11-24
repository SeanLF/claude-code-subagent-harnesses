// The real codex-acp and the real `codex app-server` behind the real relay, with the model a local fake
// (support/fake-model.mts): no tokens, no network. Codex reads its provider from CODEX_HOME/config.toml,
// pointed at the fake, so the relay runs as via runs it, with no login and no change of its own. Skipped
// when codex or codex-acp is not installed: CODEX_ACP names codex-acp's dist/index.js, or via's own
// install of the pinned version is used.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import {
  execCommandResponse,
  type FakeModel,
  functionCallResponse,
  hang,
  type ModelRequest,
  startFakeModel,
  textResponse,
} from './support/fake-model.mts'
import {
  alive,
  answer,
  created,
  get,
  installed,
  notifications,
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
  updates,
} from './support/relay-run.mts'

const lock = JSON.parse(readFileSync(new URL('../codex-acp/package-lock.json', import.meta.url), 'utf8')) as {
  packages: Record<string, { version?: string }>
}
const pinned = lock.packages['node_modules/@agentclientprotocol/codex-acp']?.version
const codexAcp =
  process.env.CODEX_ACP ?? join(homedir(), `.claude/via/acp/codex-acp-${pinned}/node_modules/@agentclientprotocol/codex-acp/dist/index.js`)
const skip = !installed('codex') ? 'codex is not on PATH' : !existsSync(codexAcp) ? `codex-acp is not at ${codexAcp}` : false

let fake: FakeModel
beforeEach(async () => {
  fake = await startFakeModel()
})
afterEach(async () => {
  await fake.close()
})

// A Codex home per test, its provider the fake: the person's ~/.codex is never read, and no login is needed.
// gpt-5.5 calls exec_command itself; newer models wrap tools in code mode (codex-acp's integration tests).
// Plugins off: with them Codex reaches chatgpt.com and github.com at startup. features: more of Codex's own.
const box = (features: string[] = []) => {
  const b = sandbox()
  const codexHome = join(b.root, 'codex-home')
  mkdirSync(codexHome)
  writeFileSync(
    join(codexHome, 'config.toml'),
    [
      'model = "gpt-5.5"',
      'model_provider = "fake"',
      'web_search = "disabled"',
      '[model_providers.fake]',
      'name = "fake"',
      `base_url = "${fake.baseUrl}"`,
      'wire_api = "responses"',
      '[features]',
      'plugins = false',
      ...features,
      '',
    ].join('\n'),
  )
  return { ...b, env: { HOME: b.home, CODEX_HOME: codexHome, CODEX_PATH: 'codex' } }
}
type Box = ReturnType<typeof box>

const codex = (b: Box, prompt: string, env: Record<string, string> = {}) =>
  runRelay({ agent: ['node', codexAcp], prompt, cwd: b.work, env: { ...b.env, ...env } })

/** What request `n` carried, by role: Codex sends each message's content as a list of parts. */
const said = (n: number, role: string) =>
  (fake.requests[n]?.input ?? []).filter((i) => i.type === 'message' && i.role === role).map((i) => JSON.stringify(i.content))

test('a scripted answer arrives as the answer, and the run ends done', { skip }, async () => {
  const b = box()
  fake.enqueue(textResponse('PO', 'NG'))
  const run = await codex(b, 'Reply with only the word PONG.')
  assert.equal(run.status, 0, run.stderr)
  assert.equal(answer(run.events), 'PONG')
  assert.equal(relayEvent(run.events, 'model')?.name, 'gpt-5.5')
  assert.equal(relayEvent(run.events, 'done')?.stopReason, 'end_turn')
  assert.deepEqual(fake.unexpected, [])
})

test('a scripted shell command arrives as a tool call with its output, and Codex hands the output back', { skip }, async () => {
  const b = box()
  fake.enqueue(execCommandResponse('call_shell', { cmd: 'echo shell-ok' }), textResponse('ran it'))
  // via's bypass mode: full access, every question approved.
  const run = await codex(b, 'Run echo shell-ok.', { RELAY_AGENT_MODE: 'agent-full-access', RELAY_POLICY: 'allow' })
  assert.equal(run.status, 0, run.stderr)
  const [call, ...rest] = toolCalls(run.events)
  assert.equal(call?.toolCallId, 'call_shell')
  assert.equal(call?.kind, 'execute')
  assert.equal(get(call, 'rawInput', 'command'), 'echo shell-ok')
  const done = rest.find((u) => u.status === 'completed')
  assert.equal(get(done, '_meta', 'terminal_output_delta', 'data'), 'shell-ok\n')
  assert.equal(get(done, '_meta', 'terminal_exit', 'exit_code'), 0)
  assert.equal(answer(run.events), 'ran it')
  const output = fake.requests[1]?.input?.find((i) => i.type === 'function_call_output' && i.call_id === 'call_shell')
  assert.match(JSON.stringify(output), /shell-ok/)
  assert.deepEqual(fake.unexpected, [])
})

test('a follow-up resumes the session, and Codex sends the model the earlier turn', { skip }, async () => {
  const b = box()
  fake.enqueue(textResponse('PONG'))
  const first = await codex(b, 'Reply with only the word PONG.')
  assert.equal(first.status, 0, first.stderr)
  const sessionId = sessionOf(first.events)
  fake.enqueue(textResponse('You said PONG.'))
  // A new relay and a new codex-acp, as via starts for each message.
  const second = await codex(b, 'What did you reply?', { RELAY_SESSION: sessionId })
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
  fake.enqueue(hang(), textResponse('REDIRECTED'))
  const run = startRelay({
    agent: ['node', codexAcp],
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
  assert.match(JSON.stringify(fake.requests.at(-1)?.input), /Stop\. Reply with only the word REDIRECTED\./)
})

// Codex asks with request_user_input, outside Plan mode only with its feature on; codex-acp asks the client.
test("Codex's own question reaches the relay as a form, and the person's choice reaches the model", { skip }, async () => {
  const b = box(['default_mode_request_user_input = true'])
  const question = {
    id: 'target',
    header: 'Target',
    question: 'Which target?',
    options: [
      { label: 'staging', description: 'safe' },
      { label: 'production', description: 'live' },
    ],
  }
  fake.enqueue(functionCallResponse('call_q', 'request_user_input', { questions: [question] }))
  fake.enqueue(textResponse('DONE'))
  const run = startRelay({ agent: ['node', codexAcp], prompt: 'go', cwd: b.work, env: { ...b.env, RELAY_INBOX: b.inbox } })
  await run.until((line) => relayEvent([line], 'question') !== undefined)
  const asked = relayEvent(run.events, 'question')
  assert.equal(asked?.mode, 'form')
  // Codex's choices, as titled options of the question's field.
  const choices = get(asked, 'requestedSchema', 'properties', 'target', 'oneOf')
  assert.ok(Array.isArray(choices))
  assert.deepEqual(
    choices.slice(0, 2).map((c) => get(c, 'const')),
    ['staging', 'production'],
  )
  send(b.inbox, { question: asked?.id, answer: { action: 'accept', content: { target: 'production' } } })
  assert.equal(await run.exited, 0, run.stderr)
  const output = (fake.requests[1]?.input ?? []).find((i) => i.type === 'function_call_output' && i.call_id === 'call_q')
  assert.deepEqual(JSON.parse(String(get(output, 'output'))), { answers: { target: { answers: ['production'] } } })
  assert.deepEqual(fake.unexpected, [])
})

// Codex's own multi-agent tools (`multi_agent`, on by default), called as the model calls them. The child
// answers its task only once the parent has sent the follow-up, as a child still working when it arrives.
const SPAWN = 'Reply with only the word KESTREL.'
const FOLLOWUP = 'Now reply with only the word OSPREY.'

test("a subagent's task and a follow-up sent while it works reach the relay as messages to it, each from both sides", {
  skip,
}, async () => {
  const b = box(['multi_agent = true'])
  let release = () => {}
  const followedUp = new Promise<void>((resolve) => {
    release = resolve
  })
  const users = (body: ModelRequest) => JSON.stringify((body.input ?? []).filter((i) => i.type === 'message' && i.role === 'user'))
  const agent = (body: ModelRequest) => {
    const spawned = (body.input ?? []).find((i) => i.type === 'function_call_output' && i.call_id === 'spawn')
    return spawned ? String((JSON.parse(String((spawned as { output?: unknown }).output)) as { agent_id?: unknown }).agent_id) : ''
  }
  for (let i = 0; i < 20; i++)
    fake.enqueue(async (body) => {
      if (users(body).includes(SPAWN)) {
        if (users(body).includes(FOLLOWUP)) return textResponse('OSPREY')
        await followedUp
        return textResponse('KESTREL')
      }
      const outputs = (body.input ?? []).filter((item) => item.type === 'function_call_output').length
      const target = agent(body)
      if (outputs === 0) return functionCallResponse('spawn', 'spawn_agent', { message: SPAWN }, 'multi_agent_v1')
      if (outputs === 1) return functionCallResponse('followup', 'send_input', { target, message: FOLLOWUP }, 'multi_agent_v1')
      if (outputs === 2) {
        release()
        return functionCallResponse('wait', 'wait_agent', { targets: [target] }, 'multi_agent_v1')
      }
      return textResponse('DONE')
    })
  const run = await codex(b, 'Delegate this.')
  assert.equal(run.status, 0, run.stderr)
  const root = sessionOf(run.events)
  const child = updates(run.events).find((u) => u.sessionUpdate === 'subagent_update')?.sessionId
  assert.equal(typeof child, 'string')
  // Each message: the parent's outgoing view, then the child's incoming one, linked to it.
  const views = notifications(run.events).flatMap(({ sessionId, update: u }) =>
    u.sessionUpdate === 'session_message' && u.content
      ? [{ session: sessionId, id: u.messageId, to: u.recipientSessionId, from: u.senderMessageId, text: get(u, 'content', '0', 'text') }]
      : [],
  )
  const [spawn, , followup] = views
  assert.deepEqual(
    views.map(({ id: _, ...view }) => view),
    [
      { session: root, to: child, from: undefined, text: SPAWN },
      { session: child, to: child, from: spawn?.id, text: SPAWN },
      { session: root, to: child, from: undefined, text: FOLLOWUP },
      { session: child, to: child, from: followup?.id, text: FOLLOWUP },
    ],
  )
  assert.equal(answer(run.events.filter((e) => !('sessionId' in e) || e.sessionId === root)), 'DONE')
})

/** Starts a run whose model asks for a long `sleep`, and resolves once the sleep runs, with its pid. */
async function sleepingRun(b: Box, seconds: number, env: Record<string, string>) {
  const pidFile = join(b.work, 'sleep.pid')
  // The interrupt is sent once the command runs, long before Codex's yield (10 s) would hand it back to the model.
  fake.enqueue(execCommandResponse('call_sleep', { cmd: sleeping(seconds, pidFile) }), textResponse('REDIRECTED'))
  // via's bypass mode: the command runs without a question.
  const run = startRelay({
    agent: ['node', codexAcp],
    prompt: 'Sleep.',
    cwd: b.work,
    env: { ...b.env, RELAY_AGENT_MODE: 'agent-full-access', RELAY_POLICY: 'allow', ...env },
  })
  await created(pidFile, run.exited)
  const pid = Number(readFileSync(pidFile, 'utf8'))
  assert.equal(alive(pid), true)
  return { run, pid }
}

// Codex keeps a cancelled turn's commands as background terminals (#58): an interrupt ends the turn, not
// them. The relay closes the session at the run's end, which stops them; until then they run on.
test('a shell command an interrupt leaves running ends with the run, leaving no process behind', { skip }, async () => {
  const b = box()
  const { run, pid } = await sleepingRun(b, 41.7, { RELAY_INBOX: b.inbox })
  send(b.inbox, { interrupt: 'Stop. Reply with only the word REDIRECTED.' })
  assert.equal(await run.exited, 0, run.stderr)
  assert.equal(alive(pid), false)
  // The interrupt cut the turn mid-command, and its text was the next prompt.
  assert.deepEqual(
    relayEventsNamed(run.events, 'prompt_done').map((e) => e.stopReason),
    ['cancelled', 'end_turn'],
  )
  assert.match(JSON.stringify(fake.requests.at(-1)?.input), /Stop\. Reply with only the word REDIRECTED\./)
  assert.equal(answer(run.events), 'REDIRECTED')
})

test('RELAY_DELETE has Codex archive the session, so resuming it afterwards is refused until it is unarchived', { skip }, async () => {
  const b = box()
  fake.enqueue(textResponse('PONG'))
  const first = await codex(b, 'Reply with only the word PONG.')
  assert.equal(first.status, 0, first.stderr)
  const sessionId = sessionOf(first.events)
  const deleted = await codex(b, '', { RELAY_DELETE: sessionId })
  assert.equal(deleted.status, 0, deleted.stderr)
  assert.deepEqual(relayEvent(deleted.events, 'forgotten'), { relay: 'forgotten', sessionId, how: 'deleted' })
  const again = await codex(b, 'What did you reply?', { RELAY_SESSION: sessionId })
  // codex-acp's delete is Codex's archive: the session is kept, and `codex unarchive` brings it back.
  assert.ok(relayEvent(again.events, 'error')?.message.includes(`is archived. Run \`codex unarchive ${sessionId}\``), again.stderr)
})
