// What relay/relay.mjs and via say to each other, both ways. The relay (relay/src/relay.mts) prints only these
// lines, or an ACP session notification as the agent sent it; via writes only inbox lines to its inbox. The
// parser (events.ts) reads every field it uses by these names, so a kind or field renamed here fails the type
// check there. Its values are still checked as read: a harness's text passes through them. No imports: the relay
// type-checks and bundles this file as well.

// A field the relay passes through from the agent, by the fields via reads of it: checks/sdk.ts fails when the
// SDK drops or renames one.
export type UsageRead = 'outputTokens'
export type AskOptionRead = 'optionId' | 'name' | 'kind'

/** One of the harness's permission options, as an ask line carries it. */
export type AskOption = { readonly [F in AskOptionRead]: string }

/** A question to the person, as the relay prints it: an ACP elicitation without its scope fields, the shape MCP takes. */
export type RelayQuestion =
  // A mode ACP adds goes as a form, its schema whatever the agent sent.
  | { readonly mode: 'form'; readonly message: string; readonly requestedSchema?: unknown }
  | { readonly mode: 'url'; readonly message: string; readonly url: string; readonly elicitationId: string }

/** The relay's own lines on stdout, by their `relay` kind. */
export type RelayLine =
  // The session is set up, just before its first prompt; cwd, so a title's paths can be shown relative to it.
  | { readonly relay: 'session'; readonly sessionId: string; readonly cwd: string }
  // A resumed session the agent no longer has.
  | { readonly relay: 'session_lost'; readonly message: string }
  // The model the session runs on, as its config reports it.
  | { readonly relay: 'model'; readonly name: string }
  // A prompt went out: the first, a queued one, or a steer the agent took.
  | { readonly relay: 'steered' }
  | { readonly relay: 'prompt_done'; readonly stopReason: string; readonly usage: { readonly [F in UsageRead]?: unknown } | null }
  | { readonly relay: 'interrupted' }
  // A permission request, under RELAY_POLICY=ask; answered by an inbox answer line.
  | {
      readonly relay: 'ask'
      readonly id: string
      readonly title: string
      readonly kind: string
      readonly command?: string
      readonly options: readonly AskOption[]
    }
  // A question to the person; answered by an inbox question line.
  | ({ readonly relay: 'question'; readonly id: string } & RelayQuestion)
  // A question no answer will settle now (an interrupt, the agent withdrew it): the person need not answer.
  | { readonly relay: 'question_closed'; readonly id: string }
  | { readonly relay: 'agent_exit'; readonly code: number | null }
  | { readonly relay: 'error'; readonly message: string }
  | { readonly relay: 'done'; readonly stopReason: string | null }

export type RelayKind = RelayLine['relay']
export type RelayLineOf<K extends RelayKind> = Extract<RelayLine, { readonly relay: K }>

// Every field of a union's members, not only those they share.
type Fields<T> = T extends unknown ? keyof T : never
/** A relay line as read: its kind known, each field present or not and of any type, until checked. */
export type Heard = {
  [K in RelayKind]: { readonly relay: K } & { readonly [F in Exclude<Fields<RelayLineOf<K>>, 'relay'>]?: unknown }
}[RelayKind]
/** An object as read, by the fields `T` names: any of them missing, each of any type. */
export type Unchecked<T> = { readonly [F in keyof T]?: unknown }

/** What the person did with a question: MCP's elicitation result, as Claude Code's form returns it. */
export type QuestionReply =
  | { readonly action: 'accept'; readonly content: Readonly<Record<string, unknown>> }
  | { readonly action: 'decline' }
  | { readonly action: 'cancel' }

/** via's lines in the relay's inbox (RELAY_INBOX), one JSON value each. */
export type InboxLine =
  // A steer: into the running prompt (RELAY_STEER), or queued as a follow-up.
  | string
  // Cancels the turn, then runs its text next.
  | { readonly interrupt: string }
  // Answers an ask line by its id: the option picked, or null for none (a cancel).
  | { readonly answer: string; readonly optionId: string | null }
  // Answers a question line by its id.
  | { readonly question: string; readonly answer: QuestionReply }
