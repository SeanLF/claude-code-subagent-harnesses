import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const server = new URL('../step.mts', import.meta.url).pathname

const answers = (...requests) => {
  const run = spawnSync('node', [server], {
    input: requests.map((r) => (typeof r === 'string' ? r : JSON.stringify({ jsonrpc: '2.0', ...r }))).join('\n'),
    encoding: 'utf8',
    timeout: 20_000,
  })
  assert.equal(run.status, 0, run.stderr)
  return run.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

test('a call that reaches the server is refused and runs nothing: only the tool.call hook answers one', () => {
  const [init, list, call] = answers(
    { id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { method: 'notifications/initialized' },
    { id: 2, method: 'tools/list' },
    { id: 3, method: 'tools/call', params: { name: 'step', arguments: { kind: 'execute', title: 'rm -rf /' } } },
  )
  assert.equal(init.result.protocolVersion, '2025-06-18')
  assert.deepEqual(
    list.result.tools.map((t) => t.name),
    ['step'],
  )
  assert.equal(call.result.isError, true)
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
  const plugin = JSON.parse(readFileSync(new URL('.claude-plugin/plugin.json', root), 'utf8'))
  const [server] = Object.keys(plugin.mcpServers)
  const hooks = readFileSync(new URL('hooks/register.ts', root), 'utf8')
  assert.match(hooks, new RegExp(`const STEP = 'mcp__plugin_${plugin.name}_${server}__step'`))
})
