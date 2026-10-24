# `via`: one plugin, an adapter per harness

2026-10-24. Stale by default: re-check each harness's flags and events before relying on them.

## Goal

Hand a task to another coding-agent harness (pi, Codex, Antigravity, Gemini CLI) as a native Claude Code subagent: `via:pi`, `via:codex`, `via:agy`, `via:gemini`. Every type keeps what `pi:general-purpose` has today: live streaming, follow-ups in the same harness session, choices kept in `$.state` across reloads, a time limit, honest failures, the `— answered by <harness>, <model>` signature. Mid-run steering stays where the harness allows it (pi today).

Repo `SeanLF/claude-code-subagent-harnesses`, plugin `via`. The plugin name keys `$.state` (`PluginState { via: … }`) and the agent types, so the rename is a code change.

## Prompt lines

Neutral, at the top of the prompt, one per line: `model:`, `tools:`, `thinking:`, and `via-help`. The `pi-` spellings stay as aliases. Values are validated per harness; a value a harness can't honour is refused with that harness's help text, never mapped to something weaker.

## Adapter shape

```ts
type Choice = { model?: string; tools?: string; thinking?: string }

type Norm =
  | { k: 'session'; id: string }              // harness-issued id, stored per agent
  | { k: 'model'; name: string }              // when the stream names it
  | { k: 'text' | 'thinking' | 'tool'; t: string }
  | { k: 'usage'; usage: Usage }              // already split into input / cache read / output
  | { k: 'steered' }                          // a steer the harness consumed
  | { k: 'error'; message: string }

type Adapter = {
  name: 'pi' | 'codex' | 'agy' | 'gemini'
  bin: string
  readOnly: 'enforced' | 'none'               // only 'enforced' may accept `tools: read`
  toolList: boolean                           // pi only
  thinking: readonly string[]                 // this harness's accepted levels; [] = refuse the line
  steer: boolean
  start(c: { choice: Choice; prompt: string; session?: string; agentId: string; root: string; inbox?: string }): ProcessSpawnRequest
  event(line: string): Norm[]                 // one line may yield several, or none
  model(choice: Choice): string | undefined   // fallback when the stream never names it
  failure?(exit: ProcessSpawnResult, stderr: string): string | undefined  // known failures in plain words
}
```

The shared core keeps everything else: header parsing, `$.state`, spawn loop and time limit, chunk building, usage totals, handback, the signature, steering inbox.

## What each harness does (checked 2026-10-24)

| | pi | codex 0.163.0 | agy 1.3.6 | gemini 0.65.0 |
|---|---|---|---|---|
| Run | `pi -p --mode json` | `codex exec --json` | `agy --output-format stream-json -p=<prompt>` | `gemini -o stream-json -p <prompt>` |
| Prompt | stdin | stdin is read and appended ("Reading additional input from stdin") | `-p` value | `-p` value |
| Session | ours: `--session-id` | `thread.started.thread_id`, resume `codex exec resume <id>` | `init.conversation_id`, resume `--conversation <id>` | `--resume latest\|index` only: no id to target |
| Text | deltas | whole `agent_message` items, no deltas | `text_delta` per step | unverified |
| Tools | `tool_execution_start` | `item.started` `command_execution` | `step_update` `step_type: tool` | unverified |
| Usage | per message | `turn.completed.usage` (input includes cached; `cached_input_tokens` separate) | per step and in `result.usage`, with `thinking_tokens` | unverified |
| Model named in stream | yes | no (config: `~/.codex/config.toml` `model`) | no | unverified |
| Read-only | `--tools read`, enforced | `-s read-only`, OS sandbox | none fits: `--mode plan` changes the task (writes a plan file, waits for approval), and print mode runs `always-proceed` | `--approval-mode plan`, silently dropped in an untrusted folder |
| Thinking | `--thinking off..max` | `-c model_reasoning_effort=` | `--effort low..max` | unverified |
| Failure seen | `message_end` `stopReason: error` | unverified | `result.status` != `SUCCESS` | exit 55, stderr `IneligibleTierError` for individual accounts (Google moved them to Antigravity on 2026-06-18) |

## Pre-mortem: how this fails

1. **`tools: read` that isn't read-only.** agy's plan mode and gemini's plan mode in an untrusted folder look read-only and aren't. → `readOnly: 'none'` for both; `tools: read` there is refused with the reason. A test per adapter asserts the refusal.
2. **A signature that names the wrong model.** Codex and agy don't report the model. → the signature uses the stream's model, else the `model:` line, else the harness's config if the adapter can read it, else `<harness>, model not reported`. Never the plugin's guess presented as fact.
3. **A follow-up that starts a fresh session.** Codex and agy issue their own ids after the run starts. → store the id in `$.state` the moment the `session` event arrives (a reload mid-run must not lose it); a follow-up without a stored id says so instead of silently starting over. Gemini can't resume by id: follow-ups there start a new session, said in its help.
4. **Prompt text read as flags or files.** pi read `@…` from argv as a file. agy and gemini take the prompt as `-p` value. → each adapter has a test that a prompt starting with `@`, `-` and `--` reaches the harness as text; prefer stdin wherever the harness reads it (`-p=<prompt>` attached form for agy).
5. **Usage counted twice.** Codex's `input_tokens` includes `cached_input_tokens`. → adapters emit usage already split; a test per adapter pins the mapping against a captured event.
6. **Killing the CLI leaves the work running.** agy advertises asynchronous background workflows. → before trusting the time limit on agy, a live test: start a long run, hit the limit, check no agy process or server-side task continues. Unverified today.
7. **Four descriptions on every request.** Each agent type's description rides on every Claude request. → one line each (`via:codex`: "Codex CLI agent. Top lines: model: … tools: read thinking: high. via-help for more.") and register only types whose binary is on PATH at session start.
8. **The help text drifts from the code.** → help is built from each adapter's own fields (accepted thinking levels, read-only support, resume support), not written by hand.
9. **The harness brings its own context.** agy read the user's global AGENTS.md and announced a "mode". Not ours to fix; the README says each harness loads its own user config.
10. **Steering promised where it can't happen.** → SendMessage interception only for adapters with `steer: true`; everything else stays a follow-up, and the help says which.

## Order

1. Rename to `via`, extract the adapter seam with pi as the only adapter, all current tests passing unchanged (`pi-` aliases).
2. `via:codex`, with captured-event tests and one live run.
3. `via:agy`, with the kill test from pre-mortem 6.
4. `via:gemini` only if someone with an enterprise or API-key account can test it; until then not registered.
5. README in muxer's style: what you do first, how it works, setup steps, the per-harness table.
