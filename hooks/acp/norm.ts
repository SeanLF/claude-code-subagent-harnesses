export type Usage = {
  readonly input: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly output: number
}

export type Norm =
  | { readonly k: 'message' }
  | { readonly k: 'session'; readonly id: string }
  | { readonly k: 'model'; readonly name: string }
  | { readonly k: 'text' | 'thinking' | 'tool'; readonly t: string }
  | { readonly k: 'call'; readonly id: string; readonly kind: string; readonly title: string; readonly path?: string }
  | { readonly k: 'called'; readonly id: string; readonly output: string; readonly failed: boolean }
  | { readonly k: 'plan'; readonly entries: readonly { readonly content: string; readonly status: string }[] }
  | { readonly k: 'usage'; readonly usage: Usage }
  | { readonly k: 'steered' }
  | { readonly k: 'error'; readonly message: string }
  | { readonly k: 'unfinished'; readonly why: string }
  | { readonly k: 'notice'; readonly t: string }
  | { readonly k: 'interrupted' }
  | { readonly k: 'ask'; readonly ask: Ask }
  | { readonly k: 'question'; readonly question: Question }
  | { readonly k: 'question-closed'; readonly id: string }
  | {
      readonly k: 'child'
      readonly id: string
      readonly parent: string
      readonly title?: string
      readonly description?: string
      readonly state?: string
      readonly failure?: string
      readonly cancelled?: boolean
    }
  | { readonly k: 'of'; readonly child: string; readonly norm: Norm }
  | { readonly k: 'told'; readonly t: string }

export type Ask = {
  readonly id: string
  readonly title: string
  readonly kind: string
  readonly command?: string
  readonly options: readonly { readonly optionId: string; readonly name: string; readonly kind: string }[]
}

export type Question = { readonly id: string; readonly message: string } & (
  | { readonly mode: 'form'; readonly requestedSchema: Readonly<Record<string, unknown>> }
  | { readonly mode: 'url'; readonly url: string; readonly elicitationId: string }
)

export type Mode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions' | 'dontAsk'
