// What the live checks share: their command line, the environment they hand the agent, and a run's summary.
import { resolve } from 'node:path'
import { type Printed, relayEvent, sessionOf, updates } from '../test/support/relay-run.mts'

/** The arguments before `--` (at least `count` of them) and the agent command after it; exits with `usage` otherwise. */
export function args(usage: string, count: number) {
  const argv = process.argv.slice(2)
  const dash = argv.indexOf('--')
  if (dash < count || dash === argv.length - 1) {
    console.error(`Usage: ${usage}`)
    process.exit(2)
  }
  return { positional: argv.slice(0, dash), agent: argv.slice(dash + 1) }
}

/**
 * The workdir as the person meant it: a relative one against the folder they ran the command in. pnpm runs a
 * script from the package root and says where it was started in INIT_CWD, so `pnpm check:relay work` never lands
 * in the plugin's own folder, where the agent would run its commands.
 */
export const workdir = (path: string) => resolve(process.env.INIT_CWD ?? process.cwd(), path)

/** This process's environment, for the agent: unlike the tests, a live check runs on the person's own login and config. */
export const inherited = (): Record<string, string> =>
  Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined))

const quote = (text: string) => JSON.stringify(text.slice(-80))

/**
 * Prints a resumed session's replayed history, each prompt's message text (its last 80 characters) and how it
 * ended, the relay's model and errors, the last usage the agent reported, and the session.
 */
export function summary(events: readonly Printed[]) {
  let text = ''
  let prompted = false
  let usage = 'none'
  for (const e of events) {
    const said = relayEvent([e], 'model') ?? relayEvent([e], 'error')
    if (said) console.log(`  ${said.relay}: ${said.relay === 'model' ? said.name : said.message}`)
    // The relay says `steered` as each prompt goes out: what came before the first is replayed history.
    if (relayEvent([e], 'steered') && !prompted) {
      prompted = true
      if (text) console.log(`  replayed: ${quote(text)}`)
      text = ''
    }
    const done = relayEvent([e], 'prompt_done')
    if (done) {
      console.log(`  prompt: ${quote(text)} ${String(done.stopReason)} ${JSON.stringify(done.usage ?? null)}`)
      text = ''
    }
    for (const u of updates([e])) {
      if (u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text') text += u.content.text
      if (u.sessionUpdate === 'usage_update') usage = `${u.used}/${u.size}`
    }
  }
  console.log(`  usage: ${usage} session: ${relayEvent(events, 'session') ? sessionOf(events) : 'none'}`)
}
