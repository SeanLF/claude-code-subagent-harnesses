import type { EngineInterface, Register } from 'claude-code'
import { drawCall, drawGroup } from './acp/render'
import { answerCall, CHILD_CALL, endJob, SEND_CALL, STEP_CALL, waitStep } from './acp/steps'
import type { Adapter } from './adapter'
import { AGENTS_SPEC, agentsCall } from './agents'
import { waitChild, woken } from './children'
import { respond, textChunks } from './handback'
import { HARNESSES } from './harnesses'
import { cachedModels, refreshModels } from './models'
import { descriptionOf, isModel, promptOf } from './prompt'
import { createRecord, recordOf, updateRecord } from './record'
import { notActivePrompt } from './run'
import { answerQuestion, awayWait, sendMessage, showQuestions, steer, typed } from './steer'
import { adapterOf, turnStep } from './turn'
import type { World } from './world'

async function onPath($: Pick<EngineInterface, 'env' | 'fs'>, bin: string): Promise<boolean> {
  const path = (await $.env.get('PATH')) ?? ''
  const dirs = path.split(path.includes(';') ? ';' : ':').filter(Boolean)
  const found = await Promise.all(
    dirs.flatMap((dir) =>
      [bin, `${bin}.exe`].map((name) =>
        $.fs.stat(`${dir}/${name}`).then(
          (s) => s.kind === 'file',
          () => false,
        ),
      ),
    ),
  )
  return found.includes(true)
}

const SENT = 'The coordinator sent a message while you were working:\n'
const ADDRESS = '\n\nAddress this before completing your current task.'
function fromCoordinator(text: string): string | undefined {
  if (!text.startsWith(SENT) || !text.endsWith(ADDRESS)) return undefined
  return text.slice(SENT.length, -ADDRESS.length).trim()
}
const OPEN = '<teammate-message'
const CLOSE = '</teammate-message>'
export function unwrapped(text: string): string {
  const sent = fromCoordinator(text)
  if (sent !== undefined) return sent
  const inner: string[] = []
  let at = 0
  for (;;) {
    while (at < text.length && /\s/.test(text[at] as string)) at += 1
    if (at === text.length) break
    if (!text.startsWith(OPEN, at) || !/[\s>]/.test(text[at + OPEN.length] ?? '')) return text
    let quote = ''
    let end = at + OPEN.length
    for (; end < text.length; end += 1) {
      const c = text[end] as string
      if (quote) quote = c === quote ? '' : quote
      else if (c === '"' || c === "'") quote = c
      else if (c === '>') break
    }
    const close = text.indexOf(CLOSE, end + 1)
    if (end >= text.length || close < 0) return text
    inner.push(
      text
        .slice(end + 1, close)
        .replace(/^\r?\n/, '')
        .replace(/\r?\n$/, ''),
    )
    at = close + CLOSE.length
  }
  return inner.length > 0 ? inner.join('\n\n') : text
}

const STEP = 'mcp__plugin_via_step__step'
const AGENTS = 'mcp__via__agents'

const CLAUDE = /claude|opus|sonnet|haiku|fable/i
const KEPT = 4
const DROPPED = "Earlier steps of this run were dropped from Claude Code's copy; the harness still has them."

const RAISED = String(1e9)
async function sizeWindow($: Pick<EngineInterface, 'env'>, main: string): Promise<void> {
  const now = await $.env.get('CLAUDE_CODE_MAX_CONTEXT_TOKENS')
  if (now !== undefined && now !== RAISED) return
  if (CLAUDE.test(main)) {
    if (now === undefined) await $.env.set('CLAUDE_CODE_MAX_CONTEXT_TOKENS', RAISED)
  } else if (now === RAISED) await $.env.set('CLAUDE_CODE_MAX_CONTEXT_TOKENS', undefined)
}

function choiceOf(world: World, adapter: Adapter, prompt: string): { model?: string; thinking?: string } {
  const asked = promptOf(unwrapped(prompt), adapter)
  const fallback = adapter.defaultModel && isModel(world.defaultModel) ? world.defaultModel : undefined
  return { model: asked.model ?? fallback, thinking: asked.thinking }
}

const modeAsks = (v: { decision: string; rule?: string; hook?: string; setting?: string; plugin?: string }) =>
  v.decision === 'ask' && !v.rule && !v.hook && !v.setting && !v.plugin

function handsBack(e: { permissionMode?: string; isTeammate?: boolean; workflow?: unknown; fork?: boolean }): boolean {
  return e.permissionMode === 'auto' && !e.isTeammate && e.workflow === undefined && !e.fork
}

export const register: Register = (on, options) => {
  const asked = options.timeoutMinutes
  const world: World = {
    adapters: new Map<string, Adapter>(HARNESSES.map((adapter) => [adapter.name, adapter])),
    defaultModel: typeof options.defaultModel === 'string' ? options.defaultModel.trim() : '',
    latest: new Set(options.codexAcp === 'latest' ? ['codex'] : []),
    timeoutMinutes: typeof asked === 'number' && Number.isFinite(asked) && asked > 0 ? asked : 30,
    turns: new Map(),
    seeds: new Map(),
    records: new Map(),
    installs: new Map(),
    others: new Set(),
    inboxes: new Map(),
    channels: new Map(),
    nested: new Map(),
    parents: new Map(),
    spawns: new Map(),
    tool: STEP,
    jobs: new Map(),
    calls: new Map(),
    handed: new Map(),
    asking: new Map(),
    asked: 0,
    interactive: true,
    background: new Set(),
  }
  on('engine.create', async (_, e, next) => {
    const built = await next(e)
    return {
      ...built,
      viaSteps: {
        wait: ({ agentId, turnId }: { agentId: string; turnId: string }) =>
          waitStep(world, agentId, turnId, (wake) => built.clock.after(5_000, wake)),
      },
      viaChildren: {
        wait: ({ key }: { key: string }) => waitChild(world, key, (wake) => built.clock.after(5_000, wake)),
      },
      viaQuestions: {
        away: ({ id, ms }: { id: number; ms: number }) => awayWait(world, id, ms, (after, wake) => built.clock.after(after, wake)),
      },
    }
  })
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    world.interactive = e.isInteractive
    await $.session
      .model()
      .then((main) => sizeWindow($, main))
      .catch(() => undefined)
    await $.tool
      .register({ ...AGENTS_SPEC, isDeferred: true })
      .catch((error: unknown) => $.ui.log(`via could not add its agents tool: ${String(error)}`))
    for (const adapter of world.adapters.values()) {
      if (!(await onPath($, adapter.bin))) continue
      const models = await cachedModels($, adapter, world.defaultModel)
      void refreshModels($, adapter).catch(() => undefined)
      await $.agent.register({
        name: adapter.name,
        description: descriptionOf(adapter, models),
        prompt: notActivePrompt(adapter.name),
        tools: [world.tool, 'Agent', 'SendMessage'],
        model: adapter.name,
      })
    }
    return started
  })

  on('tool.check', { tool: 'Agent' }, async (_, e, next) => {
    const verdict = await next(e)
    const own = e.agentId !== undefined && world.records.has(e.agentId) && e.tool_use_id?.startsWith(CHILD_CALL)
    return own && modeAsks(verdict) ? { decision: 'allow', reason: "via's own call for its harness's subagent" } : verdict
  })
  on('tool.check', { tool: STEP as 'Bash' }, async (_, e, next) => {
    const verdict = await next(e)
    const own = e.tool_use_id?.startsWith(STEP_CALL) === true && (e.input as { kind?: unknown } | undefined)?.kind === 'question'
    return own && modeAsks(verdict) ? { decision: 'allow', reason: "via's own call, asking you the harness's question" } : verdict
  })
  on('tool.check', { tool: 'SendMessage' }, async (_, e, next) => {
    const verdict = await next(e)
    const own = e.agentId !== undefined && world.records.has(e.agentId) && e.tool_use_id?.startsWith(SEND_CALL) === true
    return own && modeAsks(verdict) ? { decision: 'allow', reason: "via's own call, handing its harness's question to you" } : verdict
  })

  on('session.append', async ($, e, next) => {
    const inbox = e.agentId === undefined ? undefined : world.inboxes.get(e.agentId)
    const theirs = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    if (inbox !== undefined && theirs && e.message.type === 'attachment' && e.message.name === 'queued_command') {
      const message = typed(e.message.content)
      if (message)
        await steer($, inbox, message).catch((err: unknown) => $.ui.log(`via could not pass your message to ${inbox.name}: ${String(err)}`))
    }
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const [plugin, name = ''] = (e.subagentType ?? '').split(':')
    const adapter = plugin === $.plugin.name ? world.adapters.get(name) : undefined
    const key = adapter && e.tool_use_id.startsWith(CHILD_CALL) ? world.spawns.get(e.tool_use_id) : undefined
    if (adapter && key !== undefined) {
      world.spawns.delete(e.tool_use_id)
      if (!e.background) {
        const channel = world.channels.get(key)
        if (channel) channel.read = true
        return { deny: "via shows a harness's subagent only as a background agent, and background tasks are off" }
      }
      const model = world.channels.get(key)?.model
      const started = await next({ ...e, model: model ?? adapter.name, ...(model ? { description: `${e.description} · ${model}` } : {}) })
      if (started.agentId) {
        world.nested.set(started.agentId, key)
        world.background.add(started.agentId)
        await createRecord(world, $, started.agentId, {
          harness: adapter.name,
          nested: true,
          handback: handsBack(e),
          mode: e.permissionMode ?? 'default',
          description: e.description,
        })
      }
      return started
    }
    const choice = adapter && !e.resume ? choiceOf(world, adapter, e.prompt) : undefined
    const shown = choice && !e.workflow ? [choice.model, choice.thinking].filter(Boolean).join(' · ') : ''
    const started = await next(
      adapter && choice
        ? { ...e, model: choice.model ?? adapter.name, ...(shown ? { description: `${e.description} · ${shown}` } : {}) }
        : e,
    )
    if (started.agentId && adapter) {
      world.seeds.set(started.agentId, e.prompt)
      if (e.background) world.background.add(started.agentId)
      else world.background.delete(started.agentId)
      const terms = { harness: adapter.name, handback: handsBack(e), mode: e.permissionMode ?? 'default' }
      const cwd = await $.session.cwd().catch(() => undefined)
      const kept = await recordOf(world, $, started.agentId)
      if (kept !== undefined && !kept.rebuilt)
        await updateRecord(world, $, started.agentId, { ...terms, description: e.description || kept.description, cwd: kept.cwd ?? cwd })
      else await createRecord(world, $, started.agentId, { ...terms, description: e.description, cwd })
    }
    return started
  })

  on('turn.start', async (_, e, next) => {
    if (e.agentId !== undefined) {
      const rest = woken(e.text, world.nested)
      if (rest === '') {
        world.turns.set(e.turnId, { prompt: '', wake: true })
        return next(e)
      }
      const prompt = unwrapped(rest ?? e.text) || world.seeds.get(e.agentId)
      world.seeds.delete(e.agentId)
      if (prompt) world.turns.set(e.turnId, { prompt })
    }
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    if (e.agentId === undefined || !(await adapterOf(world, $, e.agentId))) return next(e)
    if (e.trigger === 'precompute') return { skip: 'via compacts without a summary.' }
    const from = e.messages.findIndex((m, i) => i >= e.messages.length - KEPT && m.role === 'assistant')
    const note = { role: 'user' as const, text: DROPPED, toolUses: [] }
    return { messages: from === -1 ? [note] : [note, ...e.messages.slice(from)] }
  })

  on('classic.PostModelSwitch', async ($, e, next) => {
    const done = await next(e)
    await sizeWindow($, e.to_model).catch(() => undefined)
    return done
  })

  on('turn.complete', async (_, e, next) => {
    world.turns.delete(e.turnId)
    for (const [agentId, job] of world.jobs) if (job.turnId === e.turnId) endJob(world, agentId)
    return next(e)
  })

  if (HARNESSES.some((adapter) => adapter.steer))
    on('tool.call', { tool: 'SendMessage' }, async ($, e, next) => sendMessage(world, $, e, next))

  on('tool.call', { tool: STEP as 'Bash' }, ($, e, next) =>
    e.tool_use_id !== undefined && world.calls.get(e.tool_use_id)?.question
      ? answerQuestion($, world, e.tool_use_id, (e as { question?: unknown }).question, (question) => next({ ...e, question } as typeof e))
      : answerCall(world, e.tool_use_id, next.signal, (agentId, turnId) => $.viaSteps.wait({ agentId, turnId })),
  ).catch(() => ({
    deny: 'via could not report this harness tool call.',
  }))
  on('tool.call', { tool: AGENTS as 'Bash' }, ($, e) => agentsCall($, world, e as { action?: unknown; agent?: unknown }))
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e, next) => showQuestions(world, $, e, next))

  on('ui.render', { component: 'ToolUse' }, (_, e, next) => (e.props.tool === world.tool ? drawCall(e.props) : next(e)))
  const others = new Set<string>()
  on('ui.render', { component: 'ToolGroup' }, (_, e, next) => {
    const { calls, isCallsOnly, isExpanded } = e.props
    const ours = calls.length > 0 && calls.every((call) => call.tool === world.tool)
    const failed = calls.some((call) => call.isErrored || call.isInterrupted)
    const group = calls[0]?.tool_use_id
    if (ours && isCallsOnly === false && !failed && group !== undefined) others.add(group)
    const plain = isCallsOnly === true || (failed && !(group !== undefined && others.has(group)))
    return !isExpanded && ours && plain ? drawGroup(e.props) : next(e)
  })
  on('ui.render', { component: 'ToolResult' }, (_, e, next) => (e.props.tool === world.tool ? { type: 'Box', children: [] } : next(e)))

  on('turn.step', async function* ($, e, next) {
    return yield* turnStep(world, $, e, next)
  }).catch(async function* ($, e, next) {
    const agentId = e.agentId
    const record = agentId === undefined ? undefined : world.records.get(agentId)
    const adapter = record === undefined ? undefined : world.adapters.get(record.harness)
    if (agentId === undefined || !record || !adapter) return yield* next(e)
    const why = next.error.message ? `${next.error.kind}: ${next.error.message}` : next.error.kind
    $.ui.log(`via's step for ${adapter.name} failed (${why})`)
    endJob(world, agentId)
    const report = `The ${adapter.name}${record.nested ? ' subagent' : ''} failed: via could not render its next step.`
    if (record.nested && !record.report) await updateRecord(world, $, agentId, { report })
    return yield* respond(e, textChunks(report), report)
  })
}
