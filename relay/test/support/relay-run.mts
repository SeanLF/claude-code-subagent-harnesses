import { spawn, spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, watch, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { SessionNotification, SessionUpdate } from '@agentclientprotocol/sdk/unstable'
import type { RelayKind, RelayLine, RelayLineOf } from '../../../hooks/acp/wire-relay.ts'
import { backstop } from './backstop.mts'

const relay = new URL('../../relay.mjs', import.meta.url).pathname

export type Printed = RelayLine | SessionNotification
export type ToolCallUpdate = Extract<SessionUpdate, { sessionUpdate: 'tool_call' | 'tool_call_update' }>

export const installed = (bin: string) => spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 20_000 }).status === 0

const sandboxes: string[] = []
process.on('exit', () => {
  for (const root of sandboxes) rmSync(root, { recursive: true, force: true, maxRetries: 10 })
})

export function sandbox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-real-')))
  sandboxes.push(root)
  const dirs = { root, home: join(root, 'home'), work: join(root, 'work'), inbox: join(root, 'inbox.jsonl') }
  mkdirSync(dirs.home)
  mkdirSync(dirs.work)
  writeFileSync(dirs.inbox, '')
  return dirs
}

export type RelayOptions = {
  readonly agent: readonly string[]
  readonly prompt: string
  readonly env: Readonly<Record<string, string>>
  readonly cwd: string
  readonly backstopMs?: number
}

export function startRelay({ agent, prompt, env, cwd, backstopMs = 30_000 }: RelayOptions) {
  const run = spawn('node', [relay, '--', ...agent], { cwd, env: { PATH: process.env.PATH, ...env } })
  const events: Printed[] = []
  let partial = ''
  let stderr = ''
  const printed = new EventEmitter()
  run.stdout.on('data', (data: Buffer) => {
    partial += data
    const lines = partial.split('\n')
    partial = lines.pop() ?? ''
    for (const line of lines) if (line.trim()) events.push(JSON.parse(line) as Printed)
    printed.emit('line')
  })
  run.stderr.on('data', (data: Buffer) => {
    stderr += data
  })
  run.stdin.end(prompt)
  let kill = () => {}
  const cancel = backstop(backstopMs, () => {
    stderr += `\nstopped after ${backstopMs} ms`
    run.kill('SIGTERM')
    kill = backstop(5_000, () => {
      stderr += '\nkilled: the stop did not end it'
      run.kill('SIGKILL')
    })
  })
  const exited = new Promise<number | null>((resolve) =>
    run.on('close', (code) => {
      cancel()
      kill()
      resolve(code)
    }),
  )
  const until = (match: (line: Printed) => boolean) =>
    new Promise<Printed>((resolve, reject) => {
      const check = () => {
        const found = events.find(match)
        if (!found) return
        printed.off('line', check)
        resolve(found)
      }
      printed.on('line', check)
      void exited.then(() => {
        printed.off('line', check)
        reject(new Error(`the relay ended before printing what the test waited for\n${stderr}`))
      })
      check()
    })
  return {
    events,
    get stderr() {
      return stderr
    },
    exited,
    until,
    stop: () => run.kill('SIGTERM'),
  }
}

export async function runRelay(options: RelayOptions) {
  const run = startRelay(options)
  const status = await run.exited
  return { status, events: run.events, stderr: run.stderr }
}

export const alive = (pid: number) => {
  const state = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim()
  return state !== '' && !state.startsWith('Z')
}

export const sleeping = (seconds: number, file: string) => `sleep ${seconds} & echo $! > ${file}.part && mv ${file}.part ${file}; wait`

export const created = (path: string, ended?: Promise<unknown>) =>
  new Promise<void>((resolve, reject) => {
    const watcher = watch(dirname(path), () => {
      if (!existsSync(path)) return
      watcher.close()
      resolve()
    })
    void ended?.then(() => {
      watcher.close()
      reject(new Error(`the run ended before ${path} was written`))
    })
    if (existsSync(path)) {
      watcher.close()
      resolve()
    }
  })

export const send = (inbox: string, value: unknown) => appendFileSync(inbox, `${JSON.stringify(value)}\n`)

const isRelay = (e: Printed): e is RelayLine => typeof (e as { relay?: unknown }).relay === 'string'

export const notifications = (events: readonly Printed[]): SessionNotification[] => events.flatMap((e) => (isRelay(e) ? [] : [e]))
export const updates = (events: readonly Printed[]): SessionUpdate[] => events.flatMap((e) => (isRelay(e) ? [] : [e.update]))
export const answer = (events: readonly Printed[]) =>
  updates(events)
    .flatMap((u) => (u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text' ? [u.content.text] : []))
    .join('')
export const spoken = (events: readonly Printed[]) => {
  const first = events.findIndex((e) => isRelay(e) && e.relay === 'steered')
  return { replayed: answer(events.slice(0, first)), answered: answer(events.slice(first)) }
}
export const relayEvent = <K extends RelayKind>(events: readonly Printed[], name: K): RelayLineOf<K> | undefined =>
  events.find((e): e is RelayLineOf<K> => isRelay(e) && e.relay === name)
export const relayEvents = (events: readonly Printed[]) => events.flatMap((e) => (isRelay(e) ? [e.relay] : []))
export const relayEventsNamed = <K extends RelayKind>(events: readonly Printed[], name: K) =>
  events.filter((e): e is RelayLineOf<K> => isRelay(e) && e.relay === name)
export const sessionOf = (events: readonly Printed[]) => String(relayEvent(events, 'session')?.sessionId)
export const toolCalls = (events: readonly Printed[]) =>
  updates(events).filter((u): u is ToolCallUpdate => u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update')

export function get(value: unknown, ...path: string[]): unknown {
  let at = value
  for (const key of path) at = typeof at === 'object' && at !== null ? (at as Record<string, unknown>)[key] : undefined
  return at
}
