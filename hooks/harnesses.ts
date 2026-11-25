import { agy } from './adapters/agy'
import { codex } from './adapters/codex'
import { opencode } from './adapters/opencode'
import { pi } from './adapters/pi'

export const HARNESSES = [pi, codex, agy, opencode] as const
export type HarnessName = (typeof HARNESSES)[number]['name']
