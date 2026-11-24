<img src=".claude-plugin/icon.png" alt="via's icon: a hermit crab peeking out of its shell" width="96">

# via

Keep Claude Code as the lead and hand the work to Codex, Gemini (Antigravity), OpenCode or pi, as native Claude Code subagents on your own login. Their steps cost no Claude tokens, and only their answer comes back into Claude's context. You can follow up or steer them like any other subagent.

I wanted to keep Claude Code as my main tool but use my other subscriptions instead of paying for more Claude tokens. I was tired of Claude running `codex` from Bash with no way to see what it was doing. Everything else I found either swapped Claude's model or read another terminal's screen, which wastes tokens. ACP turned out to be the right way to talk to the other CLIs, so via makes them real Claude Code subagents.

![A via:codex agent in Claude Code, its steps folded into lines such as "Ran 4 commands"](https://github.com/user-attachments/assets/e36113c3-b375-4f0d-99ae-5851e73105e9)

A harness's steps fold into one line, such as "Ran 3 commands, 1 failed"; ctrl+o shows each step and its output.

## Set up

`/plugin install via --marketplace SeanLF/claude-code-subagent-harnesses` in Claude Code, or from a shell:

```
claude plugin install via --marketplace SeanLF/claude-code-subagent-harnesses
```

Needs Node 22.18 or later on PATH; Codex also needs npm. Install at least one harness: [Codex](https://github.com/openai/codex), [Antigravity CLI](https://github.com/google-antigravity/antigravity-cli), [OpenCode](https://opencode.ai) or [pi](https://pi.dev). Your agent can run the installs; signing in opens a browser, so that part is yours. Restart Claude Code afterwards, and again after adding another harness, so it sees what's on your PATH. Tested on macOS, CI also runs on Linux; Windows is untested.

## Who it's for

Claude Code users who want Claude to plan and lead while cheaper models do the work: on a ChatGPT or Google plan, OpenCode's free models, or any provider through pi. Also for a second model's review, without switching windows.

Codex and the Antigravity CLI (`agy`) are OpenAI's and Google's own tools, so you sign in to them directly. Google has [suspended accounts](https://discuss.ai.google.dev/t/paid-pro-subscriber-banned-instantly-for-testing-opencode-oauth/124403) whose Google login was used through third-party tools, though it later said it was lifting those bans. `via` stores no credentials, and no Claude subagent sits in between: the harness's work costs no Claude tokens; Claude only writes the task and reads the answer.

Not for you if:

- Claude Code isn't your main window: use a harness that switches models itself (OpenCode, pi, Cursor).
- You want Claude Code itself to run on another model: [claude-code-router](https://github.com/musistudio/claude-code-router).

Pairs with OpenAI's [codex-plugin-cc](https://github.com/openai/codex-plugin-cc) if you want its review commands, a review before Claude stops, or to move a session into Codex.

## What I've used it for

- Codex, to spend my ChatGPT plan too: a TypeScript migration one slice per agent, refactors, mutation testing.
- Free models for small tasks, on OpenCode's free tier or OpenRouter through pi.
- A review by a model that didn't write the code.
- The same fix on two models, to see which one is good enough.

> [!IMPORTANT]
> - Each harness runs its own tools as you, with its own permission settings, outside Claude Code's. The one thing `via` enforces is read-only: plan mode, or `tools: read` at the top of the prompt. Codex, OpenCode and pi then can't write. agy has no read-only mode, so `via` won't run it in one.
> - Outside read-only, a repository's `.codex`, `.opencode` and `.pi` config loads, as if you had trusted it. In a repository you didn't write, use `tools: read`. Codex and OpenCode then won't run at all in a repository that has its own `.codex` or `.opencode` folder.
> - pi and OpenCode are third-party clients. A subscription login there is subject to that provider's rules for third-party clients.

## Use

Ask in plain language: "Have codex review src/api". Optional lines at the top of the prompt set options. They carry over to that agent's follow-ups.

| Line | Effect |
| --- | --- |
| `model: <model>` | The harness's model |
| `tools: read` | Read-only, whatever the permission mode |
| `thinking: <level>` | Reasoning effort; a level the harness or model doesn't have is refused |
| `config: <option>=<value>` | Codex and OpenCode: one of the harness's own options that tune its model, such as `fast-mode=on`; one per line, `fast-mode=` drops it. Never a mode or sandbox option, and none in a read-only run |
| `via-help` | Lists the harness's options instead of running it |

A message to a running Codex, OpenCode, agy or pi agent reaches it at its next step; `interrupt:` first stops the current step. That holds for Claude's SendMessage; one you type into the agent's view waits in Claude Code until the current step ends, so it can't cut a long command short. A harness's own question for you (ACP elicitation, such as Codex's questions in its plan mode) shows in Claude Code's question dialog, whole; type under "Other" for your own text. An agent in the background adds "Let Claude answer": picking it, your `askUserQuestionTimeout` passing (`via` times it, from when the dialog opens), or a `claude -p` run sends the question to the main agent, whose SendMessage back is the answer rather than a steer, until the harness withdraws the question. A foreground agent can't: the main agent would hear only once its turn ends. A link to open, or a form the dialog can't show, uses Claude Code's form instead. A completed answer ends with the model the harness reports; one only taken from your `model:` line says `(requested)`, and a harness that won't say gets `model not reported`.

## Permissions

- **Read-only:** Codex runs in its read-only sandbox with MCP servers and plugins off; OpenCode and pi get reading tools only.
- **Bypass mode:** Codex runs with full access, no sandbox, as Claude Code itself does in bypass: its commands reach any file and the network.
- **Otherwise:** Codex works in its workspace sandbox and asks before going past it; OpenCode, pi and agy use their own permission settings. Codex also edits outside a Git repository.
- A harness's question (Codex past its sandbox, OpenCode where its config says `ask`, agy under `request-review` or `strict`) shows in Claude Code's dialog with only a one-time allow and a deny. There's no "always allow", so no approval outlives the run. No answer, or `claude -p`, is a deny. Bypass mode approves; don't-ask mode denies. The mode is set when the agent starts; a follow-up to an agent that finished takes the current one. pi never asks.
- When a harness starts its own subagent, `via` approves that call without asking you.

## Harnesses

Each loads its own user config and instructions files (agy reads your global `AGENTS.md`).

- `codex`: an interrupted command keeps running until the run ends. A subagent's task shows as its nested agent's prompt only with Codex's v1 subagent tools. Codex lets the model pick, and gpt-6-luna picks the v2 tools. These [send no task text](https://github.com/openai/codex/issues/61750), so the nested agent gets its title instead.
- `agy`: commands run in Antigravity's sandbox, away from credentials such as `~/.kube`; its own file edits are not sandboxed. A command that runs past 10 seconds goes to the background, and agy waits for it before it answers; if it ends its turn first, the answer names the command. `thinking:` takes low, medium or high, for Gemini models only.
- `opencode`: a read-only run replaces your own `OPENCODE_CONFIG_CONTENT`. An OpenCode background service that starts while a `via` OpenCode agent is working resumes the agent's turn as if it had died, so the turn runs twice ([anomalyco/opencode#51213](https://github.com/anomalyco/opencode/issues/51213)). Opening `opencode` starts one when none is running, and replaces one of another version, as after an upgrade. Start it (`opencode service start`, or `restart` after an upgrade) while no `via` agent is working.
- `pi`: any model pi reaches by API key or `/login`. On a ChatGPT login it runs pi's own tools, not Codex's sandbox. `tools:` takes a pi tool list: one of only `read`, `grep`, `find`, `ls` is read-only and skips the project's `.pi` extensions, even in a project you trusted; any other, such as `-bash,read`, can edit and loads them.

## Settings

In `/config`, or `pluginConfigs` in `settings.json`:

- `timeoutMinutes` (default 30): a longer run is stopped; its partial output is kept.
- `defaultModel`: pi's model when the prompt has no `model:` line.
- `codexAcp` (default `pinned`): `pinned` installs Codex's adapter from the lockfile `via` ships, hash-checked, no install scripts. `latest` installs the newest once per Claude Code session.

Claude Code doesn't know a harness model's context size and would stop a `via` agent at 200k tokens. While a Claude model is the main one, `via` raises `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, which only applies to models Claude Code doesn't know; any other non-Claude agent in the session gets the same window. A value you set is left alone, and `via` removes its own when `/model` switches to a non-Claude model.

## Develop

`mise install && pnpm install`, then `pnpm lint`, `pnpm test` and `pnpm validate`; see [CONTRIBUTING.md](CONTRIBUTING.md). Harness tool calls show in transcripts as calls to `via`'s `step` tool.

## Credit

Inspired by [pi-agent-for-claude](https://github.com/FazalAAli/pi-agent-for-claude) by Fazal Ali. [claudexor](https://github.com/razzant/claudexor)'s Antigravity adapter was prior art for `via:agy`. The relay bundles the [ACP TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk) (Apache-2.0) and zod (MIT); see `relay/THIRD_PARTY_LICENSES`. MIT licence.
