# opencode — Architecture Map (for building a LEAN agent framework)

> Repo root analyzed: `/home/user/projects/agent-prereq/repos/opencode`
> Language: TypeScript, Bun monorepo (Effect-TS heavy). All paths below are relative to the repo root.

## Orientation: two implementations live side-by-side

There are effectively **two stacks** in this monorepo:

- **`packages/opencode/src/`** — the live, shipped agent. This is what the CLI/TUI/server actually run. The session/turn loop, tool registry, permissions, compaction all live here. **This doc focuses here.**
- **`packages/llm/`, `packages/core/`** — a newer, in-progress refactor. `packages/llm` has a hand-rolled provider protocol layer (`packages/llm/src/protocols/anthropic-messages.ts`, `openai-chat.ts`, `gemini.ts`, etc.) used by the experimental "native runtime". `packages/core` holds the v1/v2 schemas, DB, and shared services that `packages/opencode` imports as `@opencode-ai/core/*`.

The whole thing is built on **Effect** (structured concurrency, layers, typed errors). Services are `Context.Service` classes wired via `LayerNode`. If you are building lean, you can keep the *ideas* and drop Effect entirely — the architecture maps cleanly onto plain async/await.

---

## TL;DR (5 bullets)

- **The agent loop is a `while(true)` in `runLoop`** (`packages/opencode/src/session/prompt.ts:1081`). Each iteration: load+compact message history → pick agent/model → resolve tools → call `processor.process(...)` → the processor streams one provider turn and **executes tools inline via the AI SDK** → loop decides `break`/`continue`/`compact`. Tool *dispatch* is delegated to Vercel's AI SDK `streamText`, not hand-rolled.
- **Tools are Effect-returning definitions** (`packages/opencode/src/tool/tool.ts:55`) with an Effect `Schema` for params; the registry (`tool/registry.ts:82`) collects ~15 builtins + plugin/MCP tools, then `session/tools.ts:39` wraps each into an AI SDK `tool({...})` whose `execute` runs the Effect, fires `plugin` hooks, and performs the permission `ask`.
- **Permissions are a rule-list `evaluate()`** (`permission/index.ts:28`): last-matching wildcard rule wins, action ∈ `allow|ask|deny`. `ask` blocks on a `Deferred` until the UI replies. Bash is gated by **tree-sitter parsing** the command into sub-commands (`tool/shell.ts:257`) and asking per extracted pattern.
- **System prompt is assembled at request time** in `session/llm/request.ts:56`: `[agent.prompt OR model-specific prompt] + environment + AGENTS.md/CLAUDE.md instructions + MCP instructions + skills`. Model-specific prompt picked by substring match on model id (`session/system.ts:26`).
- **plan vs build are just two `Agent.Info` permission presets** (`agent/agent.ts:140-181`): `build` allows everything; `plan` sets `edit: deny` (except plan files) + `plan_exit: allow`. Subagents (`general`, `explore`) are the same struct with `mode:"subagent"`, invoked through the `task` tool which spawns a **child session** and runs the same loop recursively.

---

## 1. Entry point → AGENT LOOP

**Anchors:** `packages/opencode/src/session/prompt.ts:1081` (`runLoop`), `:1342` (`loop`), `:1052` (`prompt`), `packages/opencode/src/session/processor.ts:625` (`process`), `:276` (`handleEvent`), `:633-680` (stream + retry + cleanup). Entry: `packages/opencode/src/index.ts:1` (yargs CLI) → `cli/cmd/run.ts` → `SessionPrompt.prompt`.

### Shape of the loop

`prompt()` creates the user message, then calls `loop()`, which wraps `runLoop()` in `SessionRunState.ensureRunning` (`session/run-state.ts:88`) — the **concurrency guard** that makes a session single-flight and cancellable (a second prompt on a busy session errors; `cancel` interrupts the running fiber).

`runLoop` is the canonical artifact — a manual `while (true)` that re-derives state from persisted messages each turn rather than holding it in memory. Key steps per iteration:

1. `MessageV2.filterCompactedEffect(sessionID)` — load history, dropping messages hidden by prior compactions.
2. `MessageV2.latest(msgs)` (`message-v2.ts:585`) — find last user / last assistant / last *finished* assistant / pending `tasks` (subtask & compaction parts not yet processed). Binding is by **max monotonic id**, not array order, because `filterCompacted` reorders.
3. **Exit condition:** if the last assistant `finish` is a terminal reason (not `tool-calls`) AND there are no un-executed tool calls AND it's newer than the last user message → `break`.
4. Dispatch pending `tasks`: a `subtask` part → `handleSubtask` (runs the `task` tool, i.e. a sub-agent); a `compaction` part → `compaction.process`.
5. Auto-compact if the last finished turn overflowed the context window.
6. Apply reminders (`SessionReminders.apply`), build the assistant message, create a `processor` handle, resolve tools, assemble the system prompt, then `handle.process({...})`.
7. Inspect the result: capture `StructuredOutput` and break; surface `content-filter` as an error; `"stop"` → break; `"compact"` → enqueue compaction; else `continue`.

```ts
// packages/opencode/src/session/prompt.ts:1088 (trimmed)
while (true) {
  yield* status.set(sessionID, { type: "busy" })
  let msgs = yield* MessageV2.filterCompactedEffect(sessionID)...
  const { user: lastUser, assistant: lastAssistant, finished: lastFinished, tasks } = MessageV2.latest(msgs)
  const hasToolCalls = lastAssistantMsg?.parts.some(
    (part) => part.type === "tool" && !part.metadata?.providerExecuted && !isOrphanedInterruptedTool(part)) ?? false
  if (lastAssistant?.finish && !["tool-calls"].includes(lastAssistant.finish)
      && !hasToolCalls && lastUser.id < lastAssistant.id) break          // ← stop condition
  const model = yield* getModel(lastUser.model.providerID, lastUser.model.modelID, sessionID)
  const task = tasks.pop()
  if (task?.type === "subtask")    { yield* handleSubtask({...}); continue }
  if (task?.type === "compaction") { ... ; continue }
  const handle = yield* processor.create({ assistantMessage: msg, sessionID, model })
  const result = yield* handle.process({ user: lastUser, agent, system, messages: [...modelMsgs], tools, model })
  if (result === "stop") break
  if (result === "compact") yield* compaction.create({...})
  continue
}
```

### Inside one turn: `SessionProcessor.process`

`process` (`processor.ts:625`) opens **one** provider stream `llm.stream(streamInput)` and drains it through `handleEvent` (`processor.ts:276`), a switch over `LLMEvent` types: `text-start/delta/end`, `reasoning-*`, `tool-input-*`, `tool-call`, `tool-result`, `tool-error`, `step-start/finish`, `finish`. Crucially **tools execute inside the AI SDK's `streamText`** (the `execute` callback on each tool), so the processor *observes* `tool-call`/`tool-result` events rather than dispatching them. The stream is `Stream.takeUntil(() => ctx.needsCompaction)`, wrapped in `SessionRetry.policy` and `Effect.ensuring(cleanup())`. Doom-loop protection: 3 identical consecutive tool calls trigger a `doom_loop` permission ask (`processor.ts:354-378`).

---

## 2. TOOL SYSTEM

**Anchors:** `tool/tool.ts:55` (`Def` interface), `:99` (`wrap` — schema decode + truncate), `:151` (`define`); `tool/registry.ts:197-238` (builtin list); `session/tools.ts:89-130` (AI-SDK wrapping + permission/plugin); `tool/json-schema.ts`, `tool/truncate.ts`.

### Definition

A tool is a `Tool.Def`: `{ id, description, parameters (Effect Schema), jsonSchema?, execute(args, ctx) => Effect<ExecuteResult> }`. `ExecuteResult = { title, metadata, output: string, attachments? }`. Tools are declared with `Tool.define(id, Effect.gen(...))` so they can pull their own service dependencies at init time.

`wrap` (`tool/tool.ts:113`) decorates every `execute`: it **decodes args against the schema** (failure → `InvalidArgumentsError` whose `message` getter is fed back to the model as the tool result — the canonical "rewrite your input" loop), runs the tool, then auto-**truncates** large output to a temp file unless the tool already set `metadata.truncated`.

```ts
// packages/opencode/src/tool/tool.ts:113 (trimmed)
toolInfo.execute = (args, ctx) => Effect.gen(function* () {
  const decoded = yield* decode(args).pipe(Effect.mapError((error) =>
    new InvalidArgumentsError({ tool: id, detail: ... })))         // schema gate
  const result = yield* execute(decoded, ctx)
  if (result.metadata.truncated !== undefined) return result
  const truncated = yield* truncate.output(result.output, {}, yield* agents.get(ctx.agent))
  return { ...result, output: truncated.content, metadata: {...} } // auto-truncate
}).pipe(Effect.orDie, Effect.withSpan("Tool.execute", ...))
```

### Registration & description to the model

`ToolRegistry` (`registry.ts:82`) builds the builtin list once, plus loads custom tools from `tool/*.{js,ts}` files and plugins (`fromPlugin`, accepting Zod or JSON-Schema args). `tools()` (`registry.ts:266`) filters per model (e.g. `apply_patch` only for GPT-family, `edit`/`write` otherwise; `websearch` only when enabled) and fires the `tool.definition` plugin hook so descriptions/schemas can be rewritten. The `task` tool's description gets the live agent roster appended (`describeTask`, `registry.ts:251`).

`session/tools.ts:89` converts each `Tool.Def` into a Vercel AI SDK `tool({ description, inputSchema: jsonSchema(...), execute })`. The `execute` bridges Effect→Promise (`EffectBridge`), fires `tool.execute.before`/`after` plugin hooks, and builds the `Tool.Context` whose `ask` is bound to the session's merged permission ruleset.

### Built-in tools

From `registry.ts:197-238`: `invalid` (repair sink), `question`, `bash`/shell, `read`, `glob`, `grep`, `edit`, `write`, `task` (sub-agent), `webfetch`, `todowrite`, `websearch`, `skill`, `apply_patch`, plus experimental `lsp` and `plan`. MCP servers add `list_mcp_resources` / `list_mcp_resource_templates` / `read_mcp_resource` and every remote MCP tool. `StructuredOutput` is injected on demand (`prompt.ts:1564`).

---

## 3. CONTEXT / CONVERSATION MANAGEMENT

**Anchors:** `session/message-v2.ts:131` (`toModelMessagesEffect`), `:521` (`filterCompacted`), `:585` (`latest`); `session/overflow.ts:10` (`usable`/`isOverflow`); `session/compaction.ts:289` (`process`), `:243` (`prune`); `session/processor.ts:475` (overflow detect).

History is the **source of truth, persisted in SQLite** (Drizzle); the loop reloads it each turn. A message = `Info` + ordered `Part[]` (`text`, `reasoning`, `tool`, `step-start/finish`, `patch`, `file`, `agent`, `subtask`, `compaction`). `toModelMessagesEffect` converts persisted parts into AI-SDK `ModelMessage[]`, with options to `stripMedia` and cap tool output chars during compaction.

**Token budgeting** (`overflow.ts`): `usable = model.limit.input - reserved` (reserved ≈ `min(20k, maxOutputTokens)`); `isOverflow` compares the last turn's total tokens to `usable`. When exceeded, the loop enqueues an auto-compaction (unless `compaction.auto === false`).

**Compaction** (`compaction.ts:289`): runs the hidden `compaction` agent (its own prompt `agent/prompt/compaction.txt`) over the existing transcript to produce a summary message; subsequent turns hide the pre-summary messages via `filterCompacted`. On `overflow`, it can also drop media and replay the last real user message. **Pruning** (`prune`, `compaction.ts:243`) is a cheaper, non-LLM cleanup: walks backward and marks old tool outputs as compacted once `PRUNE_PROTECT=40k` recent tool-tokens are protected and `PRUNE_MINIMUM=20k` of savings is available.

---

## 4. PROMPT CONSTRUCTION

**Anchors:** `session/llm/request.ts:56-78` (assembly order); `session/system.ts:26` (model→prompt map), `:58` (environment), `:96` (skills), `:110` (mcp); `session/instruction.ts:60-169` (AGENTS.md / CLAUDE.md); `session/reminders.ts:15` (plan reminders); prompt texts in `session/prompt/*.txt` and `agent/prompt/*.txt`.

The final `system: string[]` is built in `runLoop` (`prompt.ts:1256-1270`) from `[environment, instructions, mcpInstructions, skills]`, then `LLMRequestPrep.prepare` (`request.ts:58`) **prepends the header**: `agent.prompt` if the agent defines one, else the **model-specific base prompt** selected by substring on the model id:

```ts
// packages/opencode/src/session/system.ts:26
export function provider(model: Provider.Model) {
  if (model.api.id.includes("gpt-4") || ...) return [PROMPT_BEAST]
  if (model.api.id.includes("gpt"))    return [model.api.id.includes("codex") ? PROMPT_CODEX : PROMPT_GPT]
  if (model.api.id.includes("gemini-")) return [PROMPT_GEMINI]
  if (model.api.id.includes("claude"))  return [PROMPT_ANTHROPIC]
  if (...includes("kimi")) return [PROMPT_KIMI]
  return [PROMPT_DEFAULT]
}
```

`environment` injects an `<env>` block (cwd, worktree, git?, platform, date) plus the exact model id. **Memory injection**: `Instruction.system()` finds the first `AGENTS.md`/`CLAUDE.md`/`CONTEXT.md` walking up from cwd, plus global `~/.config/opencode/AGENTS.md` and `~/.claude/CLAUDE.md`, plus configured `instructions` (files or URLs), and emits `Instructions from: <path>\n<content>`. Nested `AGENTS.md` near a file get attached lazily when that file is read (`instruction.resolve`, `:179`). Plan-mode reminders are pushed as **synthetic user parts** at the tail (`reminders.ts`), not into the system prompt. The whole system array passes through the `experimental.chat.system.transform` plugin hook.

---

## 5. MODEL / PROVIDER I/O

**Anchors:** `session/llm.ts:85` (`run` → `streamText`), `:357` (`stream`); `session/llm/ai-sdk.ts:76` (`toLLMEvents` — SSE/event normalizer); `provider/provider.ts:108-133` (npm→AI-SDK loader map); `provider/transform.ts` (per-provider tweaks); `session/retry.ts`; native path: `session/llm/native-runtime.ts` + `packages/llm/src/protocols/*`.

**Default path = Vercel AI SDK.** `Provider` (`provider/provider.ts`) loads model catalog from **models.dev** and lazily `import()`s the matching `@ai-sdk/*` package (Anthropic, OpenAI, Google, Bedrock, xAI, OpenRouter, Mistral, Groq, GitHub Copilot, etc. — see the loader map at `provider.ts:108`). `LLM.run` calls `streamText({ model: wrapLanguageModel(...), tools, toolChoice, messages, ... })` and exposes `result.fullStream`.

The provider abstraction is mostly **delegated to the AI SDK's `LanguageModelV2` interface** — opencode does not parse raw SSE itself on this path. Instead, `LLMAISDK.toLLMEvents` (`ai-sdk.ts:76`) normalizes AI-SDK stream parts into opencode's internal `LLMEvent` union (the same enum the processor consumes). Tool-call extraction is therefore the AI SDK's job; opencode adds `experimental_repairToolCall` (`llm.ts:296`) to lowercase mismatched tool names or reroute to the `invalid` tool.

**Retries** (`session/retry.ts`): an Effect retry policy keyed on provider, classifying errors (overload/rate-limit/transient) and surfacing `retry` status to the UI with backoff.

**Native runtime (experimental):** when `flags.experimentalNativeLlm` is set, `LLMNativeRuntime.stream` (`session/llm/native-runtime.ts`) uses `packages/llm` to talk to providers directly. `packages/llm/src/protocols/anthropic-messages.ts`, `openai-chat.ts`, `openai-responses.ts`, `gemini.ts`, `bedrock-converse.ts` are **hand-written SSE/event-stream parsers** with their own tool-stream assembly (`protocols/utils/tool-stream.ts`) and cache-control policy (`cache-policy.ts`). If native reports "unsupported", it falls back to the AI SDK. This is the seam to watch if you want a provider layer without the AI SDK dependency.

---

## 6. PERMISSIONS / SANDBOXING / APPROVAL

**Anchors:** `permission/index.ts:28` (`evaluate`), `:67` (`ask`), `:109` (`reply`), `:186` (`fromConfig`), `:204` (`disabled`); `agent/agent.ts:119-265` (default rulesets); `tool/shell.ts:257` (tree-sitter parse), `:263` (`ask`); `agent/subagent-permissions.ts`.

Permissions are a flat **rule list**: `{ permission, pattern, action: "allow"|"ask"|"deny" }`. `evaluate(permission, pattern, ...rulesets)` flattens all rulesets and returns the **last** rule whose `permission` and `pattern` both wildcard-match — default `ask` if none. Rulesets stack: agent defaults → built-in agent overrides → user config → session overrides (`Permission.merge` is just `flat()`).

```ts
// packages/opencode/src/permission/index.ts:28
export function evaluate(permission, pattern, ...rulesets) {
  return rulesets.flat().findLast((rule) =>
    Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern))
    ?? { action: "ask", permission, pattern: "*" }
}
```

`ask` (`:67`) evaluates each requested pattern; `deny` → throw `DeniedError`; all `allow` → proceed; any `ask` → publish `Permission.Asked` event and **block on a `Deferred`** until `reply` resolves it. `reply` with `"always"` appends `allow` rules to the in-session `approved` list (and auto-resolves other pending asks now covered). Rejection throws `RejectedError`/`CorrectedError` (the latter carries the user's correction feedback back to the model). There is **no OS sandbox** — gating is purely "ask before side effect".

**Bash is the sophisticated case** (`tool/shell.ts`): the command is parsed with **tree-sitter** (bash + powershell WASM grammars), sub-commands and target directories are extracted into permission patterns, and `ask` is issued per pattern under the `bash` and `external_directory` permissions. So `git status && rm -rf /` asks separately for `git status` and `rm`. File tools ask under `edit`/`read`/`external_directory`; reads of `*.env` default to `ask` (`agent/agent.ts:130-135`).

---

## 7. SUB-AGENTS / MCP / ORCHESTRATION

**Anchors:** `tool/task.ts:81` (`TaskTool`), `:142` (child session create), `agent/subagent-permissions.ts` (`deriveSubagentSessionPermission`); `session/prompt.ts:255` (`handleSubtask`); `mcp/index.ts:7-10` (transports), `session/tools.ts:384-483` (MCP tool wrapping); `background/job.ts` (background subagents).

**Sub-agents = recursion through the `task` tool.** Calling `task` with `subagent_type` creates a **child Session** (`task.ts:142`) with a derived permission set (parent session perms filtered through the subagent's own ruleset, plus tool denies for `todowrite`/nested `task`), then runs the *same* `SessionPrompt.prompt` loop on it via `promptOps` passed through `ctx.extra`. The child's last text part is returned to the parent as the tool output, wrapped in `<task ...><task_result>` (`renderOutput`). Background mode (`OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS`) runs the child via `BackgroundJob` and injects a synthetic result message when done. Agents themselves are just `Agent.Info` structs (see §8/plan-vs-build below); subagents are those with `mode:"subagent"`.

**MCP** (`mcp/index.ts`) uses the official `@modelcontextprotocol/sdk` client over **stdio / SSE / streamable-HTTP** transports (with OAuth support). Remote MCP tools are merged into the tool set in `session/tools.ts:384`, where each gets a blanket `ctx.ask({ permission: key, patterns: ["*"] })` gate and its content (text/image/resource) is converted into opencode output + attachments. MCP server `instructions` are injected into the system prompt (`system.ts:110`), and MCP `resources` are exposed via three synthetic tools.

---

## 8. plan vs build (and other agents)

**Anchor:** `agent/agent.ts:140-265`. Agents are a `Record<string, Info>` built from hardcoded natives + config. `Info` = `{ name, mode, permission, model?, prompt?, temperature?, steps?, options, ... }`. The differences are **entirely in the permission preset and prompt**:

- **`build`** (primary, default): `defaults` (`*: allow`) + `question/plan_enter: allow`.
- **`plan`** (primary): `defaults` + `edit: { "*": deny, plans/*.md: allow }`, `plan_exit: allow`, `task.general: deny`. No model-level difference — it's a strict permission overlay. Switching plan→build pushes a `BUILD_SWITCH` synthetic reminder (`reminders.ts:38`).
- **`general`/`explore`** (subagents), **`compaction`/`title`/`summary`** (hidden primaries with their own `agent/prompt/*.txt` and `*: deny` tool perms).

User config (`cfg.agent`) and `.md` agent files can add/override any field including a custom `prompt`, `model`, `steps`, and `permission`.

---

## Essential vs Bloat

| Component | Essential to ANY agent | Bloat / product-specific (a lean framework can skip) |
|---|---|---|
| `while(true)` turn loop reloading history (`prompt.ts:1081`) | ✅ core | — |
| Tool def = `{name, schema, execute}` + JSON-schema to model (`tool/tool.ts`) | ✅ core | — |
| Stream→event normalization (`ai-sdk.ts:76`) | ✅ core (need *some* parse) | the dual native+ai-sdk runtime seam |
| Permission `evaluate`/`ask` allow/ask/deny (`permission/index.ts`) | ✅ core (any side-effecting agent) | tree-sitter bash parsing, `external_directory`, doom-loop |
| System prompt = base + env + memory files (`request.ts`, `instruction.ts`) | ✅ core | per-model prompt variants (beast/codex/kimi/trinity...), reference dirs |
| Token-budget overflow check (`overflow.ts`) | ✅ core | LLM-summary compaction + non-LLM pruning sophistication |
| Provider abstraction | ✅ core (≥1 provider) | lazy-loading 25+ `@ai-sdk/*` packages; models.dev catalog; OAuth flows |
| Sub-agent via task tool (`task.ts`) | ⚠️ nice-to-have | background subagents, job promotion, resumable task_id |
| MCP client | ⚠️ optional | OAuth, resources/templates, 3 synthetic resource tools |
| — | — | Effect runtime, SQLite persistence, plugin hook bus, ACP, share, snapshot/revert, LSP, image normalization, title/summary side-channels, structured-output tool, 20+ README translations |

The genuinely essential core is ~6 pieces: **loop, tool interface+registry, a streaming provider call with tool-call extraction, message history + token budgeting, system-prompt assembly with memory injection, and a permission gate.** Everything else in opencode is product surface.

## Ideas worth stealing

1. **Reload-and-rederive loop state each turn** (`MessageV2.latest`) instead of holding a mutable conversation object — makes cancel/resume/compaction trivially correct, since persisted history is the single source of truth.
2. **Invalid-args becomes a tool result, not a crash** (`InvalidArgumentsError` in `tool/tool.ts:24`): the schema-validation error message is fed back to the model so it self-corrects — a clean, model-driven repair loop. Pair with `experimental_repairToolCall`.
3. **Permission = ordered wildcard rule list, last-match-wins** (`evaluate`), with `always` answers appended as new `allow` rules at runtime. Tiny, composable, and rulesets just concatenate.
4. **Tree-sitter the bash command** to ask permission per real sub-command (`shell.ts`), instead of regex or all-or-nothing bash approval.
5. **plan vs build are permission presets, not code paths** — agent modes cost almost nothing to add.
6. **Auto-truncate large tool output to a temp file** (`tool/tool.ts:131`) and tell the model where it went — keeps context lean without losing data.
7. **Doom-loop detection**: 3 identical consecutive tool calls → force a permission ask (`processor.ts:354`).
8. **Per-model base system prompts** chosen by model-id substring (`system.ts:26`) — cheap way to tune behavior per provider family.
9. **A clean runtime seam** (`llm.ts:226`): the same `LLMEvent` stream is produced by either the AI SDK adapter or a hand-rolled native protocol, so you can start on a vendor SDK and swap in your own parser later without touching the processor.

---

## Honest gaps / caveats

- The codebase is **Effect-TS end to end**; nearly every function is an `Effect.fn`. The control flow described is accurate but the syntax (`yield*`, `Layer`, `Deferred`, `Stream`) will look alien if you don't know Effect. None of it is essential to the architecture.
- On the **default path opencode does not parse SSE itself** — `streamText` (AI SDK) owns provider I/O and tool dispatch. The "real" hand-rolled protocol parsers live in `packages/llm/src/protocols/` and are only used by the experimental native runtime; I confirmed they exist and are wired through `native-runtime.ts`, but they are not the shipping default.
- `packages/core` and `packages/llm` are a large in-flight refactor; I treated `packages/opencode/src` as ground truth for runtime behavior since that is what the CLI runs.
- I did not exhaustively read every tool (`edit.ts`, `read.ts`, `apply_patch.ts`, etc.); I read the tool *interface*, registry, the AI-SDK wrapping, and `shell.ts`/`task.ts` in depth as the representative + most architecturally important cases.
