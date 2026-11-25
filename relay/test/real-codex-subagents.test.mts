import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { backstop } from './support/backstop.mts'
import { type FakeModel, functionCallResponse, type ModelRequest, startFakeModel, textResponse } from './support/fake-model.mts'
import { get, installed, sandbox } from './support/relay-run.mts'

const skip = installed('codex') ? false : 'codex is not on PATH'

let fake: FakeModel
beforeEach(async () => {
  fake = await startFakeModel()
})
afterEach(async () => {
  await fake.close()
})

type Notification = { readonly method: string; readonly params?: { readonly threadId?: string; readonly item?: { readonly type: string } } }
type Answer = { readonly result?: unknown; readonly error?: { readonly message: string } }

function appServer(env: Record<string, string>, cwd: string) {
  const proc = spawn('codex', ['app-server'], { env: { PATH: process.env.PATH, ...env }, cwd })
  const pending = new Map<number, (answer: Answer) => void>()
  const notifications: Notification[] = []
  const heard = new EventEmitter()
  const exited = new Promise<number | null>((resolve) => proc.on('exit', resolve))
  let partial = ''
  let next = 1
  proc.stdout.on('data', (data: Buffer) => {
    partial += data
    const lines = partial.split('\n')
    partial = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      const message = JSON.parse(line) as Answer & Partial<Notification> & { readonly id?: number }
      const settle = message.id === undefined ? undefined : pending.get(message.id)
      if (settle && message.id !== undefined) {
        pending.delete(message.id)
        settle(message)
      } else if (message.method) {
        notifications.push(message as Notification)
        heard.emit('notification')
      }
    }
  })
  void exited.then((code) => {
    for (const [, settle] of pending) settle({ error: { message: `codex app-server exited with ${code}` } })
    pending.clear()
  })
  const request = (method: string, params: unknown) =>
    new Promise<Answer>((resolve) => {
      const id = next++
      const cancel = backstop(20_000, () => {
        pending.delete(id)
        resolve({ error: { message: `no answer to ${method}` } })
      })
      pending.set(id, (answer) => {
        cancel()
        resolve(answer)
      })
      proc.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
    })
  const until = (match: (n: Notification) => boolean) =>
    new Promise<Notification>((resolve, reject) => {
      const check = () => {
        const found = notifications.find(match)
        if (!found) return
        heard.off('notification', check)
        resolve(found)
      }
      heard.on('notification', check)
      void exited.then(() => {
        heard.off('notification', check)
        reject(new Error('codex app-server exited before the notification the test waited for'))
      })
      check()
    })
  return { proc, exited, request, notifications, until, notify: (method: string) => proc.stdin.write(`${JSON.stringify({ method })}\n`) }
}

const SPAWN = 'Reply with only the word KESTREL.'
const FOLLOWUP = 'Now reply with only the word OSPREY.'

test("a subagent's spawn and follow-up reach the client with no text: Codex doesn't send it (openai/codex#61750)", {
  skip,
  timeout: 60_000,
}, async () => {
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
      'multi_agent_v2 = true',
      '',
    ].join('\n'),
  )
  const PARENT = 'Delegate this.'
  const fromParent = (body: ModelRequest) =>
    (body.input ?? []).filter((item) => item.type === 'agent_message').map((item) => JSON.stringify(item))
  for (let i = 0; i < 20; i++)
    fake.enqueue((body) => {
      const received = fromParent(body)
      if (received.length > 0) return textResponse(received.at(-1)?.includes(FOLLOWUP) ? 'OSPREY' : 'KESTREL')
      const outputs = (body.input ?? []).filter((item) => item.type === 'function_call_output').length
      if (outputs === 0) return functionCallResponse('spawn', 'spawn_agent', { task_name: 'kestrel', message: SPAWN }, 'collaboration')
      if (outputs === 1) return functionCallResponse('followup', 'followup_task', { target: 'kestrel', message: FOLLOWUP }, 'collaboration')
      return textResponse('DONE')
    })
  const server = appServer({ HOME: b.home, CODEX_HOME: codexHome }, b.work)
  try {
    const ok = async (method: string, params: unknown) => {
      const answer = await server.request(method, params)
      assert.equal(answer.error, undefined, `${method}: ${answer.error?.message}`)
      return answer.result
    }
    await ok('initialize', { capabilities: { experimentalApi: true }, clientInfo: { name: 'via-test', version: '0' } })
    server.notify('initialized')
    const threadId = get(await ok('thread/start', { cwd: b.work }), 'thread', 'id')
    assert.equal(typeof threadId, 'string')
    await ok('turn/start', { threadId, input: [{ type: 'text', text: PARENT }] })
    await server.until((n) => n.method === 'turn/completed' && n.params?.threadId === threadId)

    const received = (made: readonly ModelRequest[]) => made.flatMap(fromParent).join()
    await fake.until((made) => received(made).includes(SPAWN) && received(made).includes(FOLLOWUP), server.exited)
    const items = server.notifications.filter((n) => n.method === 'item/completed').map((n) => n.params)
    const activity = items.filter((p) => p?.item?.type === 'subAgentActivity').map((p) => get(p, 'item', 'kind'))
    assert.equal(activity[0], 'started')
    assert.ok(activity.includes('interacted'), JSON.stringify(activity))
    const stream = JSON.stringify(server.notifications)
    assert.equal(stream.includes(SPAWN) || stream.includes(FOLLOWUP), false, 'Codex now sends the text: show it in the nested view')
    assert.equal(
      items.some((p) => p?.threadId !== threadId && p?.item?.type === 'userMessage'),
      false,
    )
  } finally {
    server.proc.kill()
  }
})
