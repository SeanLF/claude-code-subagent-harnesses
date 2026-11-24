// Live checks for an ACP agent behind relay/relay.mjs: stream, interrupt, resume, stop, refused model, steer.
// They spend tokens, so nothing runs them but a person.
// Usage: RELAY_STEER=steering|prompt node relay/checks/check.mts <workdir> <model> <bad-model> -- <agent command...>
//
// Each run's lines are kept in <workdir>/<check>.jsonl and its stderr in <check>.err. A check that needs a
// command running asks the agent to run one that writes its `sleep`'s pid once it runs, and waits on that file.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { RelayKind } from '../../hooks/acp/wire-relay.ts'
import { backstop } from '../test/support/backstop.mts'
import {
  alive,
  created,
  type Printed,
  type RelayOptions,
  relayEventsNamed,
  runRelay,
  send,
  sessionOf,
  sleeping,
  startRelay,
} from '../test/support/relay-run.mts'
import { args, inherited, summary, workdir } from './support.mts'

const { positional, agent } = args(
  'RELAY_STEER=steering|prompt node relay/checks/check.mts <workdir> <model> <bad-model> -- <agent command...>',
  3,
)
const [given, model, bad] = positional as [string, string, string]
const work = workdir(given)
mkdirSync(work, { recursive: true })
const inbox = resolve(work, 'inbox.jsonl')

// The checks are about the connection, not permissions: approve what the agent asks. A live turn can take
// minutes, so a run's backstop is long; it only ends a run that hangs.
const options = (prompt: string, env: Record<string, string> = {}): RelayOptions => ({
  agent,
  prompt,
  cwd: work,
  env: { ...inherited(), RELAY_POLICY: 'allow', RELAY_MODEL: model, ...env },
  backstopMs: 300_000,
})
const keep = (name: string, run: { events: readonly Printed[]; stderr: string }) => {
  writeFileSync(join(work, `${name}.jsonl`), run.events.map((e) => `${JSON.stringify(e)}\n`).join(''))
  writeFileSync(join(work, `${name}.err`), run.stderr)
}
const seconds = (since: number) => `${Math.round((Date.now() - since) / 1000)}s`

/** Starts a run whose prompt asks for `sleep <n>`, and resolves with the sleep's pid once it runs, or undefined. */
async function sleepingRun(n: number, then: string, env: Record<string, string> = {}) {
  const pidFile = resolve(work, `sleep-${n}.pid`)
  rmSync(pidFile, { force: true })
  const run = startRelay(options(`Use your bash tool to run exactly this command: ${sleeping(n, `sleep-${n}.pid`)}\n${then}`, env))
  const pid = await created(pidFile, run.exited).then(
    () => Number(readFileSync(pidFile, 'utf8')),
    () => undefined,
  )
  if (pid === undefined) console.log('  sleep never started')
  return { run, pid }
}
/** Says whether the sleep outlived its run, and ends it if so. */
const orphan = (pid: number | undefined) => {
  if (pid === undefined) return
  if (!alive(pid)) return console.log('  no orphan sleep')
  console.log(`  ORPHAN sleep ${pid}`)
  process.kill(pid, 'SIGKILL')
}

console.log('== 1 stream')
{
  const run = await runRelay(options('Reply with only the word PONG.'))
  keep('stream', run)
  console.log(`  exit ${run.status}`)
  summary(run.events)
}

let interrupted = ''
console.log('== 2 interrupt')
{
  writeFileSync(inbox, '')
  const start = Date.now()
  const { run, pid } = await sleepingRun(31, 'Then reply SLEPT.', { RELAY_INBOX: inbox })
  if (pid !== undefined) {
    send(inbox, { interrupt: 'Stop. Reply with only the word REDIRECTED.' })
    console.log(`  sent at ${seconds(start)}`)
  }
  const status = await run.exited
  keep('interrupt', run)
  console.log(`  exit ${status} after ${seconds(start)}`)
  summary(run.events)
  orphan(pid)
  interrupted = sessionOf(run.events)
}

console.log('== 3 resume')
{
  const run = await runRelay(
    options('Which single word did you reply with last? Reply with only that word.', { RELAY_SESSION: interrupted }),
  )
  keep('resume', run)
  console.log(`  exit ${run.status}`)
  summary(run.events)
}

console.log('== 4 stop')
{
  const { run, pid } = await sleepingRun(61, 'Then reply SLEPT.')
  run.stop()
  // A stopped relay ends at once; one still running after this long is reported, then killed by its backstop.
  let late = false
  const cancel = backstop(10_000, () => {
    late = true
    console.log('  relay ALIVE 10s after its stop')
  })
  const status = await run.exited
  cancel()
  keep('stop', run)
  if (!late) console.log(`  relay gone, exit ${status}`)
  console.log(
    `  prompt: ${
      relayEventsNamed(run.events, 'prompt_done')
        .map((e) => e.stopReason)
        .join(', ') || 'never ended'
    }`,
  )
  orphan(pid)
}

console.log('== 5 failure')
{
  const run = await runRelay(options('Reply with only the word PONG.', { RELAY_MODEL: bad }))
  keep('failure', run)
  console.log(`  exit ${run.status}`)
  summary(run.events)
  for (const line of run.stderr.trimEnd().split('\n').slice(-2)) console.log(`  stderr: ${line}`)
}

console.log('== 6 steer')
{
  writeFileSync(inbox, '')
  const { run, pid } = await sleepingRun(26, 'Then reply DONE.', { RELAY_INBOX: inbox })
  if (pid !== undefined) send(inbox, 'Change of plan: after the sleep, also run: echo STEERED. Then reply with its output and DONE.')
  const status = await run.exited
  keep('steer', run)
  console.log(`  exit ${status}`)
  summary(run.events)
  // One prompt whose answer has STEERED: the message reached the running prompt, not a second one.
  const count = (name: RelayKind) => relayEventsNamed(run.events, name).length
  console.log(`  prompts: ${count('prompt_done')}, steered: ${count('steered')}`)
  orphan(pid)
}
