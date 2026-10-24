export type PiChoice = {
  model?: string
  tools?: string
  thinking?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
}
declare module 'claude-code' {
  interface PluginState {
    pi: { agents: StateFamily<PiChoice> }
  }
}
