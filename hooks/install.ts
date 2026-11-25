import type { EngineInterface } from 'claude-code'
import type { Adapter } from './adapter'

type Engine = Pick<EngineInterface, 'process' | 'env' | 'fs' | 'plugin'>
export type Installs = {
  node?: Promise<string | undefined>
  installs: Map<string, Promise<string>>
}

const nodeOk = (version: string) => {
  const [major = 0, minor = 0] = version.split('.').map(Number)
  return major > 22 || (major === 22 && minor >= 18)
}

function isFile($: Engine, path: string): Promise<boolean> {
  return $.fs.stat(path).then(
    (s) => s.kind === 'file',
    () => false,
  )
}

async function prune($: Engine, root: string, dir: string): Promise<void> {
  const family = dir.replace(/\d.*$/, '')
  const entries = await $.fs.list(root).catch(() => [])
  const old = entries
    .filter((entry) => entry.kind === 'dir' && entry.name !== dir && entry.name.startsWith(family))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(1)
    .map((entry) => `${root}/${entry.name}`)
  if (old.length === 0) return
  const remove = "for (const d of process.argv.slice(1)) require('fs').rmSync(d, { recursive: true, force: true })"
  await $.process.run(['node', '-e', remove, ...old], { timeoutMs: 60_000 }).catch(() => undefined)
}

export async function relayReady(w: Installs, $: Engine, adapter: Adapter, latest: boolean): Promise<{ installed?: string } | string> {
  w.node ??= $.process.run(['node', '-p', 'process.versions.node'], { timeoutMs: 15_000 }).then(
    (r) => (r.exitCode === 0 ? r.stdout.trim() : undefined),
    () => undefined,
  )
  const version = await w.node
  if (!version || !nodeOk(version))
    return `via needs Node 22.18 or later on PATH to run ${adapter.name}${version ? `, not ${version}` : ''}. Install a current Node LTS and restart Claude Code.`
  const install = adapter.relay?.install
  if (!install) return {}
  const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))
  if (!home) return `${adapter.name} needs a home folder to install ${install.dir} into.`
  const root = `${home}/.claude/via/acp`
  const dir = `${root}/${latest ? 'latest' : install.dir}`
  const entry = `${dir}/${install.entry}`
  let installing = w.installs.get(dir)
  if (!installing) {
    installing = (async () => {
      const flags = ['--ignore-scripts', '--omit=optional', '--no-audit', '--no-fund']
      let argv: string[]
      if (latest) {
        await $.fs.write(`${dir}/package.json`, '{ "private": true }\n')
        argv = ['npm', 'install', ...flags, `${install.package}@latest`]
      } else {
        if (await isFile($, entry)) return entry
        for (const file of install.files) await $.fs.write(`${dir}/${file.split('/').at(-1)}`, await $.fs.read(`${$.plugin.root}/${file}`))
        argv = ['npm', 'ci', ...flags]
      }
      const done = await $.process
        .run(argv, { cwd: dir, timeoutMs: 300_000 })
        .catch((error: unknown) => ({ exitCode: -1, stderr: String(error) }))
      if (done.exitCode !== 0 && latest && (await isFile($, entry))) return entry
      if (done.exitCode !== 0) throw new Error(done.stderr.trim().split('\n').slice(-3).join(' ') || `npm ci exited with ${done.exitCode}`)
      if (!latest) void prune($, root, install.dir)
      return entry
    })()
    w.installs.set(dir, installing)
  }
  return installing.then(
    (installed) => ({ installed }),
    (error: unknown) => {
      w.installs.delete(dir)
      return `${adapter.name} could not install ${install.dir} (npm ci): ${String((error as { message?: unknown })?.message ?? error)}`
    },
  )
}
