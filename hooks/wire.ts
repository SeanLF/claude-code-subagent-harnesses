type PiMessage = {
  readonly role?: string
  readonly provider?: string
  readonly model?: string
  readonly usage?: { readonly input?: number; readonly output?: number; readonly cacheRead?: number; readonly cacheWrite?: number }
  readonly stopReason?: string
  readonly errorMessage?: string
}
export type PiEvent =
  | { readonly type: 'message_start'; readonly message?: PiMessage }
  | { readonly type: 'message_end'; readonly message?: PiMessage }
  | { readonly type: 'message_update'; readonly assistantMessageEvent?: { readonly type?: string; readonly delta?: unknown } }
  | { readonly type: 'tool_execution_start'; readonly toolCallId?: unknown; readonly toolName?: unknown; readonly args?: unknown }
  | {
      readonly type: 'tool_execution_end'
      readonly toolCallId?: unknown
      readonly toolName?: unknown
      readonly result?: unknown
      readonly isError?: unknown
    }
  | { readonly type: 'compaction_start' }
  | {
      readonly type: 'compaction_end'
      readonly reason?: string
      readonly aborted?: boolean
      readonly errorMessage?: string
      readonly result?: { readonly tokensBefore?: number; readonly estimatedTokensAfter?: number; readonly summary?: string }
    }
