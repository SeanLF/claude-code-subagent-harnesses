export type Choice = {
  model?: string
  tools?: string
  thinking?: string
}
// A queued child's next event, through the engine so the hook's own-time budget is paused.
export type ViaChildren = { wait: (input: { key: string }) => Promise<void> }
declare module 'claude-code' {
  interface EngineInterface {
    viaChildren: ViaChildren
  }

  interface PluginState {
    via: {
      agents: StateFamily<Choice>
      sessions: StateFamily<string>
      handbacks: StateFamily<boolean>
      reports: StateFamily<string>
      handedBack: StateFamily<boolean>
      modes: StateFamily<string>
      stepErrors: StateFamily<{
        kind: string
        message: string
        stack?: string
        stackOrigin: string
        turnId: string
        index: number
      }>
    }
  }
}
