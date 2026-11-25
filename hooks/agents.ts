import type { EngineInterface } from 'claude-code'
import type { Adapter } from './adapter'
import { relayReady } from './install'
import { type AgentRecord, forgetRecord, freshRecord, listRecords } from './record'
import type { World } from './world'

type Engine = Pick<EngineInterface, 'store' | 'ui' | 'process' | 'env' | 'fs' | 'plugin' | 'clock'>

export const AGENTS_TOOL = 'agents'

export const AGENTS_SPEC = {
  name: AGENTS_TOOL,
  description: [
    "via's recent agents (Codex, OpenCode, agy and pi runs from Agent calls with a via: type), newest first.",
    "- list: each agent: harness, title, whether it is running (here or in another Claude Code session), and the shell command that opens its session in the harness's own UI (or why it cannot be opened now).",
    '- open (agent): that command alone. Run it in a terminal pane for the person to watch or take over; via opens nothing.',
    "- forget (agent): deletes the agent's harness session and via's record of it, once the person says yes in a dialog. The agent can no longer be resumed.",
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'open', 'forget'] },
      agent: { type: 'string', description: 'The agent id from list (open and forget).' },
    },
    required: ['action'],
    additionalProperties: false,
  },
}

const quote = (word: string) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`)

const sessionOf = (adapter: Adapter, agentId: string, record: AgentRecord) => record.session || adapter.sessionOf?.(agentId)

async function running($: Engine, w: World, agentId: string, record: AgentRecord): Promise<boolean> {
  if (w.jobs.has(agentId)) return true
  return record.runningUntil !== undefined && (await $.clock.now()) < record.runningUntil
}

type Opening = { command: string; note?: string } | { why: string }

type Services = Map<string, Promise<boolean>>

async function opening($: Engine, w: World, agentId: string, record: AgentRecord, services: Services = new Map()): Promise<Opening> {
  const adapter = w.adapters.get(record.harness)
  if (adapter === undefined) return { why: `via no longer drives ${record.harness}.` }
  if (record.nested) return { why: `a subagent of a ${adapter.name} run: open its parent instead.` }
  const session = sessionOf(adapter, agentId, record)
  if (!session) return { why: `it has no ${adapter.name} session yet.` }
  const reopen = adapter.reopen
  if (reopen === undefined) return { why: `${adapter.name} has no way to open a session in its own UI.` }
  if (!reopen.midRun && (await running($, w, agentId, record)))
    return { why: `it is running: open it once its run ends, as a second ${adapter.name} on a session that is being written is unsafe.` }
  const service = reopen.service
  if (service) {
    if (!services.has(adapter.name))
      services.set(
        adapter.name,
        (async () => {
          const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))
          const status = await $.process
            .run([...service.argv], { ...(home ? { cwd: home } : {}), timeoutMs: 15_000 })
            .catch(() => undefined)
          return status !== undefined && status.exitCode === 0 && service.running(status.stdout)
        })(),
      )
    if (!(await services.get(adapter.name))) return { why: service.why }
  }
  const argv = reopen.argv(session).map(quote).join(' ')
  return {
    command: record.cwd ? `cd ${quote(record.cwd)} && ${argv}` : argv,
    ...(reopen.note || !record.cwd
      ? {
          note: [reopen.note, record.cwd ? '' : 'Run it in the folder the agent worked in: via did not record it.']
            .filter(Boolean)
            .join(' '),
        }
      : {}),
  }
}

async function list($: Engine, w: World): Promise<string> {
  const agents = []
  const services: Services = new Map()
  for (const [agentId, record] of await listRecords(w, $)) {
    if (record.nested) continue
    const open = await opening($, w, agentId, record, services)
    agents.push({
      agent: agentId,
      harness: record.harness,
      title: record.description ?? '',
      running: await running($, w, agentId, record),
      ...open,
    })
  }
  return agents.length === 0 ? 'via has no agents on record.' : JSON.stringify(agents, null, 1)
}

type Outcome = { result: string; isError?: true }
const failed = (result: string): Outcome => ({ result, isError: true })

async function forget($: Engine, w: World, agentId: string, record: AgentRecord): Promise<Outcome> {
  const adapter = w.adapters.get(record.harness)
  if (adapter === undefined) return failed(`via no longer drives ${record.harness}, so it cannot delete this agent's session.`)
  if (record.nested) return failed(`${agentId} is a subagent of a ${adapter.name} run: its session is part of its parent's.`)
  const busy = `${agentId} is running: stop it, or wait for its answer, before forgetting it.`
  if (await running($, w, agentId, record)) return failed(busy)
  const session = sessionOf(adapter, agentId, record)
  if (session && adapter.forget === undefined)
    return failed(
      `${adapter.name} offers via no way to delete its sessions, so via keeps this agent: its session stays in ${adapter.name}'s history.`,
    )
  const title = record.description ? `"${record.description}" ` : ''
  const what = session
    ? `its ${adapter.name} session (${session}) and via's record of it`
    : "via's record of it (it has no harness session)"
  const question = `Forget the ${adapter.name} agent ${title}(${agentId})? This deletes ${what}, so it can't be resumed.`
  const FORGET = 'Forget it'
  const answer = await $.ui.ask(question, { header: 'via', options: [FORGET, 'Keep it'] }).catch(() => undefined)
  if (answer === undefined) return failed(`Not forgotten: nobody answered the question (a -p run, or the dialog was dismissed).`)
  if (answer !== FORGET) return { result: `Not forgotten: the person chose "${answer}".` }
  const now = await freshRecord(w, $, agentId)
  if (now === undefined) return { result: `${agentId} was already forgotten.` }
  if (await running($, w, agentId, now)) return failed(busy)
  if (sessionOf(adapter, agentId, now) !== session)
    return failed(`Not forgotten: ${agentId}'s session changed while you were asked. Ask again.`)
  let how = 'deleted'
  if (session && adapter.forget) {
    const ready = adapter.relay ? await relayReady(w, $, adapter, w.latest.has(adapter.name)) : {}
    if (typeof ready === 'string') return failed(`Not forgotten: ${ready}`)
    const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))
    const request = adapter.forget.request({ root: $.plugin.root, session, installed: ready.installed })
    const ran = await $.process
      .run([...request.argv], { env: request.env, stdin: '', ...(home ? { cwd: home } : {}), timeoutMs: 60_000 })
      .catch((error: unknown) => ({ exitCode: -1, stdout: '', stderr: String(error) }))
    const said = ran.stdout
      .split('\n')
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as { relay?: unknown; how?: unknown; message?: unknown }]
        } catch {
          return []
        }
      })
      .filter((line) => typeof line.relay === 'string')
    const done = said.find((line) => line.relay === 'forgotten')
    if (ran.exitCode !== 0 || done === undefined) {
      const why = said.find((line) => line.relay === 'error')?.message ?? (ran.stderr.trim().split('\n').pop() || `exit ${ran.exitCode}`)
      return failed(`Not forgotten: ${adapter.name} did not delete session ${session}: ${String(why)}. via kept its record.`)
    }
    how = done.how === 'archived' ? 'archived' : done.how === 'gone' ? 'already gone from' : 'deleted'
  }
  const kept = await forgetRecord(w, $, agentId).then(
    () => undefined,
    (error: unknown) => String(error),
  )
  const harness = session
    ? `${adapter.name} ${how === 'already gone from' ? `session ${session} was already gone` : `session ${session} ${how}`}${adapter.forget?.note ? ` (${adapter.forget.note.replace('<session>', session)})` : ''}`
    : 'it had no harness session'
  if (kept !== undefined) return failed(`Forgot ${agentId} only in part: ${harness}, but via could not remove its record (${kept}).`)
  return { result: `Forgot ${agentId}: ${harness}, and via's record removed.` }
}

export async function agentsCall($: Engine, w: World, input: { action?: unknown; agent?: unknown }): Promise<Outcome> {
  if (input.action === 'list') return { result: await list($, w) }
  if (input.action !== 'open' && input.action !== 'forget') return failed('action must be list, open or forget.')
  const agentId = typeof input.agent === 'string' ? input.agent.trim() : ''
  if (!agentId) return failed(`${input.action} needs an agent: an id from list.`)
  const record = await freshRecord(w, $, agentId)
  if (record === undefined || record.rebuilt) return failed(`via has no record of agent ${agentId}: list shows the ones it has.`)
  if (input.action === 'forget') return forget($, w, agentId, record)
  const open = await opening($, w, agentId, record)
  if ('why' in open) return failed(`${agentId} can't be opened now: ${open.why}`)
  return { result: open.note ? `${open.command}\n\n${open.note}` : open.command }
}
