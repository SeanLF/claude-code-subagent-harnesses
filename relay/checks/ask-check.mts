import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { answer, type Printed, relayEvent, send, startRelay, toolCalls } from '../test/support/relay-run.mts'
import { args, inherited, workdir } from './support.mts'

const usage = 'node relay/checks/ask-check.mts <workdir> <agent mode> <allow|deny> <prompt> -- <agent command...>'
const { positional, agent } = args(usage, 4)
const [given, mode, choice, prompt] = positional as [string, string, string, string]
const work = workdir(given)
if (choice !== 'allow' && choice !== 'deny') {
  console.error(`Usage: ${usage}`)
  process.exit(2)
}
mkdirSync(work, { recursive: true })
const inbox = resolve(work, 'inbox.jsonl')
writeFileSync(inbox, '')

const want = choice === 'allow' ? 'allow_once' : 'reject_once'
const start = Date.now()
const run = startRelay({
  agent,
  prompt,
  cwd: work,
  env: { ...inherited(), RELAY_INBOX: inbox, RELAY_POLICY: 'ask', RELAY_AGENT_MODE: mode },
  backstopMs: 300_000,
})

const answered = new Set<string>()
const asked = (line: Printed) => {
  const ask = relayEvent([line], 'ask')
  return ask !== undefined && !answered.has(ask.id)
}
for (;;) {
  const line = await run.until(asked).catch(() => undefined)
  const ask = line && relayEvent([line], 'ask')
  if (!ask) break
  answered.add(ask.id)
  const option = ask.options.find((o) => o.kind === want)?.optionId ?? null
  const command = ask.command === undefined ? '' : ` command=${JSON.stringify(ask.command)}`
  console.log(
    `ask ${ask.id}: ${ask.kind} ${JSON.stringify(ask.title)}${command} options=${ask.options.map((o) => o.kind).join(',')} -> ${want}`,
  )
  send(inbox, { answer: ask.id, optionId: option })
}
const status = await run.exited

for (const e of run.events) {
  const r = relayEvent([e], 'model') ?? relayEvent([e], 'error')
  if (r) console.log(`${r.relay}: ${r.relay === 'model' ? r.name : r.message}`)
}
const titles = new Map<string, string>()
for (const u of toolCalls(run.events)) {
  if (u.title) titles.set(u.toolCallId, u.title)
  if (u.sessionUpdate === 'tool_call_update' && (u.status === 'completed' || u.status === 'failed'))
    console.log(`tool ${u.status} ${JSON.stringify(titles.get(u.toolCallId) ?? null)}`)
}
const done = relayEvent(run.events, 'prompt_done')
console.log(`done: ${String(done?.stopReason)}`)
console.log(
  `answer: ${JSON.stringify(answer(run.events).trim().slice(-200))} (exit ${status}, ${Math.round((Date.now() - start) / 1000)}s)`,
)
