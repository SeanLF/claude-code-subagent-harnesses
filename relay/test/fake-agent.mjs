// A fake ACP agent for the relay's tests. By default its prompt fails as codex-acp's does when Codex
// hits its usage limit, with the cause in the error's data. With FAKE_ECHO set it takes images and
// answers with what it was offered: the client's capabilities and the prompt's block types.
import { createInterface } from 'node:readline'

const send = (m) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`)
const echo = process.env.FAKE_ECHO === '1'
let offered
for await (const line of createInterface({ input: process.stdin })) {
  const m = JSON.parse(line)
  if (m.method === 'initialize') {
    offered = m.params.clientCapabilities
    send({ id: m.id, result: { protocolVersion: m.params.protocolVersion, agentCapabilities: { promptCapabilities: { image: echo } } } })
  } else if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 's1' } })
  else if (m.method === 'session/prompt' && echo) {
    const said = JSON.stringify({
      offered,
      blocks: m.params.prompt.map((b) => (b.type === 'image' ? `image:${b.mimeType}:${b.data.length}` : b.type)),
    })
    send({
      method: 'session/update',
      params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: said } } },
    })
    send({ id: m.id, result: { stopReason: 'end_turn' } })
  } else if (m.method === 'session/prompt')
    send({
      id: m.id,
      error: { code: -32603, message: 'Internal error', data: { details: "You've hit your usage limit. Try again at 10:04 PM." } },
    })
  else if (m.id !== undefined) send({ id: m.id, result: {} })
}
