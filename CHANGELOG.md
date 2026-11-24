# Changelog

## [0.11.0](https://github.com/SeanLF/claude-code-subagent-harnesses/compare/via-v0.10.0...via-v0.11.0) (2026-11-24)


### Features

* **via:** a harness's question is asked in Claude Code's question dialog, and can go to the main agent ([194febf](https://github.com/SeanLF/claude-code-subagent-harnesses/commit/194febf28b760e47f81369cdc8bc06f9ee6a281f))
* **via:** a new harness session is named after its via agent, where the agent can retitle one ([7b0509f](https://github.com/SeanLF/claude-code-subagent-harnesses/commit/7b0509fda40ed5c49faeaddecbf117b8b6a83b86))
* **via:** agy runs over ACP, through the relay Codex and OpenCode use ([babca6c](https://github.com/SeanLF/claude-code-subagent-harnesses/commit/babca6c216ccebc81165f96ac9c1c9ec74b7646c))
* **via:** VIA_TRACE writes a trace of each relay run; Biome holds tests to the Tests bar ([8e3d06c](https://github.com/SeanLF/claude-code-subagent-harnesses/commit/8e3d06c123a4040f55234abdf69ddbf35f990e7b))


### Bug Fixes

* deliver child completions during parent tools ([#27](https://github.com/SeanLF/claude-code-subagent-harnesses/issues/27)) ([47b0b1d](https://github.com/SeanLF/claude-code-subagent-harnesses/commit/47b0b1d37cd970d307c21f566ae16adc66aef5b3))
* **via:** a group of via steps is one counted line from its first call, so it no longer changes height ([f360498](https://github.com/SeanLF/claude-code-subagent-harnesses/commit/f360498ec54f13c6cea36cb1111934c5a9256fcd))
* **via:** a harness command longer than ten seconds is reported, not denied ([ba3f25d](https://github.com/SeanLF/claude-code-subagent-harnesses/commit/ba3f25d7ff0a4c10f9e0d86541600b47d361a99f))
* **via:** a long Codex question shows whole, not cut at its field's title ([7f36eee](https://github.com/SeanLF/claude-code-subagent-harnesses/commit/7f36eeef664e8b612ec6a375ea6bf3621d79a507))
* **via:** an image path in a prompt is checked and read through one open file ([0934cac](https://github.com/SeanLF/claude-code-subagent-harnesses/commit/0934cac55846d40df8d22363c153ca059e7ccd2b))
* **via:** an interrupt stops the commands of the step it cuts off ([#58](https://github.com/SeanLF/claude-code-subagent-harnesses/issues/58)) ([5838e5a](https://github.com/SeanLF/claude-code-subagent-harnesses/commit/5838e5ab1447bfae3d47d23368e1b43abe73d0f5))
* **via:** Codex runs on codex-acp 2.10.0; CI tests Codex 0.172.0 and OpenCode 2.4.1 ([4fc914b](https://github.com/SeanLF/claude-code-subagent-harnesses/commit/4fc914b634e1df2b3e34ee7b1cd70e42926b56e6))
* **via:** Codex runs on codex-acp 2.9.0, the relay on ACP SDK 2.9.1 ([4ae5300](https://github.com/SeanLF/claude-code-subagent-harnesses/commit/4ae5300be03a8a1632ea0f7117615d0d749279d9))

## [0.10.0](https://github.com/SeanLF/claude-code-subagent-harnesses/compare/via-v0.9.0...via-v0.10.0) (2026-11-17)


### Features

* **via:** a config line sets a harness's own session option, such as Codex's fast mode ([dc3e2aa](https://github.com/SeanLF/claude-code-subagent-harnesses/commit/dc3e2aa0f24e73165dba5d3f40024e700dfbad7e))
* **via:** a harness's questions reach you in Claude Code's own form ([4fad16c](https://github.com/SeanLF/claude-code-subagent-harnesses/commit/4fad16cf569a221fae3520c8d9e995e46bfdd151))
* **via:** Codex runs with full access in bypass mode, as Claude Code itself does ([c2c4466](https://github.com/SeanLF/claude-code-subagent-harnesses/commit/c2c446632585bf40df8367a4b1d51815b9102719))
* **via:** nested agents show thinking and plan updates, through the shared step writer ([#54](https://github.com/SeanLF/claude-code-subagent-harnesses/issues/54)) ([e0c5751](https://github.com/SeanLF/claude-code-subagent-harnesses/commit/e0c5751567f16f54e2a0f0ab10a2855df9f94601))


### Bug Fixes

* **via:** a Codex subagent's task is its nested agent's prompt; a follow-up while it works is a row in its view ([761c3e0](https://github.com/SeanLF/claude-code-subagent-harnesses/commit/761c3e09714d7ed479429cbd0a56842c4969c0c9))
* **via:** a config line sets only options that tune the model, refusing the rest ([c8144fd](https://github.com/SeanLF/claude-code-subagent-harnesses/commit/c8144fd9df435b1003e5d772a195738c8dee95ec))
* **via:** a harness's images, audio, resources and links reach Claude as Claude Code words them ([e4f36d4](https://github.com/SeanLF/claude-code-subagent-harnesses/commit/e4f36d440e47f02f08ca40ee5b0911e465237a13))
* **via:** a harness's warning follows its answer, apart from it, not inside it ([828d81d](https://github.com/SeanLF/claude-code-subagent-harnesses/commit/828d81de8b3bb0e3d724ab6dfe77369f0010d499))
* **via:** a message to a subagent is said once it is whole, and its images are saved ([3e6f348](https://github.com/SeanLF/claude-code-subagent-harnesses/commit/3e6f348bf8086673f939d2f90647dc8cb5144b6a))
* **via:** a refused config line on an agent with no model-tuning options says so ([6b6cad5](https://github.com/SeanLF/claude-code-subagent-harnesses/commit/6b6cad533eac3a2cc78b5cc35e1271803ee5018e))
* **via:** a refused model, mode or config option keeps the harness's reason ([db3de22](https://github.com/SeanLF/claude-code-subagent-harnesses/commit/db3de22347ed7115982ab440e4b17796bfd919ef))
* **via:** a refused or limit-stopped ACP run says so instead of signing ([#53](https://github.com/SeanLF/claude-code-subagent-harnesses/issues/53)) ([7625232](https://github.com/SeanLF/claude-code-subagent-harnesses/commit/7625232bc607668707df81b55a746641a9245db4))
* **via:** a run that ends or is stopped closes its ACP session, for an agent that can close one ([f4a2655](https://github.com/SeanLF/claude-code-subagent-harnesses/commit/f4a2655c094a02667a66e8f4771f63b48e968c79))
* **via:** agy's tool steps are calls to the step tool, with their output; the dead status line goes ([d243076](https://github.com/SeanLF/claude-code-subagent-harnesses/commit/d24307612c56b6bef407b4121c524d8e24ad4efa))
* **via:** an auto-mode agent hands back what via says before running it ([daa3e84](https://github.com/SeanLF/claude-code-subagent-harnesses/commit/daa3e848493cf4808551fbe93d9f4835eb2f323d))
* **via:** Codex and OpenCode take the thinking levels each model offers, not via's lists ([12b8927](https://github.com/SeanLF/claude-code-subagent-harnesses/commit/12b8927f408d04397c8ce4e0e294f02981e31e46))
* **via:** Codex runs on codex-acp 2.7.0, not its preview ([3978d2e](https://github.com/SeanLF/claude-code-subagent-harnesses/commit/3978d2e4aa7226ce0dd90eda611834e8e503c5ea))
* **via:** hooks describe the harness types they read; a check keeps those copies honest ([#55](https://github.com/SeanLF/claude-code-subagent-harnesses/issues/55)) ([809b869](https://github.com/SeanLF/claude-code-subagent-harnesses/commit/809b8697800c4c8fd3c5fc17b091d701acaa518f))

## [0.9.0](https://github.com/SeanLF/claude-code-subagent-harnesses/compare/via-v0.8.1...via-v0.9.0) (2026-11-11)


### Bug Fixes

* keep quiet nested agents in via ([#24](https://github.com/SeanLF/claude-code-subagent-harnesses/issues/24)) ([2ad040c](https://github.com/SeanLF/claude-code-subagent-harnesses/commit/2ad040cfe2a47184355a5ae890701dd86b39632c))
* **via:** a nested agent in a new process answers its saved report or the cut-off, never the model ([#46](https://github.com/SeanLF/claude-code-subagent-harnesses/issues/46)) ([26f00a7](https://github.com/SeanLF/claude-code-subagent-harnesses/commit/26f00a740fb99bf9bd0802fb37d2a184a81a278e))
* **via:** an answer said before the run's last call is said again at the end ([#48](https://github.com/SeanLF/claude-code-subagent-harnesses/issues/48)) ([3974216](https://github.com/SeanLF/claude-code-subagent-harnesses/commit/39742165ff8a974349c7921c708218b8a147eeec))


### Code Refactoring

* **via:** one stored record per agent, one replay path, one step writer ([#49](https://github.com/SeanLF/claude-code-subagent-harnesses/issues/49)) ([d40e327](https://github.com/SeanLF/claude-code-subagent-harnesses/commit/d40e327836668f7800a6d563a9ef29407de68500))

## [0.8.1](https://github.com/SeanLF/claude-code-subagent-harnesses/compare/via-v0.8.0...via-v0.8.1) (2026-11-02)


### Bug Fixes

* **via:** a step's and a nested child's waits run as bounded engine nouns ([#41](https://github.com/SeanLF/claude-code-subagent-harnesses/issues/41)) ([c088c91](https://github.com/SeanLF/claude-code-subagent-harnesses/commit/c088c914619150573cf6794dd019fa85e368277a))

## [0.8.0](https://github.com/SeanLF/claude-code-subagent-harnesses/compare/via-v0.7.0...via-v0.8.0) (2026-10-28)


### Features

* a harness's own subagents show as agents nested under the via agent ([b612672](https://github.com/SeanLF/claude-code-subagent-harnesses/commit/b61267254ade8c88b00cb845272efeb0c03eca3e))


### Bug Fixes

* a message typed into a running via agent's view reaches its harness ([118f9e2](https://github.com/SeanLF/claude-code-subagent-harnesses/commit/118f9e261fe7f6977e4f94fed3502d47011f8d10))
* via agents survive a session sent to the background, and a refused model gets a did-you-mean ([a83205c](https://github.com/SeanLF/claude-code-subagent-harnesses/commit/a83205ce420810306541c2e20d6a35aa0d269bde))

## [0.7.0](https://github.com/SeanLF/claude-code-subagent-harnesses/compare/via-v0.6.0...via-v0.7.0) (2026-10-26)


### Features

* via agents run as the harness's model, show its compactions, and list the models it offers ([de199ef](https://github.com/SeanLF/claude-code-subagent-harnesses/commit/de199efbbd98980866159b3953c91707a0737efb))

## [0.6.0](https://github.com/SeanLF/claude-code-subagent-harnesses/compare/via-v0.5.1...via-v0.6.0) (2026-10-26)


### Features

* pi subagents show native tool rows, diffs and command output ([7e78f3c](https://github.com/SeanLF/claude-code-subagent-harnesses/commit/7e78f3c32965654720d0142b9cc298485b14c128))

## [0.5.1](https://github.com/SeanLF/claude-code-subagent-harnesses/compare/via-v0.5.0...via-v0.5.1) (2026-10-26)


### Bug Fixes

* Esc on a via agent stops its harness, not only the wait ([3ccfd8a](https://github.com/SeanLF/claude-code-subagent-harnesses/commit/3ccfd8a7e393cc2006191e2a22af352ef940f593)), closes [#9](https://github.com/SeanLF/claude-code-subagent-harnesses/issues/9)
* the relay declares no plan capability, so a Codex markdown plan shows as text ([f97a9b7](https://github.com/SeanLF/claude-code-subagent-harnesses/commit/f97a9b741d98d7620635b247763c0cdd741d4ce7)), closes [#13](https://github.com/SeanLF/claude-code-subagent-harnesses/issues/13)

## [0.5.0](https://github.com/SeanLF/claude-code-subagent-harnesses/compare/via-v0.4.1...via-v0.5.0) (2026-10-25)


### Features

* harness tool calls fold into one line, as Claude Code folds its own ([1bebbab](https://github.com/SeanLF/claude-code-subagent-harnesses/commit/1bebbab001b9258a6b866892c09c4282a3705677))

## [0.4.1](https://github.com/SeanLF/claude-code-subagent-harnesses/compare/via-v0.4.0...via-v0.4.1) (2026-10-25)


### Bug Fixes

* via agents work in team mode, and the ACP parser is typed against the SDK and skips malformed content ([2253f86](https://github.com/SeanLF/claude-code-subagent-harnesses/commit/2253f86dbe2e62be0f1f785f4ae9c91f7b6f0252))

## [0.4.0](https://github.com/SeanLF/claude-code-subagent-harnesses/compare/via-v0.3.0...via-v0.4.0) (2026-10-25)


### Features

* Codex and OpenCode subagents show native tool rows, Claude Code's own summary, command output, diffs and images ([c36a2e0](https://github.com/SeanLF/claude-code-subagent-harnesses/commit/c36a2e0ecc1c5fd58b2d5c22ddb2212890a39883))

## [0.3.0](https://github.com/SeanLF/claude-code-subagent-harnesses/compare/via-v0.2.1...via-v0.3.0) (2026-10-24)


### Features

* a message to a running Codex or OpenCode agent reaches it at its next step ([230327b](https://github.com/SeanLF/claude-code-subagent-harnesses/commit/230327b48dc7928bb2608898991269fc3113d5e3))

## [0.2.1](https://github.com/SeanLF/claude-code-subagent-harnesses/compare/via-v0.2.0...via-v0.2.1) (2026-10-24)


### Bug Fixes

* via-help, agent descriptions and SendMessage say Codex and OpenCode read a message after their current answer, not mid-run ([0a8282f](https://github.com/SeanLF/claude-code-subagent-harnesses/commit/0a8282f87b64d10a37ee959d83eb60a47c37fd7e))

## [0.2.0](https://github.com/SeanLF/claude-code-subagent-harnesses/compare/via-v0.1.0...via-v0.2.0) (2026-10-24)


### Features

* via runs Codex, Antigravity, OpenCode and pi as native Claude Code subagents ([7d5568d](https://github.com/SeanLF/claude-code-subagent-harnesses/commit/7d5568dfb394903fd13f9034f7c4ce278b64bbc1))
