import type { SessionUpdate as AcpUpdate, ToolCallContent, Usage } from '@agentclientprotocol/sdk/unstable'
import type { JsonAgentSessionEvent } from '@earendil-works/pi-coding-agent'
import type { ContentRead, Read } from '../hooks/acp/wire'
import type { UsageRead } from '../hooks/acp/wire-relay'
import type { PiEvent } from '../hooks/wire'

type None<T> = [T] extends [never] ? true : T
type Real<T> = 0 extends 1 & T ? 'unresolved' : true

type Acp<K> = Extract<AcpUpdate, { sessionUpdate: K }>
export const acpUpdates: None<Exclude<keyof Read, AcpUpdate['sessionUpdate']>> = true
export const acpFields: None<{ [K in keyof Read]: Exclude<Read[K], keyof Acp<K>> }[keyof Read]> = true
export const acpContent: None<Exclude<keyof ContentRead, ToolCallContent['type']>> = true
export const acpContentFields: None<
  { [K in keyof ContentRead]: Exclude<ContentRead[K], keyof Extract<ToolCallContent, { type: K }>> }[keyof ContentRead]
> = true
export const acpUsage: None<Exclude<UsageRead, keyof Usage>> = true

type Pi<K> = Extract<JsonAgentSessionEvent, { type: K }>
type Ours<K> = Extract<PiEvent, { type: K }>
type Reply = Extract<Pi<'message_end'>['message'], { role: 'assistant' }>
type OurMessage = NonNullable<Ours<'message_end'>['message']>
type Delta = NonNullable<Pi<'message_update'>['assistantMessageEvent']>
export const resolved: Real<
  AcpUpdate | ToolCallContent | Usage | JsonAgentSessionEvent | Reply | Reply['usage'] | Delta | NonNullable<Pi<'compaction_end'>['result']>
> = true
export const piEvents: None<Exclude<PiEvent['type'], JsonAgentSessionEvent['type']>> = true
export const piFields: None<{ [K in PiEvent['type']]: Exclude<keyof Ours<K>, keyof Pi<K>> }[PiEvent['type']]> = true
export const piShapes: None<{ [K in PiEvent['type']]: Pi<K> extends Ours<K> ? never : K }[PiEvent['type']]> = true
export const piMessage: None<Exclude<keyof OurMessage, keyof Reply>> = true
export const piUsage: None<Exclude<keyof NonNullable<OurMessage['usage']>, keyof Reply['usage']>> = true
export const piDeltaKinds: None<Exclude<'text_delta' | 'thinking_delta', Delta['type']>> = true
export const piDeltas: None<
  { [K in 'text_delta' | 'thinking_delta']: Exclude<'delta', keyof Extract<Delta, { type: K }>> }['text_delta' | 'thinking_delta']
> = true
export const piCompaction: None<
  Exclude<keyof NonNullable<Ours<'compaction_end'>['result']>, keyof NonNullable<Pi<'compaction_end'>['result']>>
> = true
