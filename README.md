# via

Run Codex, Antigravity, OpenCode or pi as Claude Code subagents.

Called through Bash, another agent CLI blocks until it finishes, then dumps its output: no progress, no follow-ups, no interrupt, no proof of which model answered. `via` makes each one a native subagent instead. It shows in the agent list with its current step, streams as it works, keeps its session across follow-ups, takes an interrupt, passes you any question the harness asks, and names the model behind each answer.

Spend the quotas you already pay for, while Claude stays in charge: hand subtasks to Codex on your ChatGPT plan, Antigravity on your Google account, pi on a ChatGPT, Copilot or OpenRouter login, or OpenCode's free models. Each runs on its own official login, several at once if you like, and `via` stores no credentials. It's also a quick way to get a second model's read on Claude's work.

A real answer from `via:codex`, asked for one HTTP header:

```text
▸ execute: curl -sI https://example.com
HTTP/2 200

— answered by codex, gpt-6.1-sol
```

Codex's sandbox stopped the first attempt, so before the command ran, Claude Code asked in the main chat: "codex wants to run `curl -sI https://example.com`. Allow it?"

> [!IMPORTANT]
> Each harness runs its own tools as you, with its own permission settings, outside Claude Code's. The one thing `via` enforces is read-only: plan mode, or `tools: read` at the top of the prompt. Codex, OpenCode and pi then can't write; agy refuses, because it can't.

## How it works

- At session start, `via` adds an agent type for each harness on your PATH: `via:codex`, `via:agy`, `via:opencode`, `via:pi`.
- When Claude hands one a task, `via` runs that CLI headless with the prompt on stdin and streams its text and tool calls (`▸ execute: npm test`), plus thinking where the harness reports it. Codex and OpenCode run over the [Agent Client Protocol](https://agentclientprotocol.com) through a relay that ships with `via`, the ACP SDK bundled in. Codex's adapter, [`codex-acp`](https://github.com/agentclientprotocol/codex-acp), drives your own `codex`; on first use `via` installs it from the lockfile it ships (every package pinned and hash-checked, no install scripts, no Codex binary) into `~/.claude/via/acp/`.
- A running agent's latest step shows in its row of the agent panel; your own `subagentStatusLine` setting, if you have one, takes precedence and hides it.
- The harness's session id is kept, so a follow-up continues the same conversation, even after a reload. A `SendMessage` starting `interrupt:` stops the agent's current step and runs the message at once (Codex, OpenCode, pi); a plain one waits for the next turn, or steers pi mid-run.
- A completed answer ends with the model that wrote it, as the harness reports it; one taken from your `model:` line because the harness didn't confirm it is marked `(requested)`, and a harness that won't say gets `model not reported`, never a guess. Stopped or failed runs say so, unsigned, and no Claude model stands in.
- `via` uses each CLI's own login and stores no credentials.

## Permissions

- **Read-only** is what `via` enforces, in plan mode or with `tools: read`: Codex runs in its read-only sandbox with MCP servers and plugins off, OpenCode with only reading tools and no project config, pi with only its reading tools. agy is refused. So is Codex under a project's `.codex` folder and OpenCode under a project's `.opencode`, since both would load code from there before any permission applies.
- **Otherwise** Codex works in its workspace sandbox and asks before going past it, as `codex exec` does; OpenCode, pi and agy run with their own permission settings, as when you run them yourself. A question a harness asks (Codex past its sandbox, OpenCode where its config says `ask`) reaches you in Claude Code's own dialog, with a notification; only "Allow once" or "Deny" is offered, so nothing outlives the run. A dismissed or unanswered question, or a `claude -p` run with nobody to ask, is a deny. In bypass mode its questions are approved; in don't-ask mode, denied. pi and agy never ask.
- The mode is the one at the agent's start, kept across its follow-ups and reloads: switching modes later doesn't change an agent already started.
- Outside read-only, Codex runs with the working folder trusted (`codex-acp` sets it), so a project's `.codex/config.toml` loads, as if you had trusted the project in Codex. Outside a Git repository it edits without the refusal `codex exec` had.

## Set up

1. **Install a harness and sign in to it**: [Codex](https://github.com/openai/codex), [Antigravity CLI](https://github.com/google-antigravity/antigravity-cli), [OpenCode](https://opencode.ai) or [pi](https://pi.dev). Any one is enough. Codex and OpenCode also need [Node](https://nodejs.org) 22.18 or later, with npm.
2. **Install the plugin** in Claude Code:

   ```
   /plugin install via --marketplace SeanLF/claude-code-subagent-harnesses
   ```

3. **Restart Claude Code**, so it sees the harnesses on your PATH. Do the same after installing another harness.

Tested on macOS. `via` is built on Claude Code's plugin hooks API, and CI tests it against the latest Claude Code every week, on macOS and Linux.

## Use

Ask in plain language: "Have codex review src/api".

Optional lines at the top of the prompt configure the harness, one per line, and persist for that agent's later messages:

| Line | Effect |
| --- | --- |
| `model: <model>` | The harness's model, such as `gpt-5.5`, `gemini-3.8-flash`, `opencode/deepseek-v4.1-flash-free` or `openrouter/moonshotai/kimi-k2` |
| `tools: read` | Read-only, whatever the permission mode; see [Permissions](#permissions). pi also takes a tool list: `read` is read-only; any other list, such as `-bash,read`, can still edit and loads the project's .pi extensions |
| `thinking: <level>` | Reasoning effort; a level the harness or model lacks is refused |
| `via-help` | Replies with that harness's lines and levels instead of running it |

```text
tools: read
thinking: high
Why does the login test fail on CI but not locally?
```

## Harnesses

Each can load its own user config and instructions files; agy, for one, reads your global `AGENTS.md`.

| | Notes |
| --- | --- |
| `codex` | An interrupted command can keep running until it finishes. |
| `agy` | Commands run in Antigravity's sandbox, away from credentials such as `~/.kube`; its own file edits are not sandboxed. Its changelog says it leaves background tasks it started, such as dev servers, running after a headless run ends. |
| `opencode` | A read-only run replaces your own `OPENCODE_CONFIG_CONTENT` with `via`'s reading agent. |
| `pi` | Any model pi reaches: API keys, or logins such as ChatGPT, Copilot or OpenRouter (pi's `/login`); `pi --list-models` lists them. On a ChatGPT login it runs pi's own tools, not Codex's sandbox. A read-only tool list also skips the project's `.pi` extensions, even in a project you trusted. |

## Settings

In `/config`, or `pluginConfigs` in `settings.json`:

- `timeoutMinutes` (default 30): a run longer than this is stopped. The answer keeps what the harness wrote and says it was stopped.
- `defaultModel`: pi's model when the prompt has no `model:` line.
- `codexAcp` (default `pinned`): `pinned` runs the `codex-acp` version `via` ships with, its dependencies locked and hash-checked, updated only when `via` is; `latest` installs the newest into `~/.claude/via/acp/latest` once per Claude Code session, its dependencies unpinned.

## Develop

`mise install && pnpm install`, then `pnpm test` and `pnpm validate`, which CI runs too; both need the `claude` CLI. `pnpm typecheck` needs the engine's typings, which a logged-in Claude Code session writes to `.claude-plugin/types/`. After changing `relay/src/` or the SDK version, run `pnpm build:relay`: `relay/relay.mjs` is the committed bundle the plugin runs, and CI fails when it doesn't match. `relay/codex-acp/` is the lockfile `via` installs from. `relay/checks/` holds the live checks used to verify each ACP agent.

## Credit

Inspired by [pi-agent-for-claude](https://github.com/FazalAAli/pi-agent-for-claude) by Fazal Ali. [claudexor](https://github.com/razzant/claudexor)'s Antigravity adapter was prior art for `via:agy`. The relay bundles the [ACP TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk) (Apache-2.0) and zod (MIT); see `relay/THIRD_PARTY_LICENSES`. MIT licence.
