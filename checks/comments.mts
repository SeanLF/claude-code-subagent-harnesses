import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseSync } from 'oxc-parser'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const GENERATED = new Set(['relay/relay.mjs'])
const DIRECTIVES = [/^ biome-ignore(?:-all|-start|-end)? lint\/\w+\/\w+(?:\([^)\n]*\))?: \S[^\n]*$/, /^ @ts-expect-error$/]
const MESSAGE = [
  'No comments: a rule goes in a test, a type or a name; why goes in the commit message.',
  "Only directives stay: a lint rule's biome-ignore with its reason, and a bare @ts-expect-error.",
  'A comment that seems needed is a missing test or a better name.',
].join('\n')

const lineOf = (source: string, at: number) => source.slice(0, at).split('\n').length

function keys(value: unknown, at: string): string[] {
  if (Array.isArray(value)) return value.flatMap((v, n) => keys(v, `${at}[${n}]`))
  if (typeof value !== 'object' || value === null) return []
  return Object.entries(value).flatMap(([key, v]) => [...(key === '//' ? [at || '.'] : []), ...keys(v, `${at}.${key}`)])
}

const found = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' })
  .split('\0')
  .filter((file) => file && !file.startsWith('docs/') && !GENERATED.has(file) && existsSync(`${ROOT}/${file}`))
  .flatMap((file) => {
    const read = () => readFileSync(`${ROOT}/${file}`, 'utf8')
    if (/\.[cm]?[jt]sx?$/.test(file)) {
      const source = read()
      const parsed = parseSync(file, source)
      if (parsed.errors.length > 0) return [`${file}: oxc could not parse it, so its comments are unknown`]
      return parsed.comments
        .filter((c) => c.type === 'Block' || !DIRECTIVES.some((d) => d.test(c.value)))
        .map((c) => `${file}:${lineOf(source, c.start)}`)
    }
    if (file.endsWith('.json') && !file.endsWith('-lock.json'))
      return keys(JSON.parse(read()), '').map((at) => `${file}: "//" key at ${at}`)
    return []
  })

if (found.length > 0) {
  process.stderr.write(`${found.join('\n')}\n\n${MESSAGE}\n`)
  process.exit(1)
}
