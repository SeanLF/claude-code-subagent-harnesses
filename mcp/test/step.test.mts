import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { test } from 'node:test'

const server = new URL('../step.mts', import.meta.url).pathname

type Answer = {
  readonly id?: number
  readonly result?: { readonly protocolVersion?: string; readonly tools?: readonly { readonly name: string }[]; readonly isError?: boolean }
  readonly error?: { readonly code: number }
}

const answers = (...requests: (string | Record<string, unknown>)[]): Answer[] => {
  const run = spawnSync('node', [server], {
    input: requests.map((r) => (typeof r === 'string' ? r : JSON.stringify({ jsonrpc: '2.0', ...r }))).join('\n'),
    encoding: 'utf8',
    timeout: 20_000,
  })
  assert.equal(run.status, 0, run.stderr)
  return run.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Answer)
}

test('a call that reaches the server is refused and runs nothing: only the tool.call hook answers one', () => {
  const [init, list, call] = answers(
    { id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { method: 'notifications/initialized' },
    { id: 2, method: 'tools/list' },
    { id: 3, method: 'tools/call', params: { name: 'step', arguments: { kind: 'execute', title: 'rm -rf /' } } },
  )
  assert.equal(init?.result?.protocolVersion, '2025-06-18')
  assert.deepEqual(
    list?.result?.tools?.map((t) => t.name),
    ['step'],
  )
  assert.equal(call?.result?.isError, true)
})

test('an unknown method, one every object inherits included, is an error and the server keeps answering', () => {
  const said = answers('not json', { id: 1, method: 'hasOwnProperty' }, { id: 2, method: 'constructor' }, { id: 3, method: 'ping' })
  assert.deepEqual(
    said.map((a) => a.error?.code ?? 'ok'),
    [-32601, -32601, 'ok'],
  )
})

test("the hooks answer the tool Claude Code names after plugin.json's server", () => {
  const root = new URL('../../', import.meta.url)
  const plugin = JSON.parse(readFileSync(new URL('.claude-plugin/plugin.json', root), 'utf8')) as {
    name: string
    mcpServers: Record<string, unknown>
  }
  const [server] = Object.keys(plugin.mcpServers)
  const hooks = readFileSync(new URL('hooks/register.ts', root), 'utf8')
  assert.match(hooks, new RegExp(`const STEP = 'mcp__plugin_${plugin.name}_${server}__step'`))
})

const session = (elicitation?: Record<string, object>) => {
  const child = spawn('node', [server], { stdio: ['pipe', 'pipe', 'inherit'], timeout: 20_000 })
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  const write = (message: Record<string, unknown>) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  const read = async () => {
    const line = await lines.next()
    assert.equal(line.done, false, 'the server ended')
    return JSON.parse(line.value) as { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown }
  }
  write({ id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: elicitation ? { elicitation } : {} } })
  return { write, read, end: () => child.stdin.end() }
}

const FORM = {
  mode: 'form',
  message: 'Which target?',
  requestedSchema: { type: 'object', properties: { target: { type: 'string', enum: ['staging', 'production'] } } },
}
const LINK = { mode: 'url', message: 'Sign in to continue.', url: 'https://example.com/login', elicitationId: 'e1' }
const replyIn = (result: unknown) => JSON.parse((result as { content: { text: string }[] }).content[0]?.text ?? '') as unknown

const asked = async (
  elicitation: Record<string, object> | undefined,
  question: object,
  reply: (request: { id?: number | string }) => object,
) => {
  const s = session(elicitation)
  await s.read()
  s.write({ id: 1, method: 'tools/call', params: { name: 'step', arguments: { kind: 'question', title: 'q', question } } })
  const first = await s.read()
  if (first.id === 1) {
    s.end()
    return { request: undefined, result: replyIn(first.result) }
  }
  s.write({ id: first.id, ...reply(first) })
  const answered = await s.read()
  s.end()
  assert.equal(answered.id, 1)
  return { request: first, result: replyIn(answered.result) }
}

test("a question call is asked as MCP's form elicitation, and the person's reply is the call's result", async () => {
  const { request, result } = await asked({ form: {}, url: {} }, FORM, () => ({
    result: { action: 'accept', content: { target: 'staging' } },
  }))
  assert.deepEqual(
    { method: request?.method, params: request?.params },
    {
      method: 'elicitation/create',
      params: { message: FORM.message, requestedSchema: FORM.requestedSchema },
    },
  )
  assert.deepEqual(result, { action: 'accept', content: { target: 'staging' } })
})

test('a link question is asked as a URL elicitation; a decline comes back as a decline', async () => {
  const { request, result } = await asked({ form: {}, url: {} }, LINK, () => ({ result: { action: 'decline' } }))
  assert.deepEqual(request?.params, LINK)
  assert.deepEqual(result, { action: 'decline' })
})

test("what the client can't show is cancelled without asking: no elicitation, or no links", async () => {
  assert.deepEqual(await asked(undefined, FORM, () => ({})), { request: undefined, result: { action: 'cancel' } })
  assert.deepEqual(await asked({ form: {} }, LINK, () => ({})), { request: undefined, result: { action: 'cancel' } })
})

test('a client offering elicitation with no modes named shows forms, as MCP had it first', async () => {
  const { request } = await asked({}, FORM, () => ({ result: { action: 'cancel' } }))
  assert.equal(request?.method, 'elicitation/create')
})

test('a client that fails the elicitation gets a cancel back', async () => {
  const { result } = await asked({ form: {} }, FORM, () => ({ error: { code: -32603, message: 'no' } }))
  assert.deepEqual(result, { action: 'cancel' })
})
