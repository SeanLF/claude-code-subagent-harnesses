import { expect, mock, test } from 'claude-code/testing'

import { arrange, lines, run, type Spawn, split } from '../helpers'

test('a prompt starting with @ reaches pi as the message, not as a file argument', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: '@README.md summarise this' })
  await run($)
  expect(spawns[0]?.argv.some((arg) => arg.startsWith('@'))).toBe(false)
  expect(spawns[0]?.env).toEqual({ PI_INBOX: '/home/u/.claude/via/inbox/pi-a1.jsonl' })
  expect(spawns[0]?.input).toBe('@README.md summarise this')
})

test('the session registers an agent type only for a harness on PATH', async ($, on) => {
  const seen: unknown[] = []
  mock.env(on, { PATH: '/usr/bin:/opt/pi/bin' })
  on('fs.stat', (_, e) => {
    if (e.path !== '/opt/pi/bin/pi') throw new Error('ENOENT')
    return { value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const tools: unknown[] = []
  on('agent.register', (_, e) => {
    seen.push(e.name)
    tools.push(...(e.tools ?? []))
    return { value: { agent: `pi:${e.name}` } }
  })
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  expect(seen).toEqual(['pi'])
  // Its agent can call the tool of via's step server, which reports the harness's tool calls.
  expect(tools).toEqual(['mcp__plugin_via_step__step'])
})

test('a read-only tool list ignores the project trust-gated .pi resources; a list with a writing tool keeps them', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'tools: read,grep,find,ls\ngo' })
  await run($)
  expect(spawns[0]?.argv.slice(-3)).toEqual(['--tools', 'read,grep,find,ls', '-na'])
  await $.turn.start({ turnId: 't2', agentId: 'a1', text: 'tools: read,bash\ngo' })
  await run($, { turnId: 't2', index: 0, model: 'haiku', messageCount: 2, agentId: 'a1' })
  expect(spawns[1]?.argv.slice(-2)).toEqual(['--tools', 'read,bash'])
})

test('pi needs a current Node too, for the step server, and says so instead of running', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines), 0, [], undefined, '20.19.0\n')
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const { result } = await run($)
  expect(spawns).toHaveLength(0)
  expect(result.answer).toContain('via needs Node 22.18 or later on PATH to run pi, not 20.19.0')
})
