export type UsageRead = 'outputTokens'
export type AskOptionRead = 'optionId' | 'name' | 'kind'

export type AskOption = { readonly [F in AskOptionRead]: string }

export type RelayQuestion =
  | { readonly mode: 'form'; readonly message: string; readonly requestedSchema?: unknown }
  | { readonly mode: 'url'; readonly message: string; readonly url: string; readonly elicitationId: string }

export type RelayLine =
  | { readonly relay: 'session'; readonly sessionId: string; readonly cwd: string }
  | { readonly relay: 'session_lost'; readonly message: string }
  | { readonly relay: 'model'; readonly name: string }
  | { readonly relay: 'steered' }
  | { readonly relay: 'prompt_done'; readonly stopReason: string; readonly usage: { readonly [F in UsageRead]?: unknown } | null }
  | { readonly relay: 'interrupted' }
  | {
      readonly relay: 'ask'
      readonly id: string
      readonly title: string
      readonly kind: string
      readonly command?: string
      readonly options: readonly AskOption[]
    }
  | ({ readonly relay: 'question'; readonly id: string } & RelayQuestion)
  | { readonly relay: 'question_closed'; readonly id: string }
  | { readonly relay: 'agent_exit'; readonly code: number | null }
  | { readonly relay: 'forgotten'; readonly sessionId: string; readonly how: 'archived' | 'deleted' | 'gone' }
  | { readonly relay: 'error'; readonly message: string }
  | { readonly relay: 'done'; readonly stopReason: string | null }

export type RelayKind = RelayLine['relay']
export type RelayLineOf<K extends RelayKind> = Extract<RelayLine, { readonly relay: K }>

type Fields<T> = T extends unknown ? keyof T : never
export type Heard = {
  [K in RelayKind]: { readonly relay: K } & { readonly [F in Exclude<Fields<RelayLineOf<K>>, 'relay'>]?: unknown }
}[RelayKind]
export type Unchecked<T> = { readonly [F in keyof T]?: unknown }

export type QuestionReply =
  | { readonly action: 'accept'; readonly content: Readonly<Record<string, unknown>> }
  | { readonly action: 'decline' }
  | { readonly action: 'cancel' }

export type InboxLine =
  | string
  | { readonly interrupt: string }
  | { readonly answer: string; readonly optionId: string | null }
  | { readonly question: string; readonly answer: QuestionReply }
