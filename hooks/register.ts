import type { EngineInterface, Register } from 'claude-code'
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
    dirs.flatMap((dir) => [bin, `${bin}.exe`].map((name) => $.fs.stat(`${dir}/${name}`).then((s) => s.kind === 'file', () => false))),
  )
  return found.includes(true)
}

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
  }
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    for (const adapter of world.adapters.values()) {
      if (!(await onPath($, adapter.bin))) continue
      await $.agent.register({
        name: adapter.name,
        description: descriptionOf(adapter),
        prompt: notActivePrompt(adapter.name),
        tools: [],
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

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) {
      const prompt = e.text || world.seeds.get(e.agentId)
      world.seeds.delete(e.agentId)
      if (prompt) world.turns.set(e.turnId, { prompt, delivered: false })
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    world.turns.delete(e.turnId)
    return next(e)
  })

  if (HARNESSES.some((adapter) => adapter.steer)) on('tool.call', { tool: 'SendMessage' }, async ($, e, next) => sendMessage(world, $, e, next))

  on('turn.step', async function* ($, e, next) {
    return yield* turnStep(world, $, e, next)
  })
}
