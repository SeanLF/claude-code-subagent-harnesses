import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')

test("codex-acp's install folder names the version its lock installs", () => {
  const lock = JSON.parse(read('relay/codex-acp/package-lock.json')) as { packages: Record<string, { version?: string }> }
  const locked = lock.packages['node_modules/@agentclientprotocol/codex-acp']?.version
  assert.ok(locked, 'the lock installs no codex-acp')
  const dir = read('hooks/adapters/codex.ts').match(/dir: '([^']+)'/)?.[1]
  assert.equal(dir, `codex-acp-${locked}`)
})
