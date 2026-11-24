// Runs the real relay (relay/relay.mjs) over a real harness, as via does, and reads what it printed.

import { spawn, spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, watch, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { SessionNotification, SessionUpdate } from '@agentclientprotocol/sdk/unstable'
import type { RelayKind, RelayLine, RelayLineOf } from '../../../hooks/acp/wire-relay.ts'
import { backstop } from './backstop.mts'

const relay = new URL('../../relay.mjs', import.meta.url).pathname

/** A line the relay printed: one of its own (hooks/acp/wire-relay.ts), or an ACP session update it forwarded. */
export type Printed = RelayLine | SessionNotification
export type ToolCallUpdate = Extract<SessionUpdate, { sessionUpdate: 'tool_call' | 'tool_call_update' }>

/** Whether `bin` runs from PATH: a test of a harness that isn't installed is skipped, not failed. */
export const installed = (bin: string) => spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 20_000 }).status === 0

// Every sandbox goes when the test process does, through one listener. codex-acp exits before the `codex
// app-server` it started, which goes on writing its home for a moment: removal retries (ENOTEMPTY), as
// rmSync offers for this. Cleanup only: no test waits on it.
const sandboxes: string[] = []
process.on('exit', () => {
  for (const root of sandboxes) rmSync(root, { recursive: true, force: true, maxRetries: 10 })
})

/**
 * A fresh home for one test: an empty HOME (so no login, config or auth of the person's is read), a working
 * folder, and an inbox file. Real paths: macOS's temp folder is a symlink, and the harness reports real ones.
 */
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

/**
 * Starts the relay over `agent` with `prompt` on stdin. Only PATH comes from this process's environment: no
 * provider key or config of the person's reaches the harness. `events` grows as the relay prints.
 */
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
  // A run the harness never ends is stopped as the engine stops one, so a hang fails the test, not the suite;
  // killed if its stop hangs too.
  let kill = () => {}
  const cancel = backstop(backstopMs, () => {
    stderr += `\nstopped after ${backstopMs} ms`
    run.kill('SIGTERM')
    kill = backstop(5_000, () => {
      stderr += '\nkilled: the stop did not end it'
      run.kill('SIGKILL')
    })
  })
  // close, not exit: every line printed has been read.
  const exited = new Promise<number | null>((resolve) =>
    run.on('close', (code) => {
      cancel()
      kill()
      resolve(code)
    }),
  )
  /** Resolves once the relay has printed a line `match` picks; rejects if the relay ends first. */
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
    /** Stops the run as the engine does. */
    stop: () => run.kill('SIGTERM'),
  }
}

/** Runs the relay to its end. */
export async function runRelay(options: RelayOptions) {
  const run = startRelay(options)
  const status = await run.exited
  return { status, events: run.events, stderr: run.stderr }
}

/** Whether process `pid` runs now: not gone, and not a zombie waiting to be reaped. */
export const alive = (pid: number) => {
  const state = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim()
  return state !== '' && !state.startsWith('Z')
}

/**
 * A shell command that runs `sleep seconds` and, once it runs, writes its pid to `file` in one step: under another
 * name, then renamed, so the file never exists empty.
 */
export const sleeping = (seconds: number, file: string) => `sleep ${seconds} & echo $! > ${file}.part && mv ${file}.part ${file}; wait`

/**
 * Resolves once `path` exists, on the file system's own event, never on time: a command under test writes it to
 * say it has started. Rejects when `ended` settles first, such as the run's exit.
 */
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

/** Appends one line to the relay's inbox, as the plugin does. */
export const send = (inbox: string, value: unknown) => appendFileSync(inbox, `${JSON.stringify(value)}\n`)

// ---- What the relay printed ----

const isRelay = (e: Printed): e is RelayLine => typeof (e as { relay?: unknown }).relay === 'string'

export const notifications = (events: readonly Printed[]): SessionNotification[] => events.flatMap((e) => (isRelay(e) ? [] : [e]))
export const updates = (events: readonly Printed[]): SessionUpdate[] => events.flatMap((e) => (isRelay(e) ? [] : [e.update]))
export const answer = (events: readonly Printed[]) =>
  updates(events)
    .flatMap((u) => (u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text' ? [u.content.text] : []))
    .join('')
/** A resumed session's replayed history, before the relay's first prompt, and the answer after it. */
export const spoken = (events: readonly Printed[]) => {
  const first = events.findIndex((e) => isRelay(e) && e.relay === 'steered')
  return { replayed: answer(events.slice(0, first)), answered: answer(events.slice(first)) }
}
export const relayEvent = <K extends RelayKind>(events: readonly Printed[], name: K): RelayLineOf<K> | undefined =>
  events.find((e): e is RelayLineOf<K> => isRelay(e) && e.relay === name)
export const relayEvents = (events: readonly Printed[]) => events.flatMap((e) => (isRelay(e) ? [e.relay] : []))
/** Every relay line called `name`, in order. */
export const relayEventsNamed = <K extends RelayKind>(events: readonly Printed[], name: K) =>
  events.filter((e): e is RelayLineOf<K> => isRelay(e) && e.relay === name)
/** The session the run opened or resumed. */
export const sessionOf = (events: readonly Printed[]) => String(relayEvent(events, 'session')?.sessionId)
export const toolCalls = (events: readonly Printed[]) =>
  updates(events).filter((u): u is ToolCallUpdate => u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update')

/** The value at `path` inside `value`, for fields ACP leaves open (`rawInput`, `rawOutput`, `_meta`). */
export function get(value: unknown, ...path: string[]): unknown {
  let at = value
  for (const key of path) at = typeof at === 'object' && at !== null ? (at as Record<string, unknown>)[key] : undefined
  return at
}
