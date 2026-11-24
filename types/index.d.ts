export type Choice = {
  model?: string
  tools?: string
  thinking?: string
  config?: Readonly<Record<string, string>> // config lines: the harness's own options, by id
}
declare module 'claude-code' {
  interface EngineInterface {
    viaSteps: { wait: (input: { agentId: string; turnId: string }) => Promise<void> }
    viaChildren: { wait: (input: { key: string }) => Promise<void> }
    viaQuestions: { away: (input: { id: number; ms: number }) => Promise<boolean> }
  }
}
