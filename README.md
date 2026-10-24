# pi

A Claude Code plugin that adds a `pi:general-purpose` subagent type whose model steps run the [pi](https://pi.dev) CLI. Pi agents show in the agent list, stream live (text, thinking and a `▸ tool: args` line per tool pi runs) and take follow-ups, which continue the same pi session. Usage is reported under pi's own model, and every answer ends with `— answered by pi, <provider/model>`, read from pi's events.

Needs Claude Code 2.1.309 or newer and `pi`, signed in to a provider, on PATH. If pi is missing or fails, the answer says so; no Claude model stands in.

pi runs its own read, bash, edit and write tools outside Claude Code's permission prompts and classifier: a pi agent can change files without asking. To keep it read-only, put `pi-tools: read` at the top of the prompt.

## Install

In a Claude Code session:

```
/plugin install pi --marketplace SeanLF/claude-code-pi
```

Answer `y` to add the marketplace, then pick a scope. To run a local checkout instead, start Claude Code with `--plugin-dir /path/to/claude-code-pi`.

## Use

Ask for pi in plain language: "Have pi review the error handling in src/api."

A message to a running pi agent (for example, a `SendMessage`) reaches it at pi's next step. A message to an idle pi agent is a follow-up, as before.

### Prompt lines

Prompt lines go at the top of the prompt, one per line, before the task. A `pi-` line further down is ordinary text.

| Line | Effect |
| --- | --- |
| `pi-model: <pattern>` | Passed to `pi --model`. `pi --list-models <search>` lists patterns. |
| `pi-tools: <list>` | Passed to `pi --tools`, such as `read` for a read-only second opinion. |
| `pi-thinking: <level>` | Passed to `pi --thinking`: one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, the same as a `:<level>` suffix on the model. |

Each line holds for that agent's later messages until a new line replaces it. A malformed or unknown line is answered with the line instead of running pi. Put `pi-help` alone on the top line to get this syntax back from the agent instead of running pi.

```text
pi-model: openrouter/moonshotai/kimi-k2
pi-thinking: high
Review the error handling in src/api.
```

Not in v0: pi as an agent-team teammate. A hooks module has no documented way to learn its process's agent type.

## Settings

Set these in `/config`, or in `settings.json` under `pluginConfigs`, keyed by the plugin (`pi` when loaded with `--plugin-dir`).

- `defaultModel`: passed to `pi --model` when a prompt has no `pi-model` line. Empty means pi's own default (`defaultModel` in `~/.pi/agent/settings.json`).
- `timeoutMinutes`: default 30. A pi run longer than this is stopped. The answer keeps what pi wrote, plus a line saying it was stopped; it is unsigned.

Model precedence: a `pi-model` line, then `defaultModel`, then pi's own default.

## Credit

Design inspired by [pi-agent-for-claude](https://github.com/FazalAAli/pi-agent-for-claude) by Fazal Ali.
