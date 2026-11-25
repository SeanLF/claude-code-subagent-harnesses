import type { EngineInterface } from 'claude-code'
import type { Adapter } from './adapter'
import { isModel } from './prompt'

const key = (adapter: Pick<Adapter, 'name'>) => `models.${adapter.name}`

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

export async function refreshModels($: Pick<EngineInterface, 'store' | 'process' | 'env' | 'fs'>, adapter: Adapter): Promise<void> {
  const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))
  if (!home) return
  const listed = await $.process.run([...adapter.catalogue.argv], { cwd: home, timeoutMs: 30_000 }).catch(() => undefined)
  if (listed?.exitCode !== 0) return
  const { preferred } = adapter.catalogue
  const settings = preferred ? await $.fs.read(`${home}/${preferred.file}`).catch(() => undefined) : undefined
  const first = preferred && typeof settings === 'string' ? preferred.pick(settings) : undefined
  const ids = [...new Set([...(first ? [first] : []), ...adapter.catalogue.ids(listed.stdout)].filter(isModel))]
  if (ids.length > 0) await $.store.set(key(adapter), ids)
}
