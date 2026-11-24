import { isRecord } from './acp/json'
import type { Question } from './acp/norm'

// A harness's question (ACP elicitation, MCP's form) as Claude Code's AskUserQuestion dialog asks it, and the
// answers read back onto the harness's requestedSchema. A form the dialog can't show (a link to open, more than
// four fields, a choice of more than three, a field of another kind) goes to the step server's MCP form instead.

export const LET_CLAUDE = 'Let Claude answer'
export const DECLINE = 'Decline'
const MAX_QUESTIONS = 4
const MAX_OPTIONS = 4
const HEADER = 12

type Choice = { value: unknown; label: string }
// One field, asked as one question of the dialog. title: the question as shown, unique in the form; sink: the
// text field that takes this question's free text, when it is a choice with one.
export type Asked = {
  name: string
  kind: 'choice' | 'multi' | 'text' | 'number'
  title: string
  header: string
  choices: Choice[]
  required: boolean
  integer?: true
  min?: number
  max?: number
  sink?: string
}
// offer: the dialog offers "Let Claude answer".
export type Plan = { asked: Asked[]; offer: boolean }
// A question as AskUserQuestion takes it.
export type Shown = { question: string; header: string; multiSelect: boolean; options: { label: string; description: string }[] }

function choicesOf(field: Record<string, unknown>): Choice[] | undefined {
  if (Array.isArray(field.enum)) {
    const names = Array.isArray(field.enumNames) ? field.enumNames : []
    return field.enum.map((value, i) => ({ value, label: typeof names[i] === 'string' ? names[i] : String(value) }))
  }
  const listed = Array.isArray(field.oneOf) ? field.oneOf : Array.isArray(field.anyOf) ? field.anyOf : undefined
  if (listed?.every((o) => isRecord(o) && 'const' in o))
    return listed.map((o) => ({ value: o.const, label: typeof o.title === 'string' && o.title ? o.title : String(o.const) }))
  if (field.type === 'boolean')
    return [
      { value: true, label: 'Yes' },
      { value: false, label: 'No' },
    ]
  return undefined
}

const kindOf = (field: Record<string, unknown>): Pick<Asked, 'kind' | 'choices'> | undefined => {
  if (field.type === 'array') {
    const choices = isRecord(field.items) ? choicesOf(field.items) : undefined
    return choices ? { kind: 'multi', choices } : undefined
  }
  const choices = choicesOf(field)
  if (choices) return { kind: 'choice', choices }
  if (field.type === 'string') return { kind: 'text', choices: [] }
  if (field.type === 'number' || field.type === 'integer') return { kind: 'number', choices: [] }
  return undefined
}

// What a number field takes, in words: "a whole number from 1 to 8".
const rangeOf = (a: Pick<Asked, 'integer' | 'min' | 'max'>) =>
  `${a.integer ? 'a whole number' : 'a number'}${a.min !== undefined ? ` from ${a.min}` : ''}${a.max !== undefined ? ` to ${a.max}` : ''}`

// The options a question shows: its choices, "Let Claude answer" when offered, and "Decline" while it has fewer than two.
export function optionsOf(a: Asked, offer: boolean): string[] {
  const labels = [...a.choices.map((c) => c.label), ...(offer ? [LET_CLAUDE] : [])]
  return labels.length < 2 ? [...labels, DECLINE] : labels
}

// The form as the dialog's questions, or undefined when it doesn't fit the dialog. A text field named after a
// choice (codex-acp's question_0_note for question_0) is that choice's sink, not a question of its own: the
// free text typed under the dialog's "Other" goes there.
export function planOf(q: Question, harness: string, offer: boolean): Plan | undefined {
  if (q.mode !== 'form') return undefined
  const schema = q.requestedSchema
  const properties = isRecord(schema.properties) ? schema.properties : {}
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((n) => typeof n === 'string') : [])
  const fields: (Omit<Asked, 'title' | 'header'> & { field: Record<string, unknown> })[] = []
  for (const [name, field] of Object.entries(properties)) {
    if (!isRecord(field)) return undefined
    const kind = kindOf(field)
    if (kind === undefined) return undefined
    const range = {
      ...(field.type === 'integer' ? { integer: true as const } : {}),
      ...(typeof field.minimum === 'number' ? { min: field.minimum } : {}),
      ...(typeof field.maximum === 'number' ? { max: field.maximum } : {}),
    }
    fields.push({ name, field, required: required.has(name), ...kind, ...range })
  }
  const choices = fields.filter((f) => f.kind === 'choice' || f.kind === 'multi')
  const sinks = new Set<string>()
  for (const f of fields)
    if (f.kind === 'text') {
      const owner = choices.find((c) => f.name.startsWith(`${c.name}_`) && c.sink === undefined)
      if (owner !== undefined) {
        owner.sink = f.name
        sinks.add(f.name)
      }
    }
  const asked = fields.filter((f) => !sinks.has(f.name))
  if (asked.length === 0 || asked.length > MAX_QUESTIONS) return undefined
  const titles = new Set<string>()
  const plan: Asked[] = asked.map(({ field, ...f }, i) => {
    const title = typeof field.title === 'string' && field.title ? field.title : ''
    const description = typeof field.description === 'string' ? field.description : ''
    // A field with neither title nor description is asked by the form's message, as the MCP form shows it.
    const named = title || description || (i === 0 && q.message ? q.message : f.name)
    let text = [named, title && description && description !== title ? description : ''].filter(Boolean).join('\n')
    if (f.kind === 'number' && (f.min !== undefined || f.max !== undefined)) text += ` (${rangeOf(f)})`
    // The form's own message leads the first question, unless it only repeats it.
    if (i === 0 && q.message && q.message !== named) text = `${q.message}\n\n${text}`
    while (titles.has(text)) text = `${text} (${i + 1})`
    titles.add(text)
    const header = asked.length === 1 ? harness : `${harness} ${i + 1}/${asked.length}`
    return { ...f, title: text, header: header.length > HEADER ? header.slice(0, HEADER) : header }
  })
  for (const a of plan) {
    const labels = optionsOf(a, offer)
    // The dialog takes two to four options: a text or number field with no hand-off to offer has only Decline.
    if (labels.length < 2 || labels.length > MAX_OPTIONS || new Set(labels).size !== labels.length || labels.some((l) => !l.trim()))
      return undefined
    if (a.choices.some((c) => c.label === LET_CLAUDE || c.label === DECLINE)) return undefined
  }
  return { asked: plan, offer }
}

const LET_CLAUDE_SAYS = 'Hand this question to the main agent, which answers it for you'
const DECLINE_SAYS = 'Answer none of these questions'

// The dialog's questions; note leads the first one, saying why it is asked again.
export function shownOf(plan: Plan, note = ''): Shown[] {
  return plan.asked.map((a, i) => ({
    question: i === 0 && note ? `${note}\n\n${a.title}` : a.title,
    header: a.header,
    multiSelect: a.kind === 'multi',
    options: optionsOf(a, plan.offer).map((label) => ({
      label,
      description: label === LET_CLAUDE ? LET_CLAUDE_SAYS : label === DECLINE ? DECLINE_SAYS : '',
    })),
  }))
}

// One answer's text as the field's value. A choice is named by its label, exactly or at the answer's start (what
// follows goes to its sink); other text goes to its sink, when it has one.
type Value = { value?: unknown; text?: string } | { error: string }
function fieldValue(a: Asked, said: string): Value {
  const text = said.trim()
  const label = (l: string) => l.toLowerCase()
  if (a.kind === 'text') return { value: text }
  if (a.kind === 'number') {
    const n = Number(text)
    if (
      text === '' ||
      !Number.isFinite(n) ||
      (a.integer && !Number.isInteger(n)) ||
      (a.min !== undefined && n < a.min) ||
      (a.max !== undefined && n > a.max)
    )
      return { error: `"${a.title}" needs ${rangeOf(a)}, not "${text}".` }
    return { value: n }
  }
  const sinkOr = (rest: string, error: string): Value => (rest === '' ? {} : a.sink !== undefined ? { text: rest } : { error })
  const named = `one of ${a.choices.map((c) => `"${c.label}"`).join(', ')}`
  if (a.kind === 'multi') {
    const parts = text
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
    const picked = a.choices.filter((c) => parts.some((p) => label(p) === label(c.label)))
    const rest = parts.filter((p) => !a.choices.some((c) => label(p) === label(c.label))).join(', ')
    const left = sinkOr(rest, `"${a.title}" takes ${named}, comma-separated.`)
    if ('error' in left) return left
    return { ...(picked.length > 0 ? { value: picked.map((c) => c.value) } : {}), ...left }
  }
  const exact = a.choices.find((c) => label(c.label) === label(text))
  if (exact) return { value: exact.value }
  // The longest label first, so "Yes, always" is not read as "Yes".
  const leading = [...a.choices]
    .sort((x, y) => y.label.length - x.label.length)
    .find((c) => label(text).startsWith(label(c.label)) && !/\w/.test(text[c.label.length] ?? ''))
  if (leading) {
    const rest = text.slice(leading.label.length).replace(/^[\s,.:;—-]+/, '')
    return { value: leading.value, ...(a.sink !== undefined && rest ? { text: rest } : {}) }
  }
  return sinkOr(text, `"${a.title}" takes ${named}.`)
}

// What the answers say: the harness's content, the questions handed to the main agent, a decline, or why they
// can't go back as they are.
export type Read = { content: Record<string, unknown>; handed: Asked[]; declined?: true; errors: string[] }

function put(content: Record<string, unknown>, a: Asked, v: { value?: unknown; text?: string }) {
  if (v.value !== undefined) content[a.name] = v.value
  if (v.text !== undefined && a.sink !== undefined) content[a.sink] = v.text
}

// The person's answers, as AskUserQuestion returns them: by question text, a multi-select's comma-joined.
export function readAnswers(plan: Plan, answers: Readonly<Record<string, unknown>>, shown: Shown[]): Read {
  const read: Read = { content: {}, handed: [], errors: [] }
  plan.asked.forEach((a, i) => {
    const said = answers[shown[i]?.question ?? a.title]
    const text = typeof said === 'string' ? said : Array.isArray(said) ? said.join(', ') : ''
    const parts = text.split(',').map((p) => p.trim())
    if (text === LET_CLAUDE || (a.kind === 'multi' && parts.includes(LET_CLAUDE))) read.handed.push(a)
    else if (text === DECLINE) read.declined = true
    else if (text.trim() === '') {
      if (a.required) read.errors.push(`"${a.title}" needs an answer.`)
    } else {
      const v = fieldValue(a, text)
      if ('error' in v) read.errors.push(v.error)
      else put(read.content, a, v)
    }
  })
  return read
}

// The main agent's message, onto the questions handed to it: the whole message for one question, a numbered line
// each ("1. Blue") for several. "Decline" declines them all.
export function readReply(handed: Asked[], message: string): Read {
  const read: Read = { content: {}, handed: [], errors: [] }
  if (message.trim().toLowerCase() === DECLINE.toLowerCase()) return { ...read, declined: true }
  const said = new Map<number, string>()
  if (handed.length === 1) said.set(0, message)
  else {
    let at: number | undefined
    for (const line of message.split(/\r?\n/)) {
      const numbered = /^\s*(\d+)[.):]\s*(.*)$/.exec(line)
      if (numbered) {
        at = Number(numbered[1]) - 1
        said.set(at, numbered[2] ?? '')
      } else if (at !== undefined && line.trim()) said.set(at, `${said.get(at)}\n${line}`)
    }
  }
  handed.forEach((a, i) => {
    const text = said.get(i)?.trim() ?? ''
    if (text === '') {
      if (a.required || handed.length > 1) read.errors.push(`No answer to question ${i + 1}, "${a.title}".`)
      return
    }
    const v = fieldValue(a, text)
    if ('error' in v) read.errors.push(v.error)
    else put(read.content, a, v)
  })
  return read
}

// The message the main agent gets: which agent asks, why it's the main agent's to answer, the questions with
// their options, and how to answer. Its first line stands alone, as SendMessage's recipient previews it.
export function handoffText(o: { harness: string; to: string; why: string; handed: Asked[] }): string {
  const one = o.handed.length === 1
  const lines = [
    `The ${o.harness} agent "${o.to}" needs an answer to its harness's question${one ? '' : 's'}: ${o.why}.`,
    '',
    ...o.handed.flatMap((a, i) => {
      const how =
        a.kind === 'text'
          ? 'Your own text.'
          : a.kind === 'number'
            ? `${rangeOf(a).replace(/^a/, 'A')}.`
            : `${a.kind === 'multi' ? 'One or more of, comma-separated' : 'One of'}: ${a.choices.map((c) => `"${c.label}"`).join(', ')}${a.sink !== undefined ? ', or your own text' : ''}.`
      return [one ? a.title : `${i + 1}. ${a.title.replace(/\n/g, '\n   ')}`, one ? how : `   ${how}`, '']
    }),
    one
      ? `Answer with SendMessage to "${o.to}", the message being your answer alone.`
      : `Answer with SendMessage to "${o.to}", one line per question: "1. <answer>".`,
    `"${DECLINE}" declines. The harness waits for your answer.`,
  ]
  return lines.join('\n')
}

// Claude Code's form cuts a field's title at about 47 characters, and codex-acp puts each of Codex's questions in
// its field's title. A title longer than LONG_TITLE goes first in the form's message instead, its field labelled.
// The message shows MESSAGE_LINES lines, each cropped at the terminal's width (anthropics/claude-code#102766), so
// questions are wrapped to fit 80 columns: the first long one always moves, one of up to about 220 characters shown
// whole; a later one moves only while all still fit, or it would be hidden, and otherwise keeps its own cut title.
// Only for the form: AskUserQuestion shows a question whole.
const LONG_TITLE = 40
const WRAP = 72
const MESSAGE_LINES = 3

function wrapped(text: string, indent: string): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > WRAP - indent.length) {
      lines.push(line)
      line = word
    } else line = line ? `${line} ${word}` : word
  }
  if (line) lines.push(line)
  return lines
}

export function wholeQuestions(q: Question): Question {
  if (q.mode !== 'form') return q
  const { message, requestedSchema: schema } = q
  const properties = isRecord(schema.properties) ? schema.properties : {}
  const long = Object.entries(properties).flatMap(([name, field]) =>
    isRecord(field) && typeof field.title === 'string' && field.title.length > LONG_TITLE ? [[name, field.title] as const] : [],
  )
  if (long.length === 0) return q
  const moved: (typeof long)[number][] = []
  let lines = 0
  for (const question of long) {
    const more = wrapped(question[1], '   ').length
    if (moved.length > 0 && lines + more > MESSAGE_LINES) break
    moved.push(question)
    lines += more
  }
  const one = moved.length === 1
  const label = new Map(moved.map(([name], i) => [name, one ? 'Answer' : `Answer ${i + 1}`]))
  const asked = moved.map(([, title], i) => (one ? wrapped(title, '').join('\n') : `${i + 1}. ${wrapped(title, '   ').join('\n   ')}`))
  return {
    ...q,
    message: `${asked.join('\n')}\n\n${message}`,
    requestedSchema: {
      ...schema,
      properties: Object.fromEntries(
        Object.entries(properties).map(([name, field]) => [
          name,
          label.has(name) ? { ...(field as object), title: label.get(name) } : field,
        ]),
      ),
    },
  }
}
