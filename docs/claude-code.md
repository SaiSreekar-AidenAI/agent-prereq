# claude-code — Architecture Map (reverse-engineered)

Repo: `claude-code` (TypeScript, Bun bundle target). Repo root analyzed:
`/home/user/projects/agent-prereq/repos/claude-code`.

> **Honesty note on the snapshot.** This is a leaked/obfuscated *source* tree,
> not the shipped product, and it is mostly real TypeScript (not stubs). The
> agent loop, tool system, permissions, and provider I/O are all present and
> readable. Two caveats: (1) the entire UI/REPL lives in a single 800 KB
> `src/main.tsx` that is machine-generated and not worth reading; (2) the core
> `Message` union type is referenced everywhere as `./types/message.js` but that
> file is **not in the tree** (it resolves from the bundle) — so message-shape
> claims below are inferred from usage sites, not from a type declaration. A few
> modules are feature-gated behind `feature('X')` (a `bun:bundle` compile-time
> flag) and `require()`d conditionally; where a feature is off the string is
> tree-shaken out. I flag those inline.

---

## TL;DR (5 bullets)

- **The agent loop is a single `while (true)` generator** in `src/query.ts`
  (`queryLoop`, lines 241-1729). Each iteration: compact context → call model
  (streaming) → collect `tool_use` blocks → if none, run stop-hooks and return;
  else execute tools → append `tool_result` messages → loop. The loop carries a
  mutable `State` object and `continue`s for every kind of retry (fallback model,
  compaction, max-output-tokens recovery, stop-hook blocking, token-budget).
- **Tools are a fat structural interface** (`src/Tool.ts`, `Tool<Input,Output>`,
  362-695) with ~40 optional members. Only a handful are load-bearing for any
  agent: `name`, `inputSchema` (Zod), `prompt()` (the description sent to the
  model), `call()`, `checkPermissions()`, `mapToolResultToToolResultBlockParam()`.
  Everything else is UI rendering, telemetry, and product polish. `buildTool()`
  fills fail-closed defaults.
- **Permissions are a layered rule engine** (`src/utils/permissions/permissions.ts`)
  evaluated *before* every `tool.call()`: deny-rules → ask-rules →
  `tool.checkPermissions()` → mode (`default`/`plan`/`acceptEdits`/
  `bypassPermissions`/`auto`) → classifier/hooks → interactive `ask`. A separate
  OS sandbox (`bwrap` on Linux, Seatbelt on macOS) can auto-allow bash.
- **Context is managed by token-threshold autocompaction**: when estimated tokens
  cross `getAutoCompactThreshold(model)`, the loop forks a sub-agent to produce an
  8-section structured summary (`src/services/compact/prompt.ts`), then continues
  on `[summary, ...preservedTail]`. Multiple cheaper tiers exist behind feature
  flags (microcompact / snip / context-collapse).
- **Sub-agents are the same `query()` loop, recursed** (`src/tools/AgentTool/
  runAgent.ts:748`) with a child `ToolUseContext` (`createSubagentContext`),
  filtered tool set, and its own system prompt. MCP is a thin wrapper over the
  official `@modelcontextprotocol/sdk` client; MCP tools are adapted into the same
  `Tool` interface and merged into the pool.

---

## 1. Entry point → AGENT LOOP

**Anchors:** `src/query.ts:219` (`query`), `src/query.ts:241-1729` (`queryLoop`,
the real loop), `src/query.ts:307` (`while (true)`), `src/query.ts:659`
(`deps.callModel`), `src/query.ts:1062` (no-tool-use exit), `src/query.ts:1382`
(`runTools`), `src/query.ts:1715-1727` (continue → next turn).
Outer driver: `src/QueryEngine.ts:209` (`submitMessage`), `src/QueryEngine.ts:675`
(`for await (const message of query({...}))`).

There are two layers. `QueryEngine.submitMessage()` is the **session/turn
orchestrator** for the headless/SDK path: it builds the system prompt
(`fetchSystemPromptParts`), processes user input + slash commands
(`processUserInput`), yields a `system_init` message, then drives `query()` and
maps internal `Message`s to public `SDKMessage`s, persisting transcripts and
enforcing budget/turn/structured-output limits. It does **not** itself call the
model.

`query()` → `queryLoop()` is the **actual agent loop**. It is an async generator
that yields `StreamEvent | Message | ...` and returns a `Terminal` reason. State
between iterations lives in one mutable `State` object (`src/query.ts:204-217`):
`messages`, `toolUseContext`, compaction tracking, recovery counters, turn count,
and a `transition` tag describing why the last iteration continued.

The loop body, in order each iteration:
1. Compute `messagesForQuery = getMessagesAfterCompactBoundary(messages)` and run
   the compaction pipeline: tool-result budget → snip → microcompact →
   context-collapse → autocompact (`:365-543`).
2. `callModel(...)` streams assistant message(s); every `tool_use` block found
   sets `needsFollowUp = true` and is pushed to `toolUseBlocks` (`:826-845`).
   Streaming tool execution can start *during* the stream
   (`StreamingToolExecutor`).
3. If `!needsFollowUp` (`:1062`): the model produced only text → handle
   prompt-too-long / max-output-tokens recovery, run **stop hooks**, check token
   budget, then `return { reason: 'completed' }`. **This is the loop exit.**
4. Otherwise execute tools via `runTools` (or the streaming executor)
   (`:1380-1408`), collect `tool_result` user messages into `toolResults`, add
   queued-command + memory + skill attachments, check `maxTurns`, then build the
   next `State` with `messages = [...messagesForQuery, ...assistantMessages,
   ...toolResults]` and fall off the bottom of the `while` to iterate again
   (`:1715-1728`).

The single most important excerpt — the model call, the tool-use detection that
is the *only* loop-exit signal, and the recurse:

```ts
// src/query.ts (condensed from 659-845, 1062, 1380-1727)
for await (const message of deps.callModel({
  messages: prependUserContext(messagesForQuery, userContext),
  systemPrompt: fullSystemPrompt,
  tools: toolUseContext.options.tools,
  signal: toolUseContext.abortController.signal,
  options: { model: currentModel, fallbackModel, /* ... */ },
})) {
  if (!withheld) yield yieldMessage
  if (message.type === 'assistant') {
    assistantMessages.push(message)
    const msgToolUseBlocks = message.message.content.filter(c => c.type === 'tool_use')
    if (msgToolUseBlocks.length > 0) { toolUseBlocks.push(...msgToolUseBlocks); needsFollowUp = true }
  }
}
if (!needsFollowUp) {                          // model emitted only text
  const stopHookResult = yield* handleStopHooks(/* ... */)
  return { reason: 'completed' }               // <-- loop terminates here
}
const toolUpdates = streamingToolExecutor
  ? streamingToolExecutor.getRemainingResults()
  : runTools(toolUseBlocks, assistantMessages, canUseTool, toolUseContext)
for await (const update of toolUpdates) {
  if (update.message) { yield update.message
    toolResults.push(...normalizeMessagesForAPI([update.message], tools).filter(_ => _.type === 'user')) }
}
state = { messages: [...messagesForQuery, ...assistantMessages, ...toolResults],
          turnCount: turnCount + 1, transition: { reason: 'next_turn' }, /* ... */ }
// fall through while(true) → next iteration
```

Notable: `stop_reason: 'tool_use'` is explicitly distrusted (`:553-557`); the
presence of a `tool_use` content block is the authoritative signal. Errors are
yielded as synthetic assistant messages rather than thrown (`:955-997`), and any
emitted `tool_use` without a matching `tool_result` is back-filled with a
synthetic error result (`yieldMissingToolResultBlocks`, `:123-149`) to keep the
API-required pairing intact.

## 2. TOOL SYSTEM

**Anchors:** `src/Tool.ts:362-695` (`Tool<Input,Output,P>`), `src/Tool.ts:379-385`
(`call`), `src/Tool.ts:386-393` (`description`), `src/Tool.ts:500-503`
(`checkPermissions`), `src/Tool.ts:757-792` (`buildTool` + defaults), `src/tools.ts:193-251`
(`getAllBaseTools`), `src/utils/api.ts:119-230` (`toolToAPISchema`),
`src/services/tools/toolExecution.ts:599-1222` (validate → permission → call).

A tool is a plain object conforming to the `Tool` type. The **core** members:
- `name: string` (+ optional `aliases`, `searchHint`).
- `inputSchema: Input` — a Zod schema (`AnyObject = z.ZodType<{...}>`). Converted
  to JSON Schema via `zodToJsonSchema` at request time (`api.ts:160`). MCP tools
  may instead carry a raw `inputJSONSchema`.
- `prompt(opts): Promise<string>` — **this is the description shown to the model**
  (api.ts:171). It is a method, not a static string, so it can vary by enabled
  tools / agents / permission mode.
- `call(args, context, canUseTool, parentMessage, onProgress): Promise<ToolResult<Output>>`
  — the implementation. Returns `{ data, newMessages?, contextModifier?, mcpMeta? }`.
- `checkPermissions(input, context): Promise<PermissionResult>` — tool-specific
  permission logic (e.g. bash subcommand rules).
- `mapToolResultToToolResultBlockParam(content, id): ToolResultBlockParam` — turns
  the `Output` into the API `tool_result` block (the model-facing text).

Plus many optional members for behavior (`isReadOnly`, `isConcurrencySafe`,
`isDestructive`, `validateInput`, `maxResultSizeChars`, `shouldDefer`/`alwaysLoad`
for tool-search deferral) and a large surface of React-rendering methods
(`renderToolUseMessage`, `renderToolResultMessage`, `renderGroupedToolUse`, …) and
telemetry (`toAutoClassifierInput`, `extractSearchText`). `buildTool()`
(`Tool.ts:783`) spreads fail-closed defaults so a definition can omit them:
`isReadOnly → false`, `isConcurrencySafe → false`, `checkPermissions → allow`.

**Registration** is a hand-written array, not a registry — `getAllBaseTools()`
(`tools.ts:193`) returns the literal list, gated by env/feature flags.
`getTools(permissionContext)` filters by deny-rules and `isEnabled()`;
`assembleToolPool()` merges + dedups MCP tools (built-ins win), sorted into a
cache-stable partition.

**Built-in tools** (from `tools.ts:193-251`): `Agent` (sub-agents), `Bash`,
`Glob`, `Grep`, `Read` (FileRead), `Edit` (FileEdit), `Write` (FileWrite),
`NotebookEdit`, `WebFetch`, `WebSearch`, `TodoWrite`, `Task*`
(Create/Get/Update/List), `TaskOutput`, `TaskStop`, `AskUserQuestion`, `Skill`,
`EnterPlanMode`/`ExitPlanMode`, `SendMessage`, `Brief`, MCP-resource tools
(`ListMcpResources`/`ReadMcpResource`), `ToolSearch`. Feature/flag-gated extras:
`REPL`, `Tungsten`, `Config`, `WebBrowser`, `LSP`, `EnterWorktree`/`ExitWorktree`,
`Workflow`, `Sleep`, Cron tools, `Monitor`, `PowerShell`, `Snip`, swarm
`TeamCreate`/`TeamDelete`.

**Execution path** (`toolExecution.ts:checkPermissionsAndCallTool`, 599):
1. `tool.inputSchema.safeParse(input)` — Zod validation; failure → synthetic
   `<tool_use_error>InputValidationError</tool_use_error>` result (`:616-680`).
2. `tool.validateInput?.(...)` — semantic validation (`:683`).
3. `canUseTool(...)` permission gate (see §6).
4. On deny → error `tool_result` (`:995-1064`); on allow → `await tool.call(...)`
   (`:1207`), then `tool.mapToolResultToToolResultBlockParam` (`:1292`) and a
   disk-spill budget check (`maxResultSizeChars`).

Orchestration (`toolOrchestration.ts:runTools`, 19) partitions the batch:
consecutive **read-only / concurrency-safe** tools run in parallel (`all(...)`,
default concurrency 10, `:8-12`); everything else runs serially. Concurrency
safety is `tool.isConcurrencySafe(parsedInput)`, defaulting false.

## 3. CONTEXT / CONVERSATION MANAGEMENT

**Anchors:** `src/query.ts:365` (`getMessagesAfterCompactBoundary`),
`src/query.ts:413-468` (microcompact→autocompact pipeline),
`src/services/compact/autoCompact.ts:93-145` (`calculateTokenWarningState`),
`autoCompact.ts:147` (`isAutoCompactEnabled`), `src/services/compact/compact.ts`
(`buildPostCompactMessages`), `src/services/compact/prompt.ts:61-131` (8-section
summary prompt), `src/utils/toolResultStorage.ts` (`applyToolResultBudget`).

Message history is an in-memory `Message[]` carried in `State.messages` /
`QueryEngine.mutableMessages`. Each turn the loop slices to the active window with
`getMessagesAfterCompactBoundary()` (a `compact_boundary` system message marks
where pre-compaction history can be dropped — and `QueryEngine` actually
`splice()`s the array on boundary to free memory, `:926-933`).

Token budgeting is **estimation-based**: `tokenCountWithEstimation(messages)`
compared against `getAutoCompactThreshold(model)`. `calculateTokenWarningState`
returns warning/error/auto-compact/blocking flags. There is a hard
`isAtBlockingLimit` (`actualContextWindow - MANUAL_COMPACT_BUFFER_TOKENS`) that,
when autocompact is off, makes the loop yield a `PROMPT_TOO_LONG` error and stop
(`query.ts:628-648`) — reserving room for manual `/compact`.

Compaction is **layered, cheapest-first** (each gated by a `feature()` flag except
autocompact):
- **tool-result budget** (`applyToolResultBudget`) — spills oversized tool results
  to disk, leaving a pointer.
- **snip** (`HISTORY_SNIP`) — removes zombie/stale messages.
- **microcompact** (`deps.microcompact`) — drops old tool-result *content* by
  `tool_use_id` without touching structure; can use API cache-editing.
- **context-collapse** (`CONTEXT_COLLAPSE`) — projects a collapsed view, archiving
  message ranges into a commit-log replayed each turn.
- **autocompact** (always available) — the real summarizer: forks a sub-agent to
  produce an `<analysis>`+`<summary>` (8 sections: intent, technical concepts,
  files & code, errors/fixes, problem solving, user messages, current work, next
  step — `prompt.ts:66-131`), then `buildPostCompactMessages` replaces history
  with `[summary, ...preservedTail]` and the loop continues.

There is also **reactive compaction** (`REACTIVE_COMPACT`): if an actual API
`prompt_too_long` (413) slips through, the error is *withheld* from the SDK
(`query.ts:799-825`), recovery is attempted (collapse drain → reactive compact),
and only if all fail is the error surfaced (`:1062-1183`).

```ts
// src/services/compact/autoCompact.ts:103-136 — the thresholds
const autoCompactThreshold = getAutoCompactThreshold(model)
const threshold = isAutoCompactEnabled() ? autoCompactThreshold : getEffectiveContextWindowSize(model)
const isAboveAutoCompactThreshold = isAutoCompactEnabled() && tokenUsage >= autoCompactThreshold
const blockingLimit = getEffectiveContextWindowSize(model) - MANUAL_COMPACT_BUFFER_TOKENS
const isAtBlockingLimit = tokenUsage >= blockingLimit
```

## 4. PROMPT CONSTRUCTION

**Anchors:** `src/utils/queryContext.ts:44` (`fetchSystemPromptParts`),
`src/constants/prompts.ts:444-580` (`getSystemPrompt`), `src/context.ts:116-189`
(`getSystemContext` / `getUserContext`), `src/utils/api.ts:437-474`
(`appendSystemContext` / `prependUserContext`), `src/QueryEngine.ts:288-325`
(final assembly).

Three pieces form the cache-key prefix, fetched in parallel
(`queryContext.ts:61`):
- **`defaultSystemPrompt: string[]`** — from `getSystemPrompt(tools, model, …)`. A
  list of sections, split into *static cacheable* (intro "You are an interactive
  agent…", tone/style, "doing tasks", tools usage) and *dynamic*
  (`systemPromptSection`: memory prompt, env info, output style, MCP instructions,
  scratchpad, language). A `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` marker separates them
  for the prompt-cache breakpoint (`prompts.ts:572`).
- **`userContext: {claudeMd, currentDate}`** — `context.ts:155`. CLAUDE.md / memory
  files discovered by walking cwd (`getMemoryFiles`), plus today's date.
- **`systemContext: {gitStatus}`** — `context.ts:116`. Git branch/status/recent
  commits, snapshotted once at session start.

Final assembly (`QueryEngine.ts:321`):
`systemPrompt = [customPrompt ?? ...defaultSystemPrompt, memoryMechanicsPrompt?,
appendSystemPrompt?]`. At call time `appendSystemContext` joins `systemContext`
onto the **end of the system prompt** (`api.ts:437`), while `prependUserContext`
injects `userContext` (CLAUDE.md + date) as a **`<system-reminder>` user message
at the front of the message array** (`api.ts:449-474`) — note memory is a *user*
message, not part of the system prompt, so it can be cache-stable separately.

Tool descriptions are injected as the API `tools` array, each tool's
`description` = `await tool.prompt(...)` (`api.ts:171`). Reminders/attachments
(file-changed, memory, skill-discovery, queued commands) are appended as extra
user/attachment messages after tool results each turn (`query.ts:1580-1628`).

```ts
// src/utils/api.ts:449-474 — CLAUDE.md/memory injected as a leading user turn
return [ createUserMessage({
  content: `<system-reminder>\nAs you answer the user's questions, you can use the following context:\n` +
    Object.entries(context).map(([k, v]) => `# ${k}\n${v}`).join('\n') +
    `\n\n  IMPORTANT: this context may or may not be relevant ... </system-reminder>\n`,
  isMeta: true }), ...messages ]
```

## 5. MODEL / PROVIDER I/O

**Anchors:** `src/services/api/claude.ts:752` (`queryModelWithStreaming`),
`claude.ts:1017` (`queryModel`), `claude.ts:1823` (`anthropic.beta.messages.create`),
`claude.ts:1940-2300` (SSE event loop), `src/services/api/withRetry.ts:170`
(`withRetry`), `src/utils/api.ts:119` (`toolToAPISchema`), `src/query/deps.ts`
(`callModel` injection seam).

The provider abstraction is thin and Anthropic-specific. `query()` calls the
model through `deps.callModel` (`query/deps.ts` — a dependency-injection seam used
for tests/VCR), which resolves to `queryModelWithStreaming` → `queryModel`. The
underlying client is the official `@anthropic-ai/sdk` (`anthropic.beta.messages
.create`, `claude.ts:1823`), with provider routing for first-party Anthropic vs
Bedrock/Vertex/proxy gateways (which gates off beta fields like
`eager_input_streaming`/`defer_loading`, `api.ts:197-237`).

**Streaming parse** (`claude.ts:1940`): a `for await (const part of stream)` over
SSE events accumulates content blocks by index:
- `message_start` → capture `usage`, TTFT.
- `content_block_start` → seed `contentBlocks[index]` (tool_use input as `''`
  string, text/thinking empty).
- `content_block_delta` → append: `input_json_delta` → `block.input += partial_json`,
  `text_delta` → `block.text +=`, `thinking_delta`/`signature_delta` → thinking.
- `message_delta` → final `usage` + `stop_reason`; `message_stop` → finalize.

Tool-call extraction is therefore: accumulate `input_json_delta` strings per
tool_use block, then JSON-parse the assembled string at block close. The assistant
message is emitted with `stop_reason: null` at block stop, and the real
`stop_reason` arrives on `message_delta` (QueryEngine reconciles this,
`QueryEngine.ts:797-808`).

**Retries** (`withRetry.ts:170`): a `for (attempt = 1..maxRetries+1)` loop.
429/529 → honor `retry-after`, else exponential backoff; 529 ("overloaded") capped
at `MAX_529_RETRIES = 3` and only retried for foreground query sources. A separate
**model-fallback** mechanism: a `FallbackTriggeredError` makes the agent loop
switch `currentModel = fallbackModel` and re-issue the whole request
(`query.ts:893-951`), tombstoning the orphaned partial messages. There's also a
streaming→non-streaming fallback (`executeNonStreamingRequest`, `claude.ts:818`).

```ts
// src/services/api/claude.ts:2087-2125 — tool-call assembly during the SSE stream
case 'input_json_delta':
  if (contentBlock.type !== 'tool_use' && contentBlock.type !== 'server_tool_use') throw new Error(...)
  contentBlock.input += delta.partial_json            // accumulate raw JSON text
  break
case 'text_delta':
  contentBlock.text += delta.text
  break
```

## 6. PERMISSIONS / SANDBOXING / APPROVAL

**Anchors:** `src/hooks/useCanUseTool.tsx:27-203` (`CanUseToolFn` + dispatch),
`src/utils/permissions/permissions.ts:1071-1156` (`checkRuleBasedPermissions`),
`permissions.ts:1158+` (`hasPermissionsToUseToolInner`),
`src/Tool.ts:123-148` (`ToolPermissionContext`),
`src/utils/sandbox/sandbox-adapter.ts:532` (`isSandboxingEnabled`),
`src/tools/BashTool/shouldUseSandbox.ts`, `src/services/tools/toolExecution.ts:995`
(deny → error result).

Every `tool.call()` is gated by `canUseTool` (passed down from
`QueryEngine`/REPL). The decision function `hasPermissionsToUseTool` evaluates
rules in a fixed precedence (`permissions.ts`), returning
`{behavior: 'allow' | 'deny' | 'ask', updatedInput?, decisionReason, message}`:

1. **1a deny-rule** for the whole tool → `deny` (`:1078-1089`).
2. **1b ask-rule** for the whole tool → `ask` (unless sandbox can auto-allow).
3. **1c `tool.checkPermissions(input, ctx)`** → tool-specific logic (e.g. Bash
   subcommand prefix rules), can return deny/ask/allow/passthrough.
4. **1f/1g** content-specific ask rules and **bypass-immune safety checks**
   (`.git/`, `.claude/`, settings files) which prompt *even in
   `bypassPermissions` mode* (`:1144-1152`).
5. **mode handling**: `default` (prompt on writes), `plan` (deny mutating tools),
   `acceptEdits` (auto-allow edits), `bypassPermissions` (allow all except safety
   checks), `auto` (LLM classifier decides). `permissions.ts:1269` allows when mode
   is `bypassPermissions` or model-initiated `plan`.

`useCanUseTool` (`useCanUseTool.tsx:32`) wraps this: if the decision is `allow` it
resolves immediately; if `deny`/`ask` it computes a human-readable description and
routes to the right handler — coordinator, swarm-worker, or **interactive**
(`handleInteractivePermission`, which shows the approval UI and can persist a new
always-allow rule). For Bash, a **classifier** (`BASH_CLASSIFIER`) runs
speculatively in parallel and can auto-approve high-confidence-safe commands.

On `deny`, `toolExecution.ts:995` short-circuits and returns an `is_error`
`tool_result` to the model rather than running the tool. Permission denials are
tracked and reported in the SDK result (`QueryEngine.ts:262-268`).

**Sandbox**: an OS-level sandbox (`sandbox-adapter.ts`) wraps bash when enabled —
`bwrap` (bubblewrap) on Linux, Seatbelt (`sandbox-exec`) on macOS. It derives
read-only/writable path sets and an allowed-network-domain list from settings
(`sandbox.filesystem.*`, `sandbox.network.allowedDomains`), always denying writes
to settings/`.claude` to prevent escape (`:230-254`). When a command *is*
sandboxed, the permission system can auto-allow it (`shouldUseSandbox` +
`isAutoAllowBashIfSandboxedEnabled`, `permissions.ts:1094-1099`).

```ts
// src/utils/permissions/permissions.ts:1078-1089 — first gate
const denyRule = getDenyRuleForTool(appState.toolPermissionContext, tool)
if (denyRule) return {
  behavior: 'deny',
  decisionReason: { type: 'rule', rule: denyRule },
  message: `Permission to use ${tool.name} has been denied.`,
}
```

## 7. SUB-AGENTS / MCP / ORCHESTRATION

**Anchors:** `src/tools/AgentTool/AgentTool.tsx:130+` (`call`),
`src/tools/AgentTool/runAgent.ts:248` (`runAgent`), `runAgent.ts:700`
(`createSubagentContext`), `runAgent.ts:748` (recursive `query(...)`),
`src/constants/prompts.ts:758` (`DEFAULT_AGENT_PROMPT`),
`src/tools/AgentTool/loadAgentsDir.ts` (custom agent defs),
`src/services/mcp/client.ts:7-38` (MCP SDK transports), `src/tools/tools.ts:345`
(`assembleToolPool`), `src/coordinator/coordinatorMode.ts`.

**Sub-agents** are the recursion case of the *same* loop. `AgentTool.call()`
selects an `AgentDefinition` (built-in `general-purpose`, a `subagent_type` from
`.claude/agents`, or a fork), builds an isolated `ToolUseContext` via
`createSubagentContext` (own `agentId`, abort controller, filtered tools, possibly
no-op `setAppState`), then runs `query()` over the child's messages
(`runAgent.ts:748`) and streams results back, finally returning the agent's last
text as the parent's `tool_result`. Agents can run **synchronously**, **in
parallel** (`AgentTool.isConcurrencySafe() === true`, `:1273`), or **in the
background** (`run_in_background`), and even in an isolated git **worktree** or a
**remote** environment. Agent tool-sets are restricted by allow/deny lists in
`constants/tools.ts` (`ALL_AGENT_DISALLOWED_TOOLS`, `ASYNC_AGENT_ALLOWED_TOOLS`,
`COORDINATOR_MODE_ALLOWED_TOOLS`). A **coordinator mode** (feature-gated) turns the
main thread into a dispatcher whose workers are subagents.

**MCP** (`services/mcp/client.ts`) wraps the official
`@modelcontextprotocol/sdk` `Client` with all four transports: stdio, SSE,
StreamableHTTP, plus an in-process `InProcessTransport` and an
`SdkControlTransport`. The connection manager lists tools/resources from each
server; MCP tools are adapted into the `Tool` interface (carrying
`inputJSONSchema`, `isMcp: true`, `mcpInfo`) and merged into the pool by
`assembleToolPool` (built-ins win name conflicts, `tools.ts:345-367`). MCP tools
can be deferred behind `ToolSearch` (`defer_loading`) so hundreds of them don't
bloat the prompt. claude-code can also act as an MCP *server*
(`src/entrypoints/mcp.ts`).

```ts
// src/tools/AgentTool/runAgent.ts:748 — a subagent is just query() again
for await (const message of query({
  messages: initialMessages,
  systemPrompt: agentSystemPrompt,           // DEFAULT_AGENT_PROMPT or custom
  userContext: resolvedUserContext,
  systemContext: resolvedSystemContext,
  canUseTool,
  toolUseContext: agentToolUseContext,       // createSubagentContext(...)
  querySource,
  maxTurns: maxTurns ?? agentDefinition.maxTurns,
})) { /* forward/record messages, capture final text */ }
```

## 8. ESSENTIAL vs BLOAT

| Concern | Essential (any agent) | claude-code specifics worth knowing | Bloat for a lean framework |
|---|---|---|---|
| **Loop** | `while(true)`: build→call→parse tool_use→exec→append→repeat; exit on no-tool-use (`query.ts:307,1062`) | `State` object + `transition` tags; back-fill missing `tool_result`s | streaming-tool-execution, max-output-tokens escalation, token-budget auto-continue, BG task summaries |
| **Tools** | `name`, Zod `inputSchema`, `description`/`prompt()`, `call()`, result→block mapper (`Tool.ts`) | `buildTool()` fail-closed defaults; concurrency partitioning | ~30 React render methods, `extractSearchText`, grouped rendering, tool-search deferral |
| **Provider** | one streaming call, SSE block accumulation, tool_call JSON assembly (`claude.ts:1940`) | model-fallback + non-streaming fallback; VCR seam | Bedrock/Vertex/proxy field-stripping, advisor blocks, fast-mode, prompt-dump |
| **Context** | token estimate vs threshold → summarize → continue (`autoCompact.ts`) | 8-section summary prompt; compact-boundary slicing | 4 extra compaction tiers (snip/micro/collapse/reactive) behind flags |
| **Prompt** | system prompt + tool schemas + memory/env injection (`prompts.ts`, `context.ts`) | memory injected as a leading `<system-reminder>` *user* msg; cache boundary marker | output styles, GrowthBook-gated sections, numeric length anchors |
| **Permissions** | gate before `call()`: allow/deny/ask, mode (`permissions.ts`) | layered rule precedence; bypass-immune safety paths | bash LLM classifier, auto-mode, coordinator/swarm handlers |
| **Sub-agents** | recurse the loop with a child context + filtered tools (`runAgent.ts`) | sync/parallel/background/worktree/remote | remote CCR, agent memory snapshots, color management |
| **MCP** | adapt external tools into the tool interface | 5 transports + acts as server | OAuth/elicitation/channel allowlists |
| **Persistence/UI** | — | transcript recording, resume | the entire 800 KB `main.tsx` Ink TUI, vim mode, cost tracking, telemetry |

A minimal port needs ~5 files: an agent-loop generator, a `Tool` type +
`zodToJsonSchema`, a streaming provider client with SSE block accumulation, a
permission `allow/deny/ask` gate, and a threshold-triggered summarizer. Everything
else in this repo is product surface.

## Ideas worth stealing

1. **The loop's only exit signal is "no `tool_use` block,"** not `stop_reason`
   (`query.ts:553-557,1062`). Robust against unreliable stop reasons.
2. **Always back-fill a `tool_result` for every emitted `tool_use`**
   (`yieldMissingToolResultBlocks`, `query.ts:123`) — even on crash/abort/fallback
   — so the next API call never 400s on unpaired blocks.
3. **Mutable `State` + `transition` tag** (`query.ts:204-217`): every retry path
   (model fallback, compaction, output-token recovery, stop-hook block, budget
   continuation) is just `state = {...}; continue`, and the tag makes the reason
   testable without inspecting message contents.
4. **`buildTool()` fail-closed defaults** (`Tool.ts:757`): omit a method, get the
   safe default (`isReadOnly→false`, `checkPermissions→allow-deferred`,
   `isConcurrencySafe→false`). Keeps tool definitions tiny.
5. **Read-only/concurrency-safe tools auto-batch in parallel** while writes run
   serially (`toolOrchestration.ts:91-116`) — a free latency win driven entirely
   by one `isConcurrencySafe(input)` predicate.
6. **Memory/CLAUDE.md as a leading `<system-reminder>` user message**, not in the
   system prompt (`api.ts:449`): keeps the system-prompt prefix cache-stable while
   still injecting per-session context, and the "may or may not be relevant"
   framing curbs over-anchoring.
7. **Cheapest-compaction-first cascade** culminating in a structured 8-section
   summary, with a *reactive* path that withholds a real 413 from the consumer,
   recovers, and retries before surfacing the error (`query.ts:799-1183`).
8. **Sub-agents are literally the same `query()` recursed** with a filtered tool
   set and child context (`runAgent.ts:748`) — no separate "agent runtime," and
   parallelism falls out of the same concurrency machinery.
9. **Dependency-injection seam (`deps.callModel`, `query/deps.ts`)** makes the
   whole loop testable/VCR-able without mocking the network.
10. **Disk-spill tool results over `maxResultSizeChars`** (`Tool.ts:466`,
    `toolResultStorage.ts`): huge outputs become a file pointer + preview instead
    of blowing the context window.
