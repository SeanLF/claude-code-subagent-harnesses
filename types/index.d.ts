export type Choice = {
  model?: string
  tools?: string
  thinking?: string
}
export type ViaSteps = { wait: (input: { agentId: string }) => Promise<void> }
declare module 'claude-code' {
  interface EngineInterface {
    viaSteps: ViaSteps
  }

  interface PluginState {
    via: {
      agents: StateFamily<Choice>
      sessions: StateFamily<string>
      handbacks: StateFamily<boolean>
      reports: StateFamily<string>
      handedBack: StateFamily<boolean>
      modes: StateFamily<string>
    }
  }
}
