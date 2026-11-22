# Contributing

`mise install && pnpm install`, then `pnpm lint` (Biome), `pnpm test` and `pnpm validate`. CI runs all three; the last two need the `claude` CLI. `pnpm typecheck` needs the typings a logged-in Claude Code session writes to `.claude-plugin/types/`.

- Codex and OpenCode run over [ACP](https://agentclientprotocol.com) (Agent Client Protocol, a standard way to drive coding agents) through `relay/relay.mjs`, a committed bundle. Run `pnpm build:relay` after changing `relay/src/` or the SDK version; CI fails when the bundle doesn't match.
- `relay/codex-acp/` is the lockfile `codex-acp` installs from (`npm ci --ignore-scripts`); `hooks/install.ts` does the install.
- `hooks/acp/` is the generic ACP client; `pnpm lint` fails if it imports anything of `via`'s.
- `hooks/record.ts` keeps one record per agent in `$.store`, so an agent continued in a new process still has its session, mode and last answer.
- `hooks/writer.ts` writes a run's steps, for `via` agents and their nested ones.
- Harness tool calls reach Claude Code as calls to the MCP tool `step`, which runs nothing: `via` answers each with what the harness reported, and refuses a `step` call it didn't make.
- A harness's question to the person (ACP elicitation) is a `step` call too, which `via` lets through to the step server (`mcp/step.mts`): it asks the question as an MCP elicitation, so Claude Code shows its own form, and the reply goes back to the harness through the inbox.
- A collapsed group containing only `step` calls keeps one counted summary line, including failed and interrupted calls. Wait continuations count with their original command; ctrl+o keeps the native expanded view. Mixed groups and groups with other rows keep native rendering.
- Nested agents need the harness to report subagents over ACP ([subagents RFD](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/rfds/subagents.mdx)); `codex-acp` does.
- A nested agent's task is its Agent call's prompt, and a later message to it while it works is a row in its view, both from the RFD's `session_message`; a message to the `via` agent itself is a row in its own view. A message is said once its session moves on (another update of it) or the prompt ends, so its later upserts and chunks count, and a sender's view waits until it names its recipient. A nested agent shows once it has its task, or once it works, so a title or role announced after its task is not shown. `codex-acp` sends these messages for Codex's v1 subagent tools. The model picks the version, whatever `multi_agent` says, and the v2 tools send no text (openai/codex#61750): gpt-6-luna on codex-cli 0.169.0 picked v2, so its nested agent got its title.
- `pnpm test:relay` tests the relay against a fake agent; against testy, ACP's reference agent (`relay/test/testy.test.mts`; `cargo build --manifest-path ci/testy/Cargo.toml --target-dir ~/.cache/via/testy`, outside the plugin's folder, as `claude plugin eval` refuses Cargo's hard links); and the real codex-acp and `opencode acp` against a fake model (`relay/test/real-*.test.mts`). The testy and harness tests skip when their binary isn't there, and all run in CI's `harnesses` job. `relay/checks/` holds the live checks, which spend tokens.

## Tests

- TypeScript, type-checked with the code (CI too); fixtures typed against the ACP SDK.
- A test waits on the event it needs: a model request, a line the relay prints, a notification, a file the command under test writes in one step. Never on time. Each wait fails when the process it waits on ends. The only timers are backstops that end a hung run: `relay/test/support/backstop.mts`, a spawned process's `timeout`, a test's `timeout`.
- A test checks behaviour where it crosses a boundary: what the relay prints, what a harness or model receives, what Claude reads. Not internal shapes.
- A new test fails without the change it covers. Show it before committing.
- No tokens and nothing of yours: the fake agent, the fake model and an empty HOME, no network beyond localhost. What only a real model can show goes in an eval (`evals/`, `pnpm eval`), with a cost cap.
- A version a test depends on lives where Dependabot bumps it.
- `pnpm lint` holds every test in the repository to the first two (`checks/tests.mts`).
