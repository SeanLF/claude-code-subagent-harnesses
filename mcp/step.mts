import { createInterface } from 'node:readline'

type Message = {
  id?: number | string
  method?: string
  params?: {
    protocolVersion?: string
    capabilities?: { elicitation?: { form?: object; url?: object } }
    arguments?: { question?: Question }
  }
  result?: unknown
  error?: unknown
}
type Question = { mode?: unknown; message?: unknown; requestedSchema?: unknown; url?: unknown; elicitationId?: unknown }

const step = {
  name: 'step',
  description:
    "One step of this agent's work, already done: kind is what it did (execute, read, edit, search, fetch), title what it acted on. Calling it does nothing.",
  inputSchema: { type: 'object', properties: { kind: { type: 'string' }, title: { type: 'string' } } },
}

const send = (message: object) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
const text = (value: string, isError?: true) => ({ content: [{ type: 'text', text: value }], ...(isError ? { isError } : {}) })
const REFUSED = text('via could not report this harness tool call.', true)
const CANCEL = text(JSON.stringify({ action: 'cancel' }))

let elicitation: { form: boolean; url: boolean } = { form: false, url: false }
const waiting = new Map<string, (reply: Message) => void>()
let asked = 0

function request(q: Question): object | undefined {
  if (typeof q.message !== 'string') return undefined
  if (q.mode === 'url')
    return elicitation.url && typeof q.url === 'string' && typeof q.elicitationId === 'string'
      ? { mode: 'url', message: q.message, url: q.url, elicitationId: q.elicitationId }
      : undefined
  return elicitation.form && typeof q.requestedSchema === 'object' && q.requestedSchema !== null
    ? { message: q.message, requestedSchema: q.requestedSchema }
    : undefined
}

function ask(id: number | string, q: Question) {
  const params = request(q)
  if (params === undefined) return send({ id, result: CANCEL })
  const own = `via-question-${++asked}`
  waiting.set(own, (reply) => send({ id, result: reply.result === undefined ? CANCEL : text(JSON.stringify(reply.result)) }))
  send({ id: own, method: 'elicitation/create', params })
}

const answers: Record<string, (message: Message) => object | undefined> = {
  initialize: ({ params }) => {
    const offered = params?.capabilities?.elicitation
    if (offered) elicitation = offered.form || offered.url ? { form: !!offered.form, url: !!offered.url } : { form: true, url: false }
    return {
      protocolVersion: params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'via', version: '0' },
    }
  },
  ping: () => ({}),
  'tools/list': () => ({ tools: [step] }),
  'tools/call': ({ id, params }) => {
    const question = params?.arguments?.question
    if (question === undefined || id === undefined) return REFUSED
    ask(id, question)
    return undefined
  },
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let message: Message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (message?.id === undefined) return
  if (message.method === undefined) {
    const reply = waiting.get(String(message.id))
    waiting.delete(String(message.id))
    reply?.(message)
    return
  }
  const answer = Object.hasOwn(answers, message.method) ? answers[message.method] : undefined
  if (answer === undefined) return send({ id: message.id, error: { code: -32601, message: `no method ${message.method}` } })
  const result = answer(message)
  if (result !== undefined) send({ id: message.id, result })
})
