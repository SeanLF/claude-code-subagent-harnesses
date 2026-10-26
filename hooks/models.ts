import type { EngineInterface } from 'claude-code'
import type { Adapter } from './adapter'
import { isModel } from './prompt'

// Each harness's own list, kept across sessions: a description names a model this person's harness
// offers, never one written into via that their account may not reach. Read at session start from the
// last refresh, since agy takes seconds to list and descriptions are fixed when the agent registers.
const key = (adapter: Pick<Adapter, 'name'>) => `models.${adapter.name}`

// defaultModel: the plugin's setting, which a run without a model line uses, so it leads.
export async function cachedModels(
  $: Pick<EngineInterface, 'store'>,
  adapter: Pick<Adapter, 'name' | 'defaultModel'>,
  defaultModel = '',
): Promise<string[]> {
  const stored = await $.store.get(key(adapter)).catch(() => undefined)
  const ids = Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : []
  const first = adapter.defaultModel && isModel(defaultModel) ? defaultModel : undefined
  return first ? [first, ...ids.filter((id) => id !== first)] : ids
}

// A failed or empty listing keeps the last good one. Run from the home folder: in the project, opencode
// would load the project's own plugins before any agent is asked for.
export async function refreshModels($: Pick<EngineInterface, 'store' | 'process' | 'env' | 'fs'>, adapter: Adapter): Promise<void> {
  const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))
  if (!home) return
  const listed = await $.process.run([...adapter.catalogue.argv], { cwd: home, timeoutMs: 30_000 }).catch(() => undefined)
  if (listed?.exitCode !== 0) return
  const { preferred } = adapter.catalogue
  const settings = preferred ? await $.fs.read(`${home}/${preferred.file}`).catch(() => undefined) : undefined
  const first = preferred && typeof settings === 'string' ? preferred.pick(settings) : undefined
  // The text rides on every request in the agent's description: model ids only.
  const ids = [...new Set([...(first ? [first] : []), ...adapter.catalogue.ids(listed.stdout)].filter(isModel))]
  if (ids.length > 0) await $.store.set(key(adapter), ids)
}
