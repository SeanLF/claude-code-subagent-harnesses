import type { TurnStepChunk, TurnUsage } from 'claude-code'
import type { CallInput, Mark } from './acp/steps'

export class StepWriter {
  index: number
  report = ''
  spoke = false
  private kind: 'text' | 'thinking' | undefined
  private listed = ''
  private plans = 0
  private tolds = 0

  constructor(first = 0) {
    this.index = first - 1
  }

  private push(kind: 'text' | 'thinking', text: string): TurnStepChunk {
    if (kind !== this.kind) {
      this.kind = kind
      this.index += 1
    }
    return { kind, index: this.index, text }
  }

  text(t: string): TurnStepChunk {
    this.report += t
    this.spoke = true
    return this.push('text', t)
  }

  say(t: string): TurnStepChunk {
    return this.push('text', t)
  }

  thinking(t: string): TurnStepChunk {
    return this.push('thinking', t)
  }

  message(): void {
    this.report = ''
    this.boundary()
  }

  boundary(): void {
    this.kind = undefined
    this.spoke = false
  }

  call(id: string, input: CallInput, usage: TurnUsage | null): Mark {
    this.boundary()
    return { kind: 'call-start', id, input, usage }
  }

  plan(entries: readonly { content: string; status: string }[], usage: TurnUsage | null): Mark[] {
    const listed = entries.map((entry) => `${PLAN_MARKS[entry.status] ?? '☐'} ${entry.content}`).join('\n')
    if (listed === this.listed) return []
    this.listed = listed
    this.plans += 1
    const id = `plan-${this.plans}`
    return [this.call(id, { kind: 'plan', title: 'Plan' }, usage), { kind: 'call-end', id, output: listed, failed: false }]
  }

  told(text: string): Mark[] {
    this.tolds += 1
    const id = `told-${this.tolds}`
    return [this.call(id, { kind: 'message', title: 'From another agent' }, null), { kind: 'call-end', id, output: text, failed: false }]
  }
}

const PLAN_MARKS: Record<string, string> = { pending: '☐', in_progress: '◐', completed: '☑' }

export const answeredBy = (who: string, by?: string) => `— answered by ${who}${by ? `, ${by}` : ''}`
