# OpenClaude Architecture Map

> Repo: `openclaude` — TypeScript, a fork of Claude Code retargeted for **multi-provider** use (Anthropic, OpenAI-compatible, Gemini, DeepSeek, Ollama, Mistral, Bedrock, Vertex, Foundry, xAI, GitHub Copilot, MiniMax, …). React/Ink terminal UI, MCP, slash commands, sub-agents, and a gRPC headless server.
> Analyzed at git `64955db` (release 0.21.0). All anchors are relative to the repo root.

## TL;DR (5 bullets)

- **The agent loop is one big `while (true)` generator** in `src/query.ts:497` (`queryLoop`). It is NOT recursive — each "turn" re-enters the top of the loop by reassigning a single mutable `state` object and calling `continue`. The loop calls the model via the injected `deps.callModel`, streams `tool_use` blocks, executes them, appends `tool_result`s, and loops until the model returns no tool calls (`needsFollowUp === false`, `src/query.ts:1442`).
- **The canonical wire format is the Anthropic Messages API** (the `@anthropic-ai/sdk` types). The multi-provider magic is a **shim that masquerades as an `Anthropic` client**: `getAnthropicClient` (`src/services/api/client.ts:317`) dispatches by env flag / per-agent `providerOverride` and, for non-Anthropic providers, returns `createOpenAIShimClient` (`src/services/api/openaiShim.ts:4429`) — an object shaped `{ beta, messages }` that converts Anthropic↔OpenAI/Gemini/Codex on the way out and translates each provider's SSE back into Anthropic stream events.
- **Tools are plain objects** built via `buildTool()` (`src/Tool.ts:812`) with a Zod `inputSchema`, async `call`, `checkPermissions`, `isConcurrencySafe`, `isReadOnly`, and ~30 optional render/permission hooks. They're assembled by `getAllBaseTools()` (`src/tools.ts:182`) and merged with MCP tools by `assembleToolPool()` (`src/tools.ts:341`).
- **Context management is unusually deep**: a layered pipeline of snip → microcompact → context-collapse → autocompact runs at the top of every iteration (`src/query.ts:617`-`845`), with a hard blocking-limit guard, reactive (post-413) compaction recovery, and an LLM-generated conversation summary (`src/services/compact/compact.ts`).
- **Permissions are a 4-mode rule engine** (`default`/`plan`/`auto`/`fullAccess` + `bypassPermissions`) in `src/utils/permissions/permissions.ts:1089` with deny/ask/allow rules, bypass-immune safety checks for `.git`/`.claude`/shell configs, and an optional OS sandbox (`@anthropic-ai/sandbox-runtime`, bubblewrap on Linux) that can auto-allow sandboxed Bash.

---

## 1. Entry point → AGENT LOOP

**Anchors:** `src/query.ts:389` (`query` wrapper) · `src/query.ts:411` (`queryLoop`) · `src/query.ts:497` (`while (true)`) · `src/query.ts:1015` (`deps.callModel(...)`) · `src/query.ts:1206-1228` (stream consume + tool_use collection) · `src/query.ts:1442` (loop-exit on no tool calls) · `src/query.ts:2021-2054` (tool execution) · `src/query.ts:2479-2495` (next-turn state) · `src/query/deps.ts:41` (`callModel = queryModelWithStreaming`).

`query()` is a thin wrapper that delegates to `queryLoop()` and fires command-lifecycle callbacks on normal return. `queryLoop` is an `AsyncGenerator<StreamEvent | Message | …, Terminal>`. Callers (`runAgent`, the REPL, the print/SDK path, the gRPC handler) iterate it and render/record whatever it yields.

The loop carries **one mutable `State` object** (`src/query.ts:363`) holding `messages`, `toolUseContext`, compaction tracking, recovery counters (max-output-tokens, reactive-compact one-shot, provider-fallback one-shot), `turnCount`, `continuationNudgeCount`, and `agentStepLimit`. Every iteration:

1. Destructures `state` (`:498`).
2. Runs the **context pipeline**: tool-result budget → snip → microcompact → context-collapse → autocompact (`:584`-`845`), plus force-compact on memory pressure / message-count (`:699`).
3. Builds the full system prompt by appending `systemContext` (`:695`).
4. **Calls the model** through `deps.callModel` (= `queryModelWithStreaming`) and consumes the stream (`:1015`). Each yielded `assistant` message is pushed to `assistantMessages`; any `tool_use` blocks are collected into `toolUseBlocks` and `needsFollowUp = true` (`:1209`-`1218`). If streaming-tool-execution is on, tools start executing *during* the stream (`StreamingToolExecutor`, `:1224`).
5. If `!needsFollowUp`: handle recovery (413/media/max-tokens/rate-limit/provider-fallback), then stop-hooks, token-budget continuation, and a "continuation nudge" heuristic; otherwise `return { reason: 'completed' }` (`:1442`-`1966`).
6. Otherwise **executes the collected tools** (`runTools` or the streaming executor, `:2021`), pushes `tool_result` user messages into `toolResults`, drains queued commands / attachments / memory prefetch, then builds the **next-turn `state`** with `messages = [...messagesForQuery, ...assistantMessages, ...toolResults]` and loops (`:2479`).

The single most important excerpt — the model call + tool-use collection + exit condition:

```ts
// src/query.ts (condensed from ~1015, ~1209, ~1442, ~2480)
for await (const message of deps.callModel({
  messages: prependUserContext(messagesForQuery, userContext),
  systemPrompt: fullSystemPrompt,
  tools: toolsForModel,
  signal: toolUseContext.abortController.signal,
  options: { model: currentModel, fallbackModel, querySource, /* … */ },
})) {
  if (message.type === 'assistant') {
    assistantMessages.push(message)
    const msgToolUseBlocks = message.message.content.filter(c => c.type === 'tool_use')
    if (msgToolUseBlocks.length > 0) { toolUseBlocks.push(...msgToolUseBlocks); needsFollowUp = true }
  }
}
if (!needsFollowUp) { /* stop hooks / nudges */ return { reason: 'completed' } }
// …execute tools → toolResults…
state = { messages: [...messagesForQuery, ...assistantMessages, ...toolResults], /* … */ }
// loop
```

Note: the loop does NOT trust `stop_reason === 'tool_use'` (it's "unreliable", `src/query.ts:856`); presence of a streamed `tool_use` block is the sole continue signal.

---

## 2. TOOL SYSTEM

**Anchors:** `src/Tool.ts:391` (`Tool` type) · `src/Tool.ts:408` (`call`) · `src/Tool.ts:423` (`inputSchema`) · `src/Tool.ts:529` (`checkPermissions`) · `src/Tool.ts:786` (`TOOL_DEFAULTS`) · `src/Tool.ts:812` (`buildTool`) · `src/tools.ts:182` (`getAllBaseTools`) · `src/tools.ts:341` (`assembleToolPool`) · `src/services/tools/toolExecution.ts:735` (`checkPermissionsAndCallTool`) · `src/services/tools/toolExecution.ts:752` (Zod `safeParse`).

A tool is a plain object matching the `Tool<Input, Output, P>` type. Core fields: `name`, `inputSchema` (a Zod v4 schema; MCP tools may instead supply `inputJSONSchema`), async `call(args, context, canUseTool, parentMessage, onProgress) → ToolResult<Output>`, async `description(input, opts)`, async `prompt(opts)` (the text shown to the model), and predicate methods `isEnabled`, `isReadOnly`, `isConcurrencySafe`, `isDestructive`, `checkPermissions`. There are also ~25 optional React/Ink render methods and helpers (`renderToolUseMessage`, `mapToolResultToToolResultBlockParam`, `toAutoClassifierInput`, `maxResultSizeChars`, `shouldDefer`/`alwaysLoad` for lazy tool-search loading, etc.).

Tools are constructed with `buildTool()`, which spreads `TOOL_DEFAULTS` so omitted methods get **fail-closed defaults**: `isReadOnly → false` (assume writes), `isConcurrencySafe → false`, `checkPermissions → allow` (defer to the general permission system).

**Registration** is a hand-written array in `getAllBaseTools()` with heavy `feature()`/env gating (dead-code-eliminated at build via `bun:bundle`). `getTools(permissionContext)` filters by deny-rules and REPL mode; `assembleToolPool()` then sorts built-ins and MCP tools into separate alphabetized partitions and dedupes by name (built-ins win) — done deliberately to keep the server-side prompt cache breakpoint stable.

**Execution path** (`checkPermissionsAndCallTool`, toolExecution.ts:735): (1) Zod `safeParse` the input → on failure return a `<tool_use_error>InputValidationError…` result; (2) `tool.validateInput?.()`; (3) run PreToolUse hooks; (4) resolve the permission decision (`canUseTool`); (5) if not `allow`, return an `is_error` tool_result; (6) `tool.call(...)`, streaming progress; (7) `mapToolResultToToolResultBlockParam` formats the output into an Anthropic `tool_result` block. `runTools` (`src/services/tools/toolOrchestration.ts:19`) batches consecutive **concurrency-safe** tools to run in parallel (default cap 10) and runs everything else serially.

**Built-in tools** (from `getAllBaseTools`, `src/tools.ts:183`): `Agent` (sub-agents), `Task*` (TaskCreate/Get/Update/List + TaskOutput/TaskStop), `Bash`, `Glob`, `Grep`, `Read`, `Edit`, `Write`, `NotebookEdit`, `WebFetch`, `WebSearch`, `TodoWrite`, `AskUserQuestion`, `Skill`, `EnterPlanMode`/`ExitPlanMode`, `LSP`, `ListMcpResources`/`ReadMcpResource`, `ToolSearch`, `Brief`, `EnterWorktree`/`ExitWorktree`, `SendMessage`/`TeamCreate`/`TeamDelete`/`ListPeers` (agent swarms), `Sleep`, `CronCreate`/`CronDelete`/`CronList`, plus many feature-gated extras (PowerShell, Monitor, Workflow, WebBrowser, RemoteTrigger, PushNotification, …).

```ts
// src/Tool.ts:812 — every tool goes through this so defaults live in one place
export function buildTool<D extends AnyToolDef>(def: D): BuiltTool<D> {
  return { ...TOOL_DEFAULTS, userFacingName: () => def.name, ...def } as BuiltTool<D>
}
```

---

## 3. CONTEXT / CONVERSATION MANAGEMENT

**Anchors:** `src/query.ts:564` (`getMessagesAfterCompactBoundary`) · `src/query.ts:594` (`applyToolResultBudget`) · `src/query.ts:622` (snip) · `src/query.ts:640` (microcompact) · `src/query.ts:667` (context-collapse) · `src/query.ts:737` (autocompact) · `src/query.ts:946-956` (hard blocking limit) · `src/query.ts:1465`-`1564` (reactive 413/media recovery) · `src/services/compact/autoCompact.ts:170` (`getAutoCompactThreshold`) · `src/services/compact/compact.ts:410` (`compactConversation`).

Message history is an array of `Message` (user/assistant/attachment/system/progress/tombstone) whose `message.content` is Anthropic content-block format. The loop reads only the slice after the latest compaction boundary (`getMessagesAfterCompactBoundary`).

There are **five distinct context-reduction layers**, applied in order each iteration so cheaper/more-granular ones run first and may obviate the expensive summary:

1. **Tool-result budget** — caps aggregate tool-result bytes; oversized results are spilled to disk and replaced with a pointer (`applyToolResultBudget`, per-tool `maxResultSizeChars`).
2. **Snip** (`HISTORY_SNIP`) — drops stale spans, reporting `tokensFreed` so downstream thresholds see the reduction.
3. **Microcompact** — per-tool_use_id pruning of old tool results (can use server-side cache-editing under `CACHED_MICROCOMPACT`).
4. **Context-collapse** (`CONTEXT_COLLAPSE`) — a read-time projection that archives spans into a summary store and replays the commit log each turn.
5. **Autocompact** — full LLM summarization when token usage exceeds `getAutoCompactThreshold(model)` = `effectiveContextWindow − AUTOCOMPACT_BUFFER_TOKENS` (autoCompact.ts:170). Produces summary messages via `compactConversation` and rebuilds history with `buildPostCompactMessages` (boundary marker + summary + kept tail + restored files/skills under a 50k post-compact budget).

A **hard blocking limit** (`calculateTokenWarningState`, autoCompact.ts:191) yields a `prompt_too_long` error and stops before sending an oversized request when auto-compact is off or the breaker has tripped (`src/query.ts:946`, `:964`). When a real 413 *does* come back, the loop **withholds** the error from SDK consumers and tries collapse-drain then reactive-compact before surfacing it (`src/query.ts:1465`-`1564`). There's also a token-budget "+500k" auto-continue feature and a server-side `task_budget` that's tracked across compaction boundaries.

```ts
// src/services/compact/autoCompact.ts:170
export function getAutoCompactThreshold(model: string): number {
  const effectiveContextWindow = getEffectiveContextWindowSize(model)
  const autocompactThreshold = effectiveContextWindow - AUTOCOMPACT_BUFFER_TOKENS
  // CLAUDE_AUTOCOMPACT_PCT_OVERRIDE allows a percentage override for testing
  return autocompactThreshold
}
```

---

## 4. PROMPT CONSTRUCTION

**Anchors:** `src/constants/prompts.ts:440` (`getSystemPrompt`) · `src/constants/prompts.ts:174` (intro text) · `src/constants/prompts.ts:491` (`memory` section) · `src/constants/prompts.ts:602` (`computeEnvInfo`) · `src/constants/prompts.ts:756` (`DEFAULT_AGENT_PROMPT`) · `src/utils/systemPrompt.ts:41` (`buildEffectiveSystemPrompt`) · `src/query.ts:695` (`appendSystemContext`) · `src/query.ts:1016` (`prependUserContext`).

The default system prompt is assembled in `getSystemPrompt(tools, model, …)` as an **array of string sections** split into a static (cacheable) prefix and a dynamic suffix, separated by a `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` marker so the server can place a prompt-cache breakpoint. Static sections: intro ("You are an interactive agent…", `:174`), system/security, doing-tasks, actions, **using-your-tools (lists enabled tool names)**, tone & style, output efficiency. Dynamic sections (registry-managed via `systemPromptSection(...)`): `session_guidance`, **`memory`** (`loadMemoryPrompt()` — loads CLAUDE.md / AGENTS.md project + user memory), `env_info` (cwd, git status, OS, model id), `language`, `output_style`, `mcp_instructions`, `scratchpad`, function-result-clearing, summarize-tool-results, and feature-gated `token_budget`/`brief`.

`buildEffectiveSystemPrompt` (systemPrompt.ts:41) picks the prompt by precedence: override → coordinator → agent (`mainThreadAgentDefinition.getSystemPrompt`) → `--system-prompt` custom → default, with `--append-system-prompt` always appended. Sub-agents use a far leaner `DEFAULT_AGENT_PROMPT` (prompts.ts:756).

Two side channels feed dynamic context **without busting the system-prompt cache**: `userContext` is prepended to the message list (`prependUserContext`, env/git/directory facts as a synthetic first user turn) and `systemContext` is appended to the system prompt array right before the call (`appendSystemContext`, query.ts:695). Reminders/attachments (file changes, memory prefetch, queued commands, skill discovery) are injected as `attachment` messages at the tail of each turn (`getAttachmentMessages`, query.ts:2339).

```ts
// src/constants/prompts.ts:556 — static prefix, boundary, dynamic suffix
return [
  getSimpleIntroSection(outputStyleConfig), getSimpleSystemSection(),
  getSimpleDoingTasksSection(), getActionsSection(),
  getUsingYourToolsSection(enabledTools), getSimpleToneAndStyleSection(),
  getOutputEfficiencySection(),
  ...(shouldUseGlobalCacheScope() ? [SYSTEM_PROMPT_DYNAMIC_BOUNDARY] : []),
  ...resolvedDynamicSections,   // memory, env_info, mcp_instructions, …
].filter(s => s !== null)
```

---

## 5. MODEL / PROVIDER I/O  (the key differentiator)

**Anchors:** `src/services/api/claude.ts:774` (`queryModelWithStreaming`) · `src/services/api/client.ts:317` (`getAnthropicClient`) · `src/services/api/client.ts:475`/`510` (shim dispatch) · `src/services/api/openaiShim.ts:4429` (`createOpenAIShimClient`) · `:2812` (`OpenAIShimMessages.create`) · `:933` (`convertMessages`) · `:1302` (`convertTools`) · `:1998` (`openaiStreamToAnthropic`) · `src/services/api/providerConfig.ts:796` (`resolveProviderRequest`) · `src/services/api/codexShim.ts:811` (`codexStreamToAnthropic`).

**Everything inside the agent is Anthropic-shaped.** `deps.callModel` → `queryModelWithStreaming` → `queryModel` builds an Anthropic `BetaMessageStreamParams` and gets a client from `getAnthropicClient`. That function is the provider **router**:

- Per-agent `providerOverride` (agent routing) → shim with auth headers stripped (SSRF mitigation), `client.ts:475`.
- `CLAUDE_CODE_USE_OPENAI|GEMINI|MISTRAL|GITHUB` (or env-only providers xai/minimax/xiaomi/nearai/fireworks) → `createOpenAIShimClient`, `client.ts:510`.
- `CLAUDE_CODE_USE_BEDROCK|FOUNDRY|VERTEX` → the respective real Anthropic SDK subclass.
- otherwise → a real `new Anthropic(...)`.

`createOpenAIShimClient` returns `{ beta, messages }` — **a duck-typed `Anthropic`** so the rest of the codebase never knows the difference (openaiShim.ts:4429). Its `messages.create` (`:2812`) is the conversion hub:

1. `resolveProviderRequest({ model, baseUrl, … })` (providerConfig.ts:796) resolves base URL, model id, API key, and a **transport** (`chat_completions` | `responses` | `codex_responses` | gemini | anthropic-passthrough) from env + the model descriptor.
2. `convertMessages(messages, system)` (`:933`) flattens Anthropic content blocks → OpenAI chat messages (tool_use → `tool_calls`, tool_result → `role:'tool'`, images, reasoning), and `convertTools` (`:1302`) maps Anthropic tool schemas → OpenAI function-tool schemas.
3. The HTTP response stream is wrapped in `OpenAIShimStream` with a **per-transport SSE translator** back into Anthropic stream events: `openaiStreamToAnthropic` (`:1998`), `geminiSseToAnthropic`, `codexStreamToAnthropic` (codexShim.ts:811), or `anthropicSsePassthrough`.

`openaiStreamToAnthropic` (`:1998`) is the heart of stream parsing: it emits a synthetic `message_start`, accumulates OpenAI `delta.tool_calls` JSON into Anthropic `content_block_start/delta(input_json_delta)/stop` for tool calls, filters `<think>` tags, and even **recovers tool calls emitted as plain text** by Ollama/GLM/Qwen models (`parseTextToolCalls` `:1578`, `parseXmlToolCalls` `:1680`) — a real-world robustness feature for weaker local models.

**Retries** live in `withRetry` (`src/services/api/withRetry.js`, used by `executeNonStreamingRequest`, claude.ts:840) with model-fallback (`FallbackTriggeredError` → swap to `fallbackModel`, query.ts:1277), 529/idle-timeout handling, and a non-streaming fallback path with bounded timeouts.

```ts
// src/services/api/openaiShim.ts:2825 — one shim, many provider stream dialects
if (params.stream) {
  return new OpenAIShimStream(
    request.transport === 'codex_responses' || request.transport === 'responses' || isResponsesStream
      ? codexStreamToAnthropic(response, request.resolvedModel, options?.signal)
      : isMessagesStream  ? anthropicSsePassthrough(response, request.resolvedModel, options?.signal)
      : isGeminiStream    ? geminiSseToAnthropic(response, request.resolvedModel, options?.signal)
      :                     openaiStreamToAnthropic(response, request.resolvedModel, options?.signal, isLikelyOllamaEndpoint(request.baseUrl)),
  )
}
```

Provider metadata (vendors/gateways, default models, base URLs, capabilities) is a data-driven registry under `src/integrations/` (`vendors/*.ts`, `gateways/*.ts`, `registry.ts`, `descriptors.ts`).

---

## 6. PERMISSIONS / SANDBOXING / APPROVAL

**Anchors:** `src/utils/permissions/permissions.ts:1089` (`checkRuleBasedPermissions`) · `:1185` (`hasPermissionsToUseToolInner`) · `src/Tool.ts:133` (`ToolPermissionContext`) · `src/services/tools/toolExecution.ts:1147` (deny → error result) · `src/utils/sandbox/sandbox-adapter.ts:550` (`isSandboxingEnabled`) · `src/tools/BashTool/shouldUseSandbox.ts`.

Permissions are a layered rule engine keyed off a `ToolPermissionContext` (`src/Tool.ts:133`) holding `mode` (`default` | `plan` | `auto` | `fullAccess`, plus a `bypassPermissions` capability) and `alwaysAllow/Deny/Ask` rule maps grouped by source (cli/project/user/policy). The decision order in `checkRuleBasedPermissions` (`:1089`):

1. **1a** Tool-level deny rule → `deny`.
2. **1b** Tool-level ask rule → `ask` (unless a sandboxed Bash command can auto-allow, or fullAccess).
3. **1c** Tool-specific `tool.checkPermissions(input)` (e.g. Bash sub-command rules like `Bash(git *)`).
4. **1d/1f** Tool implementation deny / content-specific ask rules.
5. **1g** **Bypass-immune safety checks** — edits to `.git/`, `.claude/`, `.vscode/`, shell configs always prompt, even when a PreToolUse hook returned allow; only `fullAccess` skips them.

`canUseTool` (the function threaded through the loop) wraps this with interactive UI prompting (REPL) or auto-deny (headless / background agents via `shouldAvoidPermissionPrompts`). In **auto mode** it additionally awaits an LLM **security classifier** side-query before allowing. Denials become `is_error` tool_result blocks fed back to the model (`toolExecution.ts:1147`) rather than aborting the turn.

**Sandboxing** is an adapter over the external `@anthropic-ai/sandbox-runtime` (`sandbox-adapter.ts:17`) — bubblewrap (`bwrap`) on Linux/WSL, OS sandboxing elsewhere. When `autoAllowBashIfSandboxed` is on, Bash commands deemed safe by `shouldUseSandbox(input)` run inside the sandbox and skip the permission prompt entirely (permissions.ts:1113). Plan mode and `EnterPlanMode`/`ExitPlanMode` gate side-effecting tools off until the user approves the plan.

```ts
// src/utils/permissions/permissions.ts:1097 — first gate: blanket tool deny
const denyRule = getDenyRuleForTool(appState.toolPermissionContext, tool)
if (denyRule) {
  return { behavior: 'deny', decisionReason: { type: 'rule', rule: denyRule },
           message: `Permission to use ${tool.name} has been denied.` }
}
```

---

## 7. SUB-AGENTS / MCP / ORCHESTRATION

**Anchors:** `src/tools/AgentTool/AgentTool.tsx` · `src/tools/AgentTool/runAgent.ts:246` (`runAgent`) · `:800` (nested `query(...)`) · `src/tools/AgentTool/forkSubagent.ts` · `src/coordinator/coordinatorMode.ts` · `src/services/mcp/client.ts:7` (MCP SDK `Client`) · `src/grpc/server.ts:92` (gRPC `AgentService`) · `src/proto/openclaude.proto:6`.

**Sub-agents reuse the same loop.** The `Agent` tool's `call` invokes `runAgent` (runAgent.ts:246), which builds a `createSubagentContext` (an isolated `ToolUseContext` with a filtered tool set, its own `agentId`, and an `agentStepLimit`) and then **calls `query(...)` again** (runAgent.ts:800), iterating its generator, recording a sidechain transcript, and forwarding stream/attachment messages up to the parent. The subagent's `agentStepLimit` makes the same loop cap tool calls and force a final summary (handled in query.ts:1957/2056). Agent definitions are loaded from `.claude/agents` dirs + built-ins (`loadAgentsDir.ts`, `builtInAgents.ts`); a **coordinator mode** and **agent swarms** (`SendMessage`/`TeamCreate`, `src/utils/swarm/`) layer multi-agent collaboration on top.

**MCP** uses the official `@modelcontextprotocol/sdk` (`src/services/mcp/client.ts`) with stdio / SSE / streamable-HTTP / in-process / SDK-control transports, OAuth, and session-expiry retry. Connected MCP tools become first-class `Tool` objects (with `isMcp`, `inputJSONSchema`, `mcpInfo`) merged via `assembleToolPool`; their server instructions are injected as a system-prompt section or `mcp_instructions_delta` attachment. OpenClaude can also act as an MCP **server** (`src/entrypoints/mcp.ts`).

**Headless gRPC server** (`src/grpc/server.ts:92`, proto `src/proto/openclaude.proto`): a real `AgentService.Chat` bidirectional stream — client sends `ChatRequest`/`UserInput`/`CancelSignal`, server streams `TextChunk`/`ToolCallStart`/`ToolCallResult`/`ActionRequired`/`FinalResponse`/`ErrorResponse`. `ActionRequired` is how the headless transport surfaces permission prompts to a remote UI. This is OpenClaude-specific (not in upstream Claude Code) and is wired (`dev:grpc` script, `@grpc/grpc-js` dependency).

```ts
// src/tools/AgentTool/runAgent.ts:800 — a sub-agent is just another query() loop
const queryIterator = query({
  messages: initialMessages, systemPrompt: agentSystemPrompt,
  userContext, systemContext, canUseTool,
  toolUseContext: agentToolUseContext, querySource,
  maxTurns: maxTurns ?? agentDefinition.maxTurns,
  agentStepLimit: configuredMaxSteps !== undefined
    ? { maxSteps: configuredMaxSteps, agentType: agentDefinition.agentType } : undefined,
})[Symbol.asyncIterator]()
```

---

## 8. ESSENTIAL vs BLOAT

This repo is a production fork carrying a *lot* of product surface. The agentic core is small; most lines are reliability, UI, telemetry, and provider breadth.

| Concern | ESSENTIAL (core to any agent) | BLOAT for a lean framework |
|---|---|---|
| Loop | `while(true)` build→call→parse tool_use→exec→append→repeat (`query.ts`) | continuation-nudge heuristic, tool-failure loop guard, agent-step-limit forced-summary, token-budget +500k auto-continue |
| Tools | Zod `inputSchema` + `call` + `checkPermissions` + `buildTool` defaults; Bash/Read/Edit/Write/Grep/Glob | ~25 optional React/Ink render methods per tool; Worktree/Cron/Push/Monitor/Workflow/REPL/Brief/Skill tools |
| Provider I/O | Anthropic-shaped canonical format + one adapter to your real provider; SSE→events | 12+ providers, env-only providers, codex/responses transports, text/XML tool-call recovery, gateways registry |
| Context | message array + a token-threshold summarize step | 5-layer snip/microcompact/collapse/autocompact/reactive pipeline, cache-editing, task_budget carryover |
| Prompt | system text + tool list + env + memory (CLAUDE.md/AGENTS.md) | cache-boundary marker, GrowthBook-gated sections, output-styles, conversation-arc / knowledge-graph |
| Permissions | allow/deny/ask + a confirm callback | 4 modes + bypass, LLM security classifier, OS sandbox, shadowed-rule detection, plan mode |
| Orchestration | sub-agent = recursive `query()` with its own context/tools | coordinator mode, agent swarms/teams, gRPC server, MCP server role, remote/background sessions |
| Everything else | — | analytics/telemetry, cost tracking, VCR fixtures, voice/STT, ads, vim mode, keybindings, vscode extension, web docs |

### Ideas worth stealing

1. **Canonical-format-as-interface.** Pick ONE message+tool wire format (here: Anthropic Messages) and make every provider a shim that *quacks like that client* (`createOpenAIShimClient` returning `{ beta, messages }`). The loop, tools, and compaction never branch on provider.
2. **Per-transport SSE translators returning a common event stream.** `openaiStreamToAnthropic` / `geminiSseToAnthropic` / `codexStreamToAnthropic` all yield Anthropic stream events; the consumer is provider-agnostic.
3. **`buildTool()` with fail-closed defaults.** One factory fills `isReadOnly→false`, `isConcurrencySafe→false`, `checkPermissions→allow`, so a new tool is safe-by-default and minimal to declare.
4. **Don't trust `stop_reason`.** Use the *presence of a streamed tool_use block* as the loop-continue signal (query.ts:856) — robust across providers that set stop_reason inconsistently.
5. **Concurrency partitioning by `isReadOnly`/`isConcurrencySafe`.** Batch consecutive read-only tools to run in parallel, serialize writers (`partitionToolCalls`, toolOrchestration.ts:91).
6. **Injectable I/O deps for the loop** (`QueryDeps`: `callModel`, `microcompact`, `autocompact`, `uuid`) — makes the loop trivially testable without module-mock gymnastics (`src/query/deps.ts`).
7. **Withhold recoverable errors mid-stream.** Hold back 413/max-tokens/rate-limit from the consumer until recovery (compact/fallback) is known to fail, so SDK hosts don't terminate on a transient error (query.ts:1160).
8. **Tool-result budget with disk spill** + per-tool `maxResultSizeChars`: bound context growth from huge tool outputs before any summarization is needed.
9. **Sub-agents are the same loop with a narrower context + step limit** — no separate "agent runtime" to maintain.
10. **System-prompt cache boundary marker** separating static prefix from dynamic sections, with dynamic context fed via prepended user-context / appended system-context instead of editing the cached prefix.

### Honest gaps / caveats

- The agent loop file (`query.ts`, ~2500 lines) is dominated by recovery/compaction branches; the *pure* loop is ~150 lines. A lean clone needs almost none of the recovery machinery.
- `openaiShim.ts` is 4451 lines — the conceptual model (convert in, translate stream out) is simple but the long tail of provider quirks is enormous.
- Much behavior is gated behind `feature(...)` (build-time, `bun:bundle`) and GrowthBook/Statsig flags, so "what's actually on" depends on build + remote config; I read code paths, not a running config.
- I did not exhaustively read every provider's `convert*`/stream translator (Gemini, Codex, Bedrock); the Anthropic↔OpenAI path is verified in depth and the others follow the same shape.
