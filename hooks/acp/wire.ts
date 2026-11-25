export type Read = {
  agent_message_chunk: 'content' | 'messageId'
  agent_thought_chunk: 'content'
  tool_call: 'toolCallId' | 'title' | 'kind' | 'status' | 'locations' | 'content' | 'rawOutput' | '_meta'
  tool_call_update: 'toolCallId' | 'title' | 'kind' | 'status' | 'locations' | 'content' | 'rawOutput' | '_meta'
  plan: 'entries'
  compaction_summary_chunk: 'compactionId' | 'content'
  compaction_update: 'compactionId' | 'summary' | 'status' | 'error'
  usage_update: 'used'
  subagent_update: 'sessionId' | 'title' | 'description' | 'state'
  session_message: 'messageId' | 'senderSessionId' | 'recipientSessionId' | 'senderMessageId' | 'recipientMessageId' | 'content'
  session_message_chunk: 'messageId' | 'content'
  config_option_update: 'configOptions'
  notice: 'severity' | 'title' | 'description'
}

export type SessionUpdate = {
  [K in keyof Read]: { readonly sessionUpdate: K } & { readonly [F in Read[K]]?: unknown }
}[keyof Read]

export type ContentRead = { content: 'content'; diff: 'path' | 'oldText' | 'newText' }
