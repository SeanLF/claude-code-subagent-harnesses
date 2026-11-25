import type { TurnStepChunk, TurnUsage } from 'claude-code'
import type { Choice } from '../types'
import type { Adapter, Usage } from './adapter'
import type { Inbox } from './steer'
import { undeliveredNotice } from './steer'
import { answeredBy, type StepWriter } from './writer'

export type Totals = { -readonly [K in keyof Usage]: Usage[K] }
export type Finished = { signed: string; usage: TurnUsage | null; chunks: TurnStepChunk[] }

export function finish(args: {
  readonly adapter: Adapter
  readonly choice: Choice
  readonly notices: readonly string[]
  readonly stopped: 'limit' | undefined
  readonly timeoutMinutes: number
  readonly report: string
  readonly answeredBy: string
  readonly failure: string
  readonly steered: number
  readonly inbox: Inbox | undefined
  readonly total: Totals
  readonly writer: StepWriter
}): Finished {
  const name = args.adapter.name
  const chunks: TurnStepChunk[] = []
  let report = args.report
  const say = (t: string) => chunks.push(args.writer.say(t))
  if (!args.writer.spoke && report.trim()) say(report.trim())
  if (args.stopped === 'limit') {
    const partial = report.trim()
    const notice = `${name} ran past ${args.timeoutMinutes} minutes and was stopped.`
    report = partial ? `${partial}\n\n${notice}` : notice
    say(partial ? `\n\n${notice}` : notice)
  }
  if (args.notices.length > 0) {
    const partial = report.trim()
    const said = args.notices.join('\n')
    report = partial ? `${partial}\n\n${said}` : said
    say(partial ? `\n\n${said}` : said)
  }
  if (args.failure) {
    const partial = report.trim()
    report = partial ? `${partial}\n\n${args.failure}` : args.failure
    say(partial ? `\n\n${args.failure}` : `\n${args.failure}`)
  }
  const undelivered = undeliveredNotice(args.inbox, args.steered, name)
  if (undelivered) {
    const partial = report.trim()
    report = partial ? `${partial}\n\n${undelivered}` : undelivered
    say(`\n\n${undelivered}`)
  }
  const requested = !args.failure && !args.answeredBy ? args.adapter.model(args.choice) : undefined
  const named = args.failure ? '' : args.answeredBy || requested || ''
  const usage: TurnUsage | null = named
    ? {
        model: named,
        input_tokens: args.total.input,
        output_tokens: args.total.output,
        cache_read_input_tokens: args.total.cacheRead,
        cache_creation_input_tokens: args.total.cacheWrite,
      }
    : null
  const answer = report.trim()
  const signedBy = args.stopped === undefined && !args.failure
  const by = named === '' ? 'model not reported' : requested === named ? `${named} (requested)` : named
  const line = `\n\n${answeredBy(name, by)}`
  const signed = signedBy ? `${answer}${line}` : answer
  if (signedBy) say(line)
  return { signed, usage, chunks }
}
