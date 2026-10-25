import type { EngineInterface, Register } from 'claude-code'
import { drawCall, drawGroup } from './acp/render'
import { answerCall, endJob } from './acp/steps'
import type { Adapter } from './adapter'
import { HARNESSES } from './harnesses'
import { descriptionOf } from './prompt'
import { notActivePrompt } from './run'
import { sendMessage } from './steer'
import { turnStep } from './turn'
import type { World } from './world'

// Only harnesses installed at session start get an agent type: each description rides on every request.
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

// A teammate's messages arrive wrapped (<teammate-message teammate_id=… summary=…>task</teammate-message>):
// the harness gets the task alone, so its prompt lines (model:, tools:) are read from its top.
// Only a message that is nothing but envelopes is unwrapped. One linear pass: an attribute may hold a
// quoted >, and a message full of unclosed openers must not cost quadratic time.
const OPEN = '<teammate-message'
const CLOSE = '</teammate-message>'
export function unwrapped(text: string): string {
  const inner: string[] = []
  let at = 0
  for (;;) {
    while (at < text.length && /\s/.test(text[at] as string)) at += 1
    if (at === text.length) break
    if (!text.startsWith(OPEN, at) || !/[\s>]/.test(text[at + OPEN.length] ?? '')) return text
    // The opening tag ends at the first > outside quotes.
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

// The tool of the server plugin.json declares as `step`, named as Claude Code names a plugin's server.
const STEP = 'mcp__plugin_via_step__step'

export const register: Register = (on, options) => {
  const asked = options.timeoutMinutes
  const world: World = {
    adapters: new Map<string, Adapter>(HARNESSES.map((adapter) => [adapter.name, adapter])),
    defaultModel: typeof options.defaultModel === 'string' ? options.defaultModel.trim() : '',
    codexAcp: options.codexAcp === 'latest' ? 'latest' : 'pinned',
    timeoutMinutes: typeof asked === 'number' && Number.isFinite(asked) && asked > 0 ? asked : 30,
    turns: new Map(),
    seeds: new Map(),
    handbacks: new Map(),
    installs: new Map(),
    modes: new Map(),
    agents: new Map(),
    others: new Set(),
    inboxes: new Map(),
    descriptions: new Map(),
    activity: new Map(),
    tool: STEP,
    jobs: new Map(),
    calls: new Map(),
  }
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // Each harness tool call reaches Claude Code as a call to this tool, served by mcp/step.mts, which
    // runs nothing: its tool.call hook answers with what the harness reported. Bash would look the same,
    // but a hook that fails is skipped and the real command would run; a call nobody answers fails.
    for (const adapter of world.adapters.values()) {
      if (!(await onPath($, adapter.bin))) continue
      await $.agent.register({
        name: adapter.name,
        description: descriptionOf(adapter),
        prompt: notActivePrompt(adapter.name),
        tools: [world.tool],
        model: 'haiku',
      })
    }
    return started
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    const [plugin, name = ''] = (e.subagentType ?? '').split(':')
    const adapter = world.adapters.get(name)
    if (started.agentId && plugin === $.plugin.name && adapter) {
      // agent.list may lag the first step, so learn the harness at the spawn.
      world.agents.set(started.agentId, adapter)
      world.seeds.set(started.agentId, e.prompt)
      world.descriptions.set(started.agentId, e.description)
      // What the person allows Claude itself; a harness maps it to its own modes. In memory before any
      // await, so a first step that runs before the state writes still sees it.
      world.modes.set(started.agentId, e.permissionMode ?? 'default')
      // The engine's handback reminder is not in session.messages, so remember the spawn's terms.
      // A remote spawn has no field here (isolation is on AgentSpec, not AgentSpawnInput), and
      // background cannot tell it from any other background spawn.
      const local = !e.isTeammate && e.workflow === undefined && !e.fork
      const handback = e.permissionMode === 'auto' && local
      // Persisted: a reload loses this map but must not lose the decision.
      world.handbacks.set(started.agentId, handback)
      await $.state.set({ plugin: 'via', key: 'handbacks', id: started.agentId }, handback)
      await $.state.set({ plugin: 'via', key: 'modes', id: started.agentId }, e.permissionMode ?? 'default')
    }
    return started
  })

  on('turn.start', async (_, e, next) => {
    if (e.agentId !== undefined) {
      const prompt = unwrapped(e.text) || world.seeds.get(e.agentId)
      world.seeds.delete(e.agentId)
      if (prompt) world.turns.set(e.turnId, { prompt, delivered: false })
    }
    return next(e)
  })

  on('turn.complete', async (_, e, next) => {
    world.turns.delete(e.turnId)
    for (const [agentId, job] of world.jobs) if (job.turnId === e.turnId) endJob(world, agentId)
    return next(e)
  })

  if (HARNESSES.some((adapter) => adapter.steer))
    on('tool.call', { tool: 'SendMessage' }, async ($, e, next) => sendMessage(world, $, e, next))

  // The matcher's type names only built-in tools; an MCP tool's full name is accepted at run time.
  on('tool.call', { tool: STEP as 'Bash' }, (_, e, next) => answerCall(world, e.tool_use_id, next.signal)).catch(() => ({
    deny: 'via could not report this harness tool call.',
  }))

  on('ui.render', { component: 'ToolUse' }, (_, e, next) => (e.props.tool === world.tool ? drawCall(e.props) : next(e)))
  // Claude Code decides which calls fold; via only counts them, and only a run of its own calls alone.
  on('ui.render', { component: 'ToolGroup' }, (_, e, next) =>
    !e.props.isExpanded && e.props.isCallsOnly === true && e.props.calls.every((call) => call.tool === world.tool)
      ? drawGroup(e.props)
      : next(e),
  )
  // The row shows the output already, all of it when expanded.
  on('ui.render', { component: 'ToolResult' }, (_, e, next) => (e.props.tool === world.tool ? { type: 'Box', children: [] } : next(e)))

  on('turn.step', async function* ($, e, next) {
    return yield* turnStep(world, $, e, next)
  })
}
