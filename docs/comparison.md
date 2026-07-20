# Cross-Repo Comparison — 5 Coding-Agent Codebases

Repos compared: **claude-code** (leaked TS), **opencode** (TS / Bun / Effect-TS),
**openclaude** (TS, multi-provider fork of Claude Code), **codex** (Rust), **goose** (Rust).

Source maps: [claude-code.md](./claude-code.md) · [opencode.md](./opencode.md) ·
[openclaude.md](./openclaude.md) · [codex.md](./codex.md) · [goose.md](./goose.md).

Every cell is terse with a `file:line` pointer into that repo. The striking
finding is **convergence**: five independently-built agents land on the same
kernel — a `while(true)` turn loop, a `{name, JSON-schema, call}` tool, a
streaming provider call with tool-call extraction, full-history-resend + threshold
compaction, and an allow/ask/deny gate. They diverge mostly in *how much product
surface* they pile on top.

---

## The big table — one row per dimension, one column per repo

| Dimension | claude-code (TS) | opencode (TS/Effect) | openclaude (TS, multi-provider) | codex (Rust) | goose (Rust) |
|---|---|---|---|---|---|
| **Agent loop** | `while(true)` async-gen `queryLoop`, mutable `State`+`continue` per retry; exit on no `tool_use` block `query.ts:307,1062` | `while(true)` `runLoop` re-derives state from SQLite history each turn; exit when last finish≠tool-calls `prompt.ts:1081` | `while(true)` async-gen, single mutable `state` reassigned+`continue`; exit on `!needsFollowUp` `query.ts:497,1442` | two nested loops: outer steer `regular.rs:73`, inner `run_turn` `turn.rs:225`; one bool `needs_follow_up` | `async_stream` `loop{}` yielding typed `AgentEvent`s; exit on no tools + no override `agent.rs:1888` |
| **Loop exit signal** | presence of `tool_use` block, **not** `stop_reason` (distrusted) `query.ts:553` | last assistant `finish` terminal + no unexecuted tool calls + newer than user msg `prompt.ts:53` | presence of streamed `tool_use` block, `stop_reason` distrusted `query.ts:856` | `needs_follow_up` = tool-call-seen OR `end_turn=false` OR pending input `turn.rs:90` | `no_tools_called` (then goal/grind/hook overrides can veto) `agent.rs:2513` |
| **Tool interface** | structural `Tool<In,Out>` ~40 members; core: name, Zod schema, `prompt()`, `call()`, `checkPermissions`, result-mapper `Tool.ts:362` | `Tool.Def {id, desc, Effect Schema, execute→Effect}` `tool.ts:55` | `Tool<In,Out,P>` via `buildTool()`, Zod schema + `call`+`checkPermissions` `Tool.ts:391,812` | one trait `ToolExecutor`: `spec()`+`handle()` `tool_executor.rs:49` | `rmcp::model::Tool` (name+JSON-schema+annotations) served via `McpClientTrait` `mcp_client.rs:78` |
| **Schema → model** | `zodToJsonSchema` at request time `api.ts:160` | Effect Schema → JSON-Schema, AI-SDK `tool({inputSchema})` `tools.ts:89` | `zodToJsonSchema`; MCP tools carry raw `inputJSONSchema` `Tool.ts:423` | `ToolSpec` serde enum *is* a Responses-API tool `tool_spec.rs:17` | `schemars` derives JSON-Schema from Rust structs `developer/mod.rs:106` |
| **Tool registration** | hand-written array `getAllBaseTools()`, feature-gated `tools.ts:193` | registry builds ~15 builtins + custom files + plugins/MCP `registry.ts:82` | hand-written feature-gated array `getAllBaseTools()` `tools.ts:182` | per-turn `planned_tools.add(Handler::new())` `spec_plan.rs:612` | extensions (`Stdio/Sse/Http/Builtin/Frontend`) each an MCP client `extension.rs:163` |
| **Tool defaults** | `buildTool()` fail-closed: readonly→false, concurrencySafe→false, perms→allow `Tool.ts:757` | `wrap()` decorates execute (decode args + truncate) `tool.ts:113` | `buildTool()` spreads `TOOL_DEFAULTS` fail-closed `Tool.ts:786` | trait defaults: `supports_parallel→false`, `exposure→Direct` `tool_executor.rs:49` | `ToolAnnotations` (read_only/destructive) drive perms, no factory `developer/mod.rs:108` |
| **Parallel tools** | auto-batch consecutive concurrency-safe in parallel (cap 10), writes serial `toolOrchestration.ts:91` | AI-SDK `streamText` executes inline; no explicit batching | partition read-only/safe parallel, serialize writers `toolOrchestration.ts:91` | `FuturesOrdered` drained post-stream, `RwLock` read=parallel/write=serial `parallel.rs:62` | `ToolStream`s `select_all` drained in `tokio::select!` `agent.rs:2179` |
| **Context / history** | in-mem `Message[]`, slice after compact boundary `query.ts:365` | SQLite source of truth, reload+rederive each turn `message-v2.ts:585` | `Message[]`, slice after boundary `query.ts:564` | `Vec<ResponseItem>` resent **in full** each turn `history.rs:38,141` | `Vec<Message>` w/ dual `user_visible`/`agent_visible` flags `context_mgmt:141` |
| **Token budget** | estimate vs `getAutoCompactThreshold(model)` `autoCompact.ts:103` | `usable = limit.input − reserved(~20k)`; `isOverflow` `overflow.ts:10` | `effectiveWindow − AUTOCOMPACT_BUFFER` `autoCompact.ts:170` | coarse byte heuristic `approx_token_count` `history.rs:160` | token-ratio vs `GOOSE_AUTO_COMPACT_THRESHOLD` 0.8 `context_mgmt:188` |
| **Compaction** | cheapest-first cascade → 8-section LLM summary → `[summary,…tail]` `compact.ts`, `prompt.ts:61` | hidden compaction-agent summary + `filterCompacted` hides pre-summary; cheap `prune` `compaction.ts:289` | 5 layers: budget→snip→micro→collapse→autocompact `query.ts:584` | inline summarize → rebuild `[init]+[recent≤20k]+[summary]` `compact.rs:585` | LLM summarize, mark old `agent_invisible`; per-tool-pair + middle-out `context_mgmt:67,242` |
| **System prompt** | `string[]` sections, static-cacheable prefix + dynamic suffix at boundary marker `prompts.ts:444` | assembled at request: base(per-model) + env + memory + mcp + skills `request.ts:56` | sections split by `DYNAMIC_BOUNDARY` marker `prompts.ts:440` | `BaseInstructions` sent via Responses `instructions` field (not in messages) `turn.rs:1044` | MiniJinja `system.md` + extension instructions + counts `prompt_manager.rs:117` |
| **Memory injection** | CLAUDE.md as leading `<system-reminder>` **user** msg `api.ts:449` | AGENTS.md/CLAUDE.md walked from cwd, "Instructions from: <path>" `instruction.ts:60` | CLAUDE.md/AGENTS.md via `loadMemoryPrompt` dynamic section + prepended userContext `prompts.ts:491` | AGENTS.md as `user` item, env as diffed `<filesystem>` context item `agents_md.rs:47` | `.goosehints`/AGENTS.md/CLAUDE.md as `hints` extra, lazy subdir reload `load_hints.rs:225` |
| **Provider I/O** | thin, Anthropic-specific `@anthropic-ai/sdk` via `deps.callModel` seam `claude.ts:752` | Vercel AI SDK `streamText`, lazy-load 25+ `@ai-sdk/*` `provider.ts:108` | **canonical = Anthropic**; non-Anthropic via duck-typed shim `{beta,messages}` `openaiShim.ts:4429` | **Responses API only**, HTTP-SSE or WebSocket `client.rs:1728` | `Provider::stream` trait → `MessageStream`; `complete=collect_stream` `base.rs:386` |
| **Stream parse** | for-await SSE, accumulate content blocks by index `claude.ts:1940` | AI-SDK owns SSE; `toLLMEvents` normalizes to internal events `ai-sdk.ts:76` | per-transport SSE→Anthropic-event translators `openaiShim.ts:1998` | SSE `kind` string → typed `ResponseEvent` enum `sse/responses.rs:315` | hand-rolled SSE state machine per format `formats/anthropic.rs:733` |
| **Tool-call assembly** | accumulate `input_json_delta`, JSON-parse at block close `claude.ts:2087` | AI-SDK's job; `repairToolCall` fixes name casing `llm.ts:296` | accumulate `delta.tool_calls` JSON; recover text/XML tool-calls from weak models `openaiShim.ts:1578,1680` | arrive as ordinary `output_item.done` items, extracted by router `router.rs:108` | accumulate partial JSON per content block in SSE parser `formats/anthropic.rs` |
| **Retries / fallback** | `withRetry` backoff, 529 cap 3; model-fallback via `FallbackTriggeredError` `withRetry.ts:170` | Effect retry policy keyed on provider `retry.ts` | `withRetry` + `FallbackTriggeredError` swap to fallback model `query.ts:1277` | exp backoff, prefer server retry-after; reuse session `responses_retry.rs:22` | `RetryConfig` backoff; `should_retry` classifies transient `retry.rs:14,84` |
| **Permission model** | layered rule precedence: deny→ask→`checkPermissions`→safety→mode `permissions.ts:1071` | ordered wildcard rule list, **last-match-wins**, default ask `permission/index.ts:28` | 4-mode rule engine + bypass + safety-immune checks `permissions.ts:1089` | two gates: execpolicy Allow/Prompt/Forbidden + `AskForApproval` mode `safety.rs:32` | mode enum + ordered inspector pipeline (Security→…→Permission→Repetition) `agent.rs:621` |
| **Approval surface** | interactive UI handler, can persist always-allow rule `useCanUseTool.tsx:32` | block on `Deferred` until UI reply; "always"→append allow rule `index.ts:67` | interactive UI or auto-deny headless; LLM classifier in auto mode `permissions.ts:1185` | approval `EventMsg` blocks for `ReviewDecision`; remember→allow-prefix rule `safety.rs` | `ActionRequired` event → host prompt → `handle_confirmation`; headless hard-errors `session/mod.rs:1219` |
| **Sandbox (OS)** | `bwrap` (Linux) / Seatbelt (macOS), derives path+net sets `sandbox-adapter.ts:532` | **none** — ask-before-side-effect only `index.ts` | `@anthropic-ai/sandbox-runtime` (bwrap Linux) `sandbox-adapter.ts:550` | **real**: Seatbelt/Landlock+seccomp/restricted-token via argv-rewrite/self-re-exec `manager.rs:60` | **none** by default; optional `Container` opt-in `container.rs` |
| **Deny → result** | deny returns `is_error` tool_result, not abort `toolExecution.ts:995` | reject throws `Rejected`/`Corrected` (feedback to model) `index.ts` | deny → `is_error` tool_result block `toolExecution.ts:1147` | `RespondToModel` feeds error as tool result; `Fatal` aborts `registry.rs:405` | inspector `Deny` → placeholder tool response; hook `Deny` `agent.rs:1064` |
| **Sub-agents** | same `query()` recursed w/ child context + filtered tools `runAgent.ts:748` | `task` tool spawns child Session, runs same `prompt` loop `task.ts:142` | same `query()` recursed + `agentStepLimit` `runAgent.ts:800` | fork child thread w/ filtered rollout, TOML roles, spawn/wait tools `agent/control/spawn.rs` | nested `Agent` instance via `run_subagent_task`; orchestrator peer sessions `subagent_handler.rs:48` |
| **MCP** | official SDK, 5 transports (stdio/SSE/HTTP/in-proc/sdk); MCP tools→`Tool`; can be server `mcp/client.ts:7` | official SDK stdio/SSE/HTTP+OAuth; MCP tools merged w/ blanket ask `mcp/index.ts:7` | official SDK 5 transports+OAuth; can be MCP server + gRPC server `mcp/client.ts:7` | `rmcp` crate stdio/StreamableHTTP+OAuth; MCP tools are `ToolExecutor` handlers; can be server `mcp.rs:43` | **MCP is the only tool bus**; builtins also MCP; full surface (resources/prompts/notifications) `mcp_client.rs:78` |
| **Primary language/runtime** | TypeScript / Bun bundle | TypeScript / Bun / Effect-TS / SQLite | TypeScript / Bun build, Node runtime | Rust / tokio | Rust / tokio / async-streams |

---

## Instructive contrasts (prose)

### How each does the core loop

All five are the same shape — *call model, look for tool calls, run them, append
results, repeat, stop when the model stops asking for tools* — but they differ on
**where loop state lives** and **what signals "stop"**.

- **claude-code / openclaude** carry a single mutable `State` object and express
  *every* control-flow branch (model fallback, compaction, token-budget continue,
  recovery) as `state = {...}; continue` (`query.ts:204`). This makes the loop a
  flat `while(true)` where each retry path is uniform and testable via a
  `transition` tag — no nested state machine.
- **opencode** is the cleanest idea: it holds **no** mutable conversation object.
  Each turn it reloads history from SQLite, re-derives "latest user / latest
  finished assistant / pending tasks" by max-id, and decides stop/continue from
  that (`prompt.ts:1081`, `message-v2.ts:585`). Cancel, resume, and compaction are
  correct *by construction* because persisted history is the only source of truth.
- **codex** uses **two nested loops** — an outer "steering" loop that re-runs a
  turn when the user typed input mid-turn, and an inner `run_turn`. Its stop
  decision collapses to one boolean `needs_follow_up` (`turn.rs:90`).
- **goose** makes the whole turn an `async_stream` of typed `AgentEvent`s
  (`agent.rs:1888`), so CLI/server/desktop all consume the same event stream with
  first-class cancellation — at the cost of several "keep going" overrides
  (goal/grind/stop-hook) bolted onto the simple "stop when no tools" rule.

**The single most-shared, most-important lesson:** four of five explicitly
**distrust `stop_reason`** and key the loop off the *presence of a tool-call block*
instead (claude-code `query.ts:553`, openclaude `query.ts:856`, codex's
`needs_follow_up`, goose's `no_tools_called`). Providers set stop reasons
inconsistently; the content is authoritative.

### Streaming tool-call parsing

This is where the provider layer earns its keep, and the repos split into three
camps:

- **Hand-rolled SSE accumulation** (claude-code, openclaude, goose, codex): read
  the event stream, accumulate `input_json_delta` / `delta.tool_calls` /
  partial-JSON per content block keyed by index, and **JSON-parse the assembled
  string only at block close** (claude-code `claude.ts:2087`, goose
  `formats/anthropic.rs:733`). codex is subtly different: tool calls are *not*
  special-cased in the SSE layer at all — they arrive as ordinary
  `output_item.done` items and a separate router extracts them (`router.rs:108`),
  which cleanly separates "parse the stream" from "interpret tool calls".
- **Delegate to a vendor SDK** (opencode): `streamText` from the Vercel AI SDK
  owns SSE parsing *and* tool dispatch; opencode only normalizes the SDK's stream
  parts into an internal `LLMEvent` union (`ai-sdk.ts:76`). Lowest effort, highest
  dependency.
- **Canonical-format-as-interface** (openclaude): the boldest design. The whole
  codebase speaks Anthropic Messages; each non-Anthropic provider is a *shim* that
  duck-types the Anthropic client (`{beta, messages}`), converts requests out, and
  runs a **per-transport SSE translator** that re-emits Anthropic-shaped stream
  events (`openaiShim.ts:1998`). The loop, tools, and compaction never branch on
  provider. It even recovers tool calls that weak local models (Ollama/GLM/Qwen)
  emit as plain text or XML (`parseTextToolCalls`/`parseXmlToolCalls`).

For a lean framework: hand-roll one provider's SSE accumulator (it's ~150 lines),
and if you want multi-provider later, copy openclaude's "translate to one canonical
event shape" seam rather than branching everywhere.

### Context compaction

Everyone resends a lot of history and compacts on a token threshold, but the
sophistication varies wildly:

- **codex** is the leanest and most honest: it resends the **entire** transcript
  every turn (no sliding window), estimates tokens with a *byte heuristic* (not a
  tokenizer), and when over budget does one inline pass — summarize, then rebuild
  history as `[initial_context] + [recent user msgs ≤20k] + [summary]`
  (`compact.rs:585`). No state machine; just `continue`.
- **claude-code / openclaude** build a **cheapest-first cascade** (tool-result
  disk-spill budget → snip → microcompact → context-collapse → LLM autocompact),
  most tiers behind feature flags, ending in an 8-section structured summary
  (`prompt.ts:61`). Plus a *reactive* path that withholds a real 413 from the
  consumer and retries recovery before surfacing the error. Powerful, but only the
  final LLM-summary tier is essential.
- **goose** has the most reusable idea: **dual visibility flags**
  (`user_visible` vs `agent_visible`). Compaction marks old messages
  `agent_invisible` — hidden from the model but still in the user's transcript — so
  compaction is non-destructive and replay stays clean (`context_mgmt:141`). It
  also does per-tool-pair summarization and "middle-out" tool-response thinning.
- **opencode** splits into LLM compaction (a hidden compaction agent + a
  `filterCompacted` view) and a cheap non-LLM `prune` that just marks old tool
  outputs compacted once enough recent tokens are protected (`compaction.ts:243`).

Lean takeaway: start with codex's one-pass `summarize → [init]+[recent]+[summary]`
triggered by a byte-heuristic threshold; adopt goose's dual-visibility flags so you
never destroy the transcript.

### Permission models

Two philosophies, and an orthogonal sandbox axis:

- **Rule lists** — opencode's is the most elegant: a flat ordered list of
  `{permission, pattern, action}`, **last wildcard match wins**, default `ask`
  (`index.ts:28`). "Always allow" answers simply append a new allow rule at
  runtime; rulesets (agent defaults / user config / session) just concatenate.
  claude-code and openclaude use a fixed *precedence* (deny → ask →
  `tool.checkPermissions` → safety → mode) which is more rigid but has
  **bypass-immune safety checks** (writes to `.git`/`.claude`/settings always
  prompt, even in bypass mode) — a good safety floor.
- **Two-gate** (codex) — orthogonal layers: *whether to run* (an execpolicy rule
  engine + `AskForApproval` mode → Allow/Ask/Reject) vs *how to run safely* (pick
  an OS sandbox). It's the only repo with a **real** sandbox, enforced not by
  in-process trust but by **rewriting the argv** (prepend `sandbox-exec` on macOS;
  re-exec the binary as a Landlock+seccomp helper on Linux). claude-code/openclaude
  also have an OS sandbox (`bwrap`); **opencode and goose have no OS sandbox** and
  rely entirely on ask-before-side-effect (goose adds an opt-in container).
- **Inspector pipeline** (goose) — an ordered list of pluggable `ToolInspector`s
  (Security → Egress → Adversary → Permission → Repetition) each returning
  Allow/Deny/RequireApproval (`agent.rs:621`). Adds policy without touching the
  loop. goose's standout: **tool annotations** (`read_only_hint`) drive
  SmartApprove so reads auto-allow and writes gate with zero per-tool config.

Universal pattern worth copying: **a denial is not an abort** — every repo turns a
denied/failed tool into an `is_error` tool_result (or codex's `RespondToModel`) fed
back to the model so it self-corrects. Same for schema-validation failures
(opencode's `InvalidArgumentsError.message` becomes the tool result).

### Sub-agents and MCP

Unanimous verdict: **a sub-agent is just the same loop recursed with a narrower
context.** Nobody builds a separate "agent runtime." claude-code/openclaude
recurse `query()` with a child context + filtered tools (`runAgent.ts:748`),
opencode spawns a child Session and runs the same `prompt` loop, codex forks a
child thread with a filtered rollout, goose instantiates a nested `Agent` and calls
`reply` (`subagent_handler.rs:48`). Parallelism reuses the same tool-concurrency
machinery.

For MCP, the cleanest design is **goose's**: MCP is the *only* tool interface, and
even built-in shell/edit are served through an in-process `McpClientTrait` — one
dispatch path, one schema format, the whole MCP ecosystem for free. codex achieves
the same uniformity by wrapping MCP tools in the same `ToolExecutor` trait as
built-ins (`handlers/mcp.rs:67`). The TS repos adapt MCP tools into their `Tool`
interface and merge them into the pool (built-ins win name conflicts).

---

## Ranked: what each repo does best

1. **opencode — reload-and-rederive loop state.** Holding *no* mutable
   conversation object and re-deriving loop state from persisted history each turn
   (`message-v2.ts:585`) makes cancellation, resume, and compaction correct by
   construction. Also: permissions as an ordered last-match-wins wildcard rule list
   (`index.ts:28`), and tree-sitter-parsing bash to ask per real sub-command.
2. **codex — orthogonal two-gate side-effect safety + real sandbox.** Separating
   *whether to run* from *how to run safely*, with the sandbox enforced by
   argv-rewriting / binary self-re-exec (`manager.rs:60`) so there's no in-process
   trust, is the strongest security design here. Also: spec+runtime in one trait
   (`ToolExecutor`), and the single `needs_follow_up` predicate.
3. **goose — MCP as the universal tool bus + dual message visibility.** One
   dispatch path for built-ins and remote tools (`mcp_client.rs:78`), tool
   annotations driving permissions, and non-destructive compaction via
   `user_visible`/`agent_visible` flags (`context_mgmt:141`). The whole turn as a
   typed event stream is the best UI seam.
4. **claude-code — the battle-tested core-loop ergonomics.** Mutable `State` +
   `transition` tag making every retry a `state={...};continue`
   (`query.ts:204`); always back-filling a synthetic `tool_result` for any emitted
   `tool_use` so the next request never 400s on unpaired blocks (`query.ts:123`);
   memory injected as a leading `<system-reminder>` *user* message to keep the
   system-prompt cache stable (`api.ts:449`); the `deps.callModel` DI seam for a
   testable/VCR-able loop.
5. **openclaude — canonical-format-as-interface for multi-provider.** Make every
   provider a shim that duck-types one canonical client (`openaiShim.ts:4429`) and
   per-transport SSE translators that all emit the same event shape
   (`openaiShim.ts:1998`), so nothing downstream branches on provider — plus
   real-world robustness recovering text/XML tool calls from weak local models.

**Honest disagreements between the repos** (decisions a lean builder must pick a
side on): full-history-resend (codex) vs sliding-window-after-boundary
(claude-code/openclaude); in-memory mutable state (claude-code) vs reload-from-DB
each turn (opencode); fixed permission *precedence* (claude-code) vs ordered
*last-match-wins rule list* (opencode); OS sandbox (codex, claude-code) vs
ask-only with no sandbox (opencode, goose); hand-rolled SSE (codex, goose,
claude-code) vs delegating to a vendor SDK (opencode); one provider/wire-format
(codex = Responses only) vs many via a shim (openclaude = 12+). There is no
consensus on any of these — see [BLUEPRINT.md](./BLUEPRINT.md) for the opinionated
lean defaults.
