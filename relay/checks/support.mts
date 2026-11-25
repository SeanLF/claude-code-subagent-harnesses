import { resolve } from 'node:path'
import { type Printed, relayEvent, sessionOf, updates } from '../test/support/relay-run.mts'

export function args(usage: string, count: number) {
  const argv = process.argv.slice(2)
  const dash = argv.indexOf('--')
  if (dash < count || dash === argv.length - 1) {
    console.error(`Usage: ${usage}`)
    process.exit(2)
  }
  return { positional: argv.slice(0, dash), agent: argv.slice(dash + 1) }
}

export const workdir = (path: string) => resolve(process.env.INIT_CWD ?? process.cwd(), path)

export const inherited = (): Record<string, string> =>
  Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined))

const quote = (text: string) => JSON.stringify(text.slice(-80))

export function summary(events: readonly Printed[]) {
  let text = ''
  let prompted = false
  let usage = 'none'
  for (const e of events) {
    const said = relayEvent([e], 'model') ?? relayEvent([e], 'error')
    if (said) console.log(`  ${said.relay}: ${said.relay === 'model' ? said.name : said.message}`)
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
