// The relay against a fake ACP agent (fake-agent.mts), run as via runs it: only PATH and what each test sets reach
// the relay and the agent, so nothing of the person's (a RELAY_* or FAKE_* variable of theirs) changes a result.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import type { ClientCapabilities } from '@agentclientprotocol/sdk/unstable'
import { PNG } from './support/png.mts'
import {
  answer,
  get,
  type Printed,
  relayEvent,
  relayEvents,
  relayEventsNamed,
  runRelay,
  sandbox,
  send,
  startRelay,
  updates,
} from './support/relay-run.mts'

const agent = ['node', new URL('./fake-agent.mts', import.meta.url).pathname]

/** Runs the relay over the fake agent with `env` to its end. */
const fake = (env: Record<string, string>, prompt = 'hi', cwd = sandbox().work) => runRelay({ agent, prompt, cwd, env })

/** What the fake agent echoes with FAKE_ECHO: the client's capabilities and the prompt's block types. */
type Echo = { readonly offered: ClientCapabilities; readonly blocks: readonly string[] }
const said = async (prompt: string, cwd?: string): Promise<Echo> =>
  JSON.parse(answer((await fake({ FAKE_ECHO: '1' }, prompt, cwd)).events)) as Echo

const errorOf = (events: readonly Printed[]) => relayEvent(events, 'error')?.message

/** A file the fake agent writes each cancel, close, mode and config option to (FAKE_LOG). */
const logFile = () => join(sandbox().root, 'log')
const logged = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [])

test("an agent's error keeps the cause its data carries, not only 'Internal error'", async () => {
  const run = await fake({})
  assert.equal(errorOf(run.events), "Internal error: You've hit your usage limit. Try again at 10:04 PM.")
  assert.equal(run.status, 1)
})

test('a refused or limit-stopped prompt is forwarded as it ended, not as a relay failure', async () => {
  for (const stop of ['refusal', 'max_tokens', 'max_turn_requests']) {
    const run = await fake({ FAKE_ECHO: '1', FAKE_STOP: stop })
    assert.equal(relayEvent(run.events, 'prompt_done')?.stopReason, stop)
    assert.equal(relayEvent(run.events, 'done')?.stopReason, stop)
    assert.equal(errorOf(run.events), undefined)
    assert.equal(run.status, 0)
  }
})

test('the relay offers streamed command output, no terminal of its own, and no plan capability', async () => {
  const { offered } = await said('hi')
  // With one, codex-acp sends a markdown plan as plan_update, which via does not draw, in place of text.
  assert.equal(get(offered, 'plan'), undefined)
  assert.equal(get(offered, '_meta', 'terminal_output_delta'), true)
  assert.equal(offered.terminal, false)
  assert.deepEqual(get(offered, 'session', 'notices'), {})
  // Questions to the person, both kinds, which Claude Code's own elicitation form shows.
  assert.deepEqual(get(offered, 'elicitation'), { form: {}, url: {} })
})

test('an image under the working folder goes along to an agent that takes images; a missing, fake or outside one stays text', async () => {
  const dir = sandbox().work
  const outside = sandbox().work
  const png = join(dir, 'shot.png')
  writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  writeFileSync(join(dir, 'fake.png'), 'not a png')
  writeFileSync(join(outside, 'secret.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  const prompt = `Look at ${png}, ${join(dir, 'gone.png')}, ${join(dir, 'fake.png')}, ${join(outside, 'secret.png')} and docs${png}`
  assert.deepEqual((await said(prompt, dir)).blocks, ['text', 'image:image/png:8'])
})

test('a symlink or .. that leads out of the working folder stays text, and at most four images go along', async () => {
  // Real paths (macOS's temp folder is itself a symlink), so only the link or the .. decides.
  const dir = realpathSync(sandbox().work)
  const outside = realpathSync(sandbox().work)
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47])
  writeFileSync(join(outside, 'secret.png'), png)
  symlinkSync(join(outside, 'secret.png'), join(dir, 'link.png'))
  mkdirSync(join(dir, 'sub'))
  // Written out, not joined: join would resolve the .. before the relay sees it.
  const outOfRoots = `${dir}/sub/../../../${outside.split('/').slice(-2).join('/')}/secret.png`
  assert.deepEqual((await said(`See ${join(dir, 'link.png')} and ${outOfRoots}`, dir)).blocks, ['text'])
  const many = [1, 2, 3, 4, 5].map((n) => {
    const path = join(dir, `${n}.png`)
    writeFileSync(path, png)
    return path
  })
  assert.equal((await said(`See ${many.join(' ')}`, dir)).blocks.length, 1 + 4)
})

test('a run that ends closes its session when the agent can close one, and only then', async () => {
  for (const close of ['1', '']) {
    const log = logFile()
    const run = await fake({ FAKE_ECHO: '1', FAKE_CLOSE: close, FAKE_LOG: log })
    assert.equal(run.status, 0)
    assert.deepEqual(logged(log), close ? ['close'] : [])
  }
})

// The agent keeps its turn past the cancel, so the run never reaches its own end: the close is the stop's.
test('a stopped run cancels the turn, then closes the session, before the kill', async () => {
  const log = logFile()
  const run = startRelay({ agent, prompt: 'hi', cwd: sandbox().work, env: { FAKE_CLOSE: '1', FAKE_HANG: 'stubborn', FAKE_LOG: log } })
  // The agent says when it holds the prompt.
  await run.until((line) => answer([line]) === 'holding')
  run.stop()
  await run.exited
  assert.deepEqual(logged(log), ['prompt', 'cancel', 'close'])
  assert.equal(relayEvent(run.events, 'done'), undefined)
})

// Codex keeps a cancelled turn's commands as background terminals until its session closes.
test("an interrupt closes the session, which stops the step's commands, and reopens it for its message", async () => {
  const b = sandbox()
  const log = logFile()
  const env = {
    FAKE_CLOSE: 'resume',
    FAKE_HANG: 'once',
    FAKE_ECHO: '1',
    FAKE_LOG: log,
    RELAY_INBOX: b.inbox,
    RELAY_AGENT_MODE: 'workspace-write',
  }
  const run = startRelay({ agent, prompt: 'hi', cwd: b.work, env })
  await run.until((line) => answer([line]) === 'holding')
  send(b.inbox, { interrupt: 'stop' })
  assert.equal(await run.exited, 0, run.stderr)
  // The mode is set again on the reopened session, which starts from the agent's defaults; the run's end closes it too.
  const mode = 'mode workspace-write'
  assert.deepEqual(logged(log), [mode, 'prompt', 'cancel', 'close', 'resume', mode, 'prompt', 'close'])
  assert.deepEqual(relayEventsNamed(run.events, 'interrupted').length, 1)
})

// Without resume the session stays open across the interrupt, as before.
test('an interrupt leaves the session open for an agent that cannot resume one', async () => {
  const b = sandbox()
  const log = logFile()
  const run = startRelay({
    agent,
    prompt: 'hi',
    cwd: b.work,
    env: { FAKE_CLOSE: '1', FAKE_HANG: 'once', FAKE_ECHO: '1', FAKE_LOG: log, RELAY_INBOX: b.inbox },
  })
  await run.until((line) => answer([line]) === 'holding')
  send(b.inbox, { interrupt: 'stop' })
  assert.equal(await run.exited, 0, run.stderr)
  assert.deepEqual(logged(log), ['prompt', 'cancel', 'prompt', 'close'])
})

/** A run with the fake agent offering config options, and what it ended with and set. */
const configured = async (env: Record<string, string>) => {
  const log = logFile()
  const run = await fake({ FAKE_ECHO: '1', FAKE_OPTIONS: '1', FAKE_LOG: log, ...env })
  return { status: run.status, error: errorOf(run.events), set: logged(log), events: run.events }
}
const via = (config: Record<string, string>) => configured({ RELAY_CONFIG: JSON.stringify(config) })
const person = (options: Record<string, string>, env: Record<string, string> = {}) =>
  configured({ RELAY_OPTIONS: JSON.stringify(options), ...env })
const outcome = ({ status, error, set }: Awaited<ReturnType<typeof configured>>) => ({ status, error, set })

test("a config option the session offers is set; a value it doesn't offer is refused, naming those it does", async () => {
  assert.deepEqual(outcome(await via({ reasoning_effort: 'high' })), { status: 0, error: undefined, set: ['set reasoning_effort=high'] })
  assert.deepEqual(outcome(await via({ reasoning_effort: 'ultra' })), {
    status: 1,
    error: 'the agent offers reasoning_effort low, medium, high, xhigh for gpt-6-luna, not ultra',
    set: [],
  })
})

test('a config option the session does not offer is refused, not sent', async () => {
  assert.deepEqual(outcome(await via({ speed: 'fast' })), { status: 1, error: 'the agent offers no speed option for gpt-6-luna', set: [] })
})

test("a person's config option is set when offered; one the session lacks is a warning, and the run goes on", async () => {
  assert.deepEqual(outcome(await person({ 'fast-mode': 'on' })), { status: 0, error: undefined, set: ['set fast-mode=on'] })
  const lacking = await person({ speed: 'fast' })
  assert.deepEqual(outcome(lacking), { status: 0, error: undefined, set: [] })
  const notice = updates(lacking.events).find((u) => u.sessionUpdate === 'notice')
  assert.equal(
    notice?.sessionUpdate === 'notice' ? notice.title : undefined,
    'the agent offers no speed option for gpt-6-luna, so this run goes without it; it offers fast-mode. config: speed= drops it.',
  )
  assert.equal(relayEvent(lacking.events, 'done')?.stopReason, 'end_turn')
})

test("via's mode is set again after a person's options, so one named some other way cannot leave the session in another", async () => {
  assert.deepEqual((await person({ 'fast-mode': 'on' }, { RELAY_AGENT_MODE: 'workspace-write' })).set, [
    'mode workspace-write',
    'set fast-mode=on',
    'mode workspace-write',
  ])
})

test("a person's config line sets only options that tune the model: never a mode, model or thinking one", async () => {
  for (const id of ['mode', 'model', 'reasoning_effort', 'sandbox'])
    assert.deepEqual(outcome(await person({ [id]: id === 'mode' ? 'agent-full-access' : 'off' })), {
      status: 1,
      error: `${id} is not an option a config line sets: only ones that tune the model, such as fast-mode. config: ${id}= drops it.`,
      set: [],
    })
})

test('a config line refused where the agent offers no option that tunes the model says so', async () => {
  assert.deepEqual(outcome(await person({ mode: 'plan' }, { FAKE_OPTIONS: 'plain' })), {
    status: 1,
    error: 'mode is not an option a config line sets: only ones that tune the model, and the agent offers none. config: mode= drops it.',
    set: [],
  })
})

test("a refused model, mode or config option keeps the agent's reason, not only 'Invalid params'", async () => {
  const refused = async (env: Record<string, string>) => {
    const run = await configured({ FAKE_REFUSE: '1', ...env })
    assert.equal(run.status, 1)
    return run.error
  }
  assert.equal(
    await refused({ RELAY_MODEL: 'gpt-6.1-sol' }),
    'the agent refused model gpt-6.1-sol: Invalid params: no model gpt-6.1-sol here; try gpt-6-luna',
  )
  assert.equal(
    await refused({ RELAY_AGENT_MODE: 'read-only' }),
    'the agent refused mode read-only: Invalid params: no mode read-only here; try workspace-write',
  )
  assert.equal(
    await refused({ RELAY_CONFIG: JSON.stringify({ reasoning_effort: 'high' }) }),
    'the agent refused reasoning_effort high: Invalid params: no reasoning_effort high here; try gpt-6-luna',
  )
})

// via saves the session the relay names: one named before a refusal would be resumed with no prompt in it.
test('a run that fails setting up its new session names no session to save; one set up names it before its prompt', async () => {
  const refused: Record<string, string>[] = [
    { RELAY_MODEL: 'gpt-6.1-sol' },
    { RELAY_AGENT_MODE: 'read-only' },
    { RELAY_CONFIG: JSON.stringify({ reasoning_effort: 'high' }) },
  ]
  for (const env of refused) {
    const run = await configured({ FAKE_REFUSE: '1', ...env })
    assert.equal(run.status, 1)
    assert.equal(relayEvent(run.events, 'session'), undefined)
  }
  const set = await configured({ RELAY_MODEL: 'gpt-6-luna' })
  assert.deepEqual(relayEvents(set.events), ['session', 'model', 'steered', 'prompt_done', 'done'])
})

test('a permission request is answered by RELAY_POLICY: allow picks allow_once; deny, the default, reject_once', async () => {
  assert.equal(answer((await fake({ FAKE_ASK: '1', RELAY_POLICY: 'allow' })).events), 'chose allow_once')
  assert.equal(answer((await fake({ FAKE_ASK: '1', RELAY_POLICY: 'deny' })).events), 'chose reject_once')
  assert.equal(answer((await fake({ FAKE_ASK: '1' })).events), 'chose reject_once')
})

test('with RELAY_POLICY=ask the request reaches the plugin as an ask, and its answer reaches the agent', async () => {
  const b = sandbox()
  const run = startRelay({ agent, prompt: 'hi', cwd: b.work, env: { FAKE_ASK: '1', RELAY_POLICY: 'ask', RELAY_INBOX: b.inbox } })
  await run.until((line) => relayEvent([line], 'ask') !== undefined)
  const ask = relayEvent(run.events, 'ask')
  assert.ok(ask)
  assert.equal(ask.title, 'rm -rf build')
  assert.deepEqual(get(ask, 'options'), [
    { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
    { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' },
  ])
  send(b.inbox, { answer: ask.id, optionId: 'allow_once' })
  assert.equal(await run.exited, 0, run.stderr)
  assert.equal(answer(run.events), 'chose allow_once')
})

test('with RELAY_POLICY=ask and no inbox no answer can come back, so the request is denied', async () => {
  assert.equal(answer((await fake({ FAKE_ASK: '1', RELAY_POLICY: 'ask' })).events), 'chose reject_once')
})

/** A run whose agent asks the person one question (FAKE_QUESTION): the question the relay printed, and the run. */
const questioned = async (kind: 'form' | 'url') => {
  const b = sandbox()
  const run = startRelay({ agent, prompt: 'hi', cwd: b.work, env: { FAKE_QUESTION: kind, RELAY_INBOX: b.inbox } })
  await run.until((line) => relayEvent([line], 'question') !== undefined)
  const asked = relayEvent(run.events, 'question')
  assert.ok(asked)
  return { asked, run, reply: (value: unknown) => send(b.inbox, { question: asked.id, answer: value }) }
}

test("a harness's question goes out as a question line, without ACP's scope, and the person's answer goes back", async () => {
  const { asked, run, reply } = await questioned('form')
  assert.deepEqual(
    { mode: asked.mode, message: asked.message, requestedSchema: asked.requestedSchema },
    {
      mode: 'form',
      message: 'Which target?',
      requestedSchema: {
        type: 'object',
        properties: { target: { type: 'string', enum: ['staging', 'production'] } },
        required: ['target'],
      },
    },
  )
  assert.equal(get(asked, 'sessionId'), undefined)
  reply({ action: 'accept', content: { target: 'production' } })
  assert.equal(await run.exited, 0, run.stderr)
  assert.equal(answer(run.events), 'got {"action":"accept","content":{"target":"production"}}')
})

test('a link question carries its link and id; a decline goes back as a decline', async () => {
  const { asked, run, reply } = await questioned('url')
  assert.deepEqual(
    { mode: asked.mode, url: asked.url, elicitationId: asked.elicitationId },
    { mode: 'url', url: 'https://example.com/login', elicitationId: 'e1' },
  )
  reply({ action: 'decline' })
  assert.equal(await run.exited, 0, run.stderr)
  assert.equal(answer(run.events), 'got {"action":"decline"}')
})

test('an answer that is no accept or decline goes back as a cancel', async () => {
  const { run, reply } = await questioned('form')
  reply({ action: 'maybe' })
  assert.equal(await run.exited, 0, run.stderr)
  assert.equal(answer(run.events), 'got {"action":"cancel"}')
})

test('an interrupt cancels a question still open', async () => {
  const b = sandbox()
  const run = startRelay({ agent, prompt: 'hi', cwd: b.work, env: { FAKE_QUESTION: 'form', RELAY_INBOX: b.inbox } })
  await run.until((line) => relayEvent([line], 'question') !== undefined)
  send(b.inbox, { interrupt: 'stop' })
  // The interrupt's text runs next, and the fake asks again: answered, the run ends on its own.
  await run.until(() => relayEventsNamed(run.events, 'question').length === 2)
  const [first, second] = relayEventsNamed(run.events, 'question')
  send(b.inbox, { question: second?.id, answer: { action: 'decline' } })
  assert.equal(await run.exited, 0, run.stderr)
  assert.equal(run.stderr.includes('stopped after'), false, run.stderr)
  assert.equal(answer(run.events), 'got {"action":"cancel"}got {"action":"decline"}')
  // Said, so the plugin stops waiting on the person for it; the answered one is not.
  assert.deepEqual(
    relayEventsNamed(run.events, 'question_closed').map((e) => e.id),
    [first?.id],
  )
})

test('with no inbox no answer can come back, so a question is cancelled', async () => {
  assert.equal(answer((await fake({ FAKE_QUESTION: 'form' })).events), 'got {"action":"cancel"}')
})

test('a link to open that is no web page is cancelled, never shown', async () => {
  const b = sandbox()
  const r = await runRelay({
    agent,
    prompt: 'hi',
    cwd: b.work,
    env: { FAKE_QUESTION: 'url', FAKE_QUESTION_URL: 'file:///etc/passwd', RELAY_INBOX: b.inbox },
  })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(relayEvent(r.events, 'question'), undefined)
  assert.equal(answer(r.events), 'got {"action":"cancel"}')
})

test('a question the agent withdraws is closed, said with its id, and nothing waits on the person', async () => {
  const b = sandbox()
  const r = await runRelay({ agent, prompt: 'hi', cwd: b.work, env: { FAKE_QUESTION: 'form', FAKE_WITHDRAW: '1', RELAY_INBOX: b.inbox } })
  assert.equal(r.status, 0, r.stderr)
  const asked = relayEvent(r.events, 'question')
  assert.ok(asked)
  assert.equal(relayEvent(r.events, 'question_closed')?.id, asked.id)
})

/** The image block a FAKE_IMAGE run printed. */
const imaged = async (env: Record<string, string>) => {
  const r = await fake({ FAKE_IMAGE: '1', ...env })
  assert.equal(r.status, 0, r.stderr)
  const chunk = updates(r.events).find((u) => u.sessionUpdate === 'agent_message_chunk')
  assert.ok(chunk?.sessionUpdate === 'agent_message_chunk' && chunk.content.type === 'image')
  return chunk.content
}

test("what the agent sends as bytes is saved to RELAY_FILES, and printed with the file's path in place of its bytes", async () => {
  const files = join(sandbox().root, 'files')
  const image = await imaged({ RELAY_FILES: files })
  assert.equal(image.data, '')
  const saved = get(image, '_meta', 'relay', 'saved')
  assert.equal(typeof saved, 'string')
  assert.ok(String(saved).startsWith(`${files}/`) && String(saved).endsWith('.png'), String(saved))
  assert.deepEqual(readFileSync(String(saved)), Buffer.from(PNG, 'base64'))
  assert.equal(get(image, '_meta', 'relay', 'size'), Buffer.from(PNG, 'base64').length)
})

test('an image in a message to a subagent is saved to RELAY_FILES, whole or as a chunk', async () => {
  const files = join(sandbox().root, 'files')
  const r = await fake({ FAKE_IMAGE: 'message', RELAY_FILES: files })
  assert.equal(r.status, 0, r.stderr)
  const blocks = updates(r.events).flatMap((u) =>
    u.sessionUpdate === 'session_message' ? (u.content ?? []) : u.sessionUpdate === 'session_message_chunk' ? [u.content] : [],
  )
  assert.equal(blocks.length, 2)
  for (const image of blocks) {
    assert.ok(image.type === 'image')
    assert.equal(image.data, '')
    assert.deepEqual(readFileSync(String(get(image, '_meta', 'relay', 'saved'))), Buffer.from(PNG, 'base64'))
  }
})

test("bytes that can't be saved are left out all the same, with the reason", async () => {
  const b = sandbox()
  const notAFolder = join(b.root, 'taken')
  writeFileSync(notAFolder, '')
  const image = await imaged({ RELAY_FILES: notAFolder })
  assert.equal(image.data, '')
  assert.match(String(get(image, '_meta', 'relay', 'notSaved')), /EEXIST|ENOTDIR/)
})

test('without RELAY_FILES the bytes are printed as the agent sent them', async () => {
  const image = await imaged({})
  assert.equal(image.data, PNG)
  assert.equal(get(image, '_meta', 'relay'), undefined)
})

test("a resumed session's replayed bytes are not saved again: only what comes after the prompt", async () => {
  const files = join(sandbox().root, 'files')
  const r = await fake({ FAKE_IMAGE: '1', RELAY_SESSION: 's1', RELAY_FILES: files })
  assert.equal(r.status, 0, r.stderr)
  const images = updates(r.events).flatMap((u) =>
    (u.sessionUpdate === 'user_message_chunk' || u.sessionUpdate === 'agent_message_chunk') && u.content.type === 'image' ? [u] : [],
  )
  assert.deepEqual(
    images.map((u) => [u.sessionUpdate, u.content.type === 'image' && u.content.data === '']),
    [
      ['user_message_chunk', false],
      ['agent_message_chunk', true],
    ],
  )
  assert.equal(readdirSync(files).length, 1)
})
