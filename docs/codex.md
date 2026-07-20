# Codex (Rust) — Architecture Map for Building a Lean Agent

Repo: `openai/codex`, the `codex-rs/` Rust workspace. This map targets the engine
(`codex-rs/core`) plus the tool, sandbox, prompt, provider, and MCP crates. All
anchors are relative to the repo root (`codex-rs/...`). Everything below was read
from source; quotes are real.

> Orientation note: the classic single `core/src/codex.rs` god-file is **gone** in
> this version. The engine is split into `core/src/session/` (state + the turn
> loop), `core/src/tasks/` (task drivers), `core/src/tools/` (tool router/registry/
> handlers), and `core/src/client.rs` + `codex-api/` (provider I/O). The agent loop
> lives in `core/src/session/turn.rs`.

## TL;DR (5 bullets)

- **Two nested loops.** Outer driver `RegularTask::run` (`tasks/regular.rs:73`)
  re-runs a turn while the user steered in new input; inner `run_turn`
  (`session/turn.rs:142`) loops model-call → tool-exec → record → repeat until the
  model says `end_turn` and there is no follow-up work. Tool calls collected during
  a stream become `FuturesOrdered` futures drained *after* the SSE stream completes.
- **One tool trait, many handlers.** `ToolExecutor<Invocation>`
  (`tools/src/tool_executor.rs:49`) pairs a model-visible `ToolSpec` (`spec()`) with
  an async `handle()`. A `ToolRegistry`/`ToolRouter` (`tools/registry.rs`,
  `tools/router.rs`) registers built-ins (shell/unified-exec, apply_patch,
  update_plan, view_image, web/MCP/dynamic/extension tools) and dispatches by name,
  wrapping each call in hooks + telemetry.
- **History is a plain `Vec<ResponseItem>`** (`context_manager/history.rs:38`) sent
  in full each turn via `for_prompt()`. Token budget is a byte-heuristic estimate;
  when over the limit, an **inline auto-compaction** summarizes the transcript and
  rewrites history to `[initial_context] + [recent user msgs] + [summary]`
  (`compact.rs:585`).
- **Permissions are layered.** An execpolicy rule engine (`execpolicy/`) returns
  Allow/Prompt/Forbidden; `safety.rs` maps that + `AskForApproval` to
  AutoApprove/AskUser/Reject; approved commands run inside a real OS sandbox
  (macOS Seatbelt `.sbpl`, Linux Landlock+seccomp via a re-exec'd helper, Windows
  restricted token) selected by `get_platform_sandbox` (`sandboxing/src/manager.rs:60`).
- **Provider I/O = Responses API only.** `ModelClientSession::stream`
  (`client.rs:1728`) talks the OpenAI **Responses** wire (HTTP-SSE or WebSocket).
  SSE event `kind` strings are mapped to a typed `ResponseEvent` enum in
  `codex-api/src/sse/responses.rs:315`. Retries use exponential backoff
  (`responses_retry.rs:22`).

---

## 1. Entry point → Agent loop

**Anchors:** `core/src/codex_thread.rs:194` (`submit(Op)`) → `tasks/mod.rs:314`
(`spawn_task`) / `tasks/mod.rs:391` (`tokio::spawn` of `task.run`) →
`tasks/regular.rs:73` (outer steer loop) → `session/turn.rs:142` (`run_turn`,
inner loop at `:225`) → `session/turn.rs:1072` (`run_sampling_request` retry loop,
`:1103`) → `session/turn.rs:1887` (`try_run_sampling_request`, stream loop `:1947`).

### Flow

A client submits an `Op` to a `CodexThread` (`codex_thread.rs:194`). For a normal
turn this becomes a `RegularTask` spawned via `Session::spawn_task`
(`tasks/mod.rs:314`), which aborts any in-flight task, then `start_task`
(`tasks/mod.rs:321`) opens a turn span and `tokio::spawn`s `task.run(...)`. Events
flow back out to the client as `EventMsg` variants (streamed deltas, turn-item
started/completed, errors, token counts).

**Outer loop** (`tasks/regular.rs:73`) — handles "steering": new user input typed
while a turn was running. It calls `run_turn`, and if the input queue still has
pending items, loops again with empty input so the queued steer is folded in:

```rust
let mut next_input = input;
loop {
    let last_agent_message = run_turn(
        Arc::clone(&sess), Arc::clone(&ctx),
        Arc::clone(&turn_extension_data),
        next_input, prewarmed_client_session.take(),
        cancellation_token.child_token(),
    ).await?;
    if !sess.input_queue.has_pending_input(&sess.active_turn).await {
        return Ok(last_agent_message);
    }
    next_input = Vec::new();
}
```

**Inner loop** (`session/turn.rs:225`) is the real agent loop. Each iteration:
captures a `StepContext`, builds the full prompt input from history
(`clone_history().for_prompt(...)`), calls `run_sampling_request` (one model call +
its tool executions), then decides whether to continue. The continue/stop decision
is the crux — it loops while `needs_follow_up || has_pending_input`, with
auto-compaction wedged in when the token limit is hit:

```rust
let needs_follow_up = model_needs_follow_up || has_pending_input;
let token_limit_reached = token_status.token_limit_reached;
// ...
if needs_follow_up
    && (sess.take_new_context_window_request().await || token_limit_reached)
{
    run_auto_compact(&sess, ..., CompactionReason::ContextLimit, CompactionPhase::MidTurn).await?;
    can_drain_pending_input = !model_needs_follow_up;
    continue;
}
if !needs_follow_up {
    last_agent_message = sampling_request_last_agent_message;
    // run stop hooks; if a hook blocks, inject continuation + `continue`
    break;
}
continue;
```

`model_needs_follow_up` is `true` whenever the stream produced a tool call (each
tool-call output item sets `OutputItemResult::needs_follow_up = true`) or the model
returned `end_turn: Some(false)`. So: tool calls → follow up; pure assistant message
with `end_turn` → stop.

**Stream consumption + tool dispatch** (`try_run_sampling_request`,
`session/turn.rs:1887`). One model call opens an SSE/WS stream and the loop at
`:1947` matches each `ResponseEvent`. `OutputItemDone` is the key arm: it routes
the item through `handle_output_item_done`, and any returned `tool_future` is pushed
onto an ordered queue while streaming continues:

```rust
let output_result = handle_output_item_done(&mut ctx, item, previously_streamed_item).await?;
if let Some(tool_future) = output_result.tool_future {
    in_flight.push_back(tool_future);          // FuturesOrdered
}
needs_follow_up |= output_result.needs_follow_up;
// ...
ResponseEvent::Completed { token_usage, end_turn, .. } => {
    if let Some(false) = end_turn { needs_follow_up = true; }
    break Ok(SamplingRequestResult { needs_follow_up, last_agent_message });
}
```

After `Completed`, tool futures are awaited and their outputs appended to history in
order (`drain_in_flight`, `session/turn.rs:1853`): each `ResponseInputItem` (the tool
result) is recorded via `record_conversation_items`, so the next loop iteration's
prompt includes them. This is the canonical build→call→parse→execute→append cycle.

---

## 2. Tool system

**Anchors:** trait `tools/src/tool_executor.rs:49`; spec enum `tools/src/tool_spec.rs:17`;
router `tools/router.rs` (`build_tool_call:108`, `dispatch_*:160+`); registry +
hook/telemetry wrap `core/src/tools/registry.rs:405` (`dispatch_any_with_terminal_outcome`);
registration `core/src/tools/spec_plan.rs:612` (`add_tool_sources`); parallel runner
`core/src/tools/parallel.rs:62` (`handle_tool_call`); result→history
`stream_events_utils.rs:405` (`handle_output_item_done`).

### Definition

Every tool implements one trait that ties its model-facing spec to its runtime:

```rust
pub trait ToolExecutor<Invocation>: Send + Sync {
    fn tool_name(&self) -> ToolName;
    fn spec(&self) -> ToolSpec;                 // serialized into the Responses tool list
    fn exposure(&self) -> ToolExposure { ToolExposure::Direct }   // Direct/Deferred/Hidden
    fn search_info(&self) -> Option<ToolSearchInfo> { /* derived from spec */ }
    fn supports_parallel_tool_calls(&self) -> bool { false }
    fn handle(&self, invocation: Invocation) -> ToolExecutorFuture<'_>;
}
```

`ToolSpec` (`tool_spec.rs:17`) is a `#[serde(tag="type")]` enum whose JSON is a valid
Responses-API tool: `Function(ResponsesApiTool)` (name + JSON-schema `parameters`),
`Namespace`, `tool_search`, `image_generation`, `web_search`, `custom`(freeform).
Input schemas are JSON Schema built in `tools/src/json_schema.rs`. Core tools add an
extra `CoreToolRuntime` trait (`registry.rs:46`) for hook payloads, telemetry tags,
argument-diff consumers, and parallel/cancellation metadata.

### Registration & description to the model

Tools are assembled per-turn in `spec_plan.rs` `add_tool_sources` (`:612`), gated by
features/model/environment. Each handler is `planned_tools.add(Handler::new(...))`.
The router exposes `model_visible_specs()` (`router.rs:74`), and `build_prompt`
(`turn.rs:1044`) puts them in the `Prompt.tools` field; `client.rs` serializes via
`create_tools_json_for_responses_api` (`tool_spec.rs:79`).

### Execution & result formatting

The stream's `FunctionCall`/`CustomToolCall`/`ToolSearchCall` item is parsed into a
`ToolCall` by `ToolRouter::build_tool_call` (`router.rs:108`). `ToolCallRuntime::handle_tool_call`
(`parallel.rs:62`) spawns the call as a task guarded by a `RwLock` — read lock for
parallel-safe tools, write lock to serialize the rest — then converts the typed
`ToolOutput` into a `ResponseInputItem::FunctionCallOutput` via `.into_response()`.
`ToolRegistry::dispatch_any_with_terminal_outcome` (`registry.rs:405`) wraps the
handler with: pre-tool-use hooks (can block or rewrite args), `notify_tool_start`,
OTEL `log_tool_result_with_tags`, then post-tool-use hooks. Errors are typed:
`FunctionCallError::RespondToModel(msg)` returns the message to the model as the tool
output; `Fatal` aborts the turn.

### Built-in tools (from `spec_plan.rs`)

- **Shell/exec:** `shell_command`, or unified-exec `exec_command` + `write_stdin`
  (`add_shell_tools:641`).
- **Edits:** `apply_patch` (`ApplyPatchHandler`, `:768`) — custom `*** Begin Patch`
  grammar (`apply-patch/`).
- **Planning/UX:** `update_plan` (`PlanHandler`), `view_image`, `request_user_input`,
  `request_permissions`, `current_time`/`sleep`, `wait_for_environment`,
  `new_context_window`, `get_context_remaining` (`add_core_utility_tools:709`).
- **Discovery/collab:** `tool_search` (deferred-tool search), multi-agent
  spawn/wait, MCP resource list/read, MCP tool calls, dynamic tools, extension tools,
  hosted `web_search`/`image_generation` specs.

---

## 3. Context / conversation management

**Anchors:** `core/src/context_manager/history.rs:38` (`ContextManager` = `Vec<ResponseItem>`);
`:121` `record_items`; `:141` `for_prompt`; `:160` `estimate_token_count`; truncation
`:370` `process_item` / `:463`; compaction `core/src/compact.rs:585`
(`build_compacted_history`), trigger `core/src/session/turn.rs:917` (`run_auto_compact`);
token status `core/src/session/context_window.rs`.

History is an ordered `Vec<ResponseItem>` (oldest first) plus a `history_version`,
token info, and a `reference_context_item` baseline used to diff environment/context
state between turns. `record_items` appends, applying a per-item `TruncationPolicy`
(tool outputs get truncated to a token budget at record time). `for_prompt` clones
the vec, normalizes (drops unsendable items, strips images if the model lacks the
image modality) and returns it — the **entire** transcript is sent each turn; there
is no sliding window.

Token budgeting is a coarse byte heuristic, not a tokenizer
(`estimate_token_count`, `history.rs:160`): `base_instructions_tokens + Σ item_tokens`
via `approx_token_count`. When `token_status.token_limit_reached`, the loop runs
auto-compaction. Compaction issues a separate model call with `SUMMARIZATION_PROMPT`
to summarize the thread, then rebuilds history (`build_compacted_history`):

```rust
// keep last user messages up to COMPACT_USER_MESSAGE_MAX_TOKENS (20k), then append summary
for message in user_messages.iter().rev() { /* select within token budget */ }
history.push(ResponseItem::Message { role: "user", content: [summary_text], .. });
```

The result is `initial_context ++ recent_user_messages ++ summary`, replacing the
old transcript via `ContextManager::replace` (bumps `history_version`). Remote
compaction variants (`compact_remote.rs`, `compact_remote_v2.rs`) offload this to the
backend. Sessions are also persisted as a rollout log (`core/src/rollout.rs`) so
threads can be resumed/forked.

---

## 4. Prompt construction

**Anchors:** base system prompt `protocol/src/prompts/base_instructions/default.md`
(loaded via `ModelInfo::get_model_instructions`, `protocol/src/openai_models.rs:460`);
model-specific prompts `core/gpt_5_*_prompt.md`; `Prompt` struct `core/src/client_common.rs:16`;
assembly `core/src/session/turn.rs:1044` (`build_prompt`); AGENTS.md
`core/src/agents_md.rs` (`load_project_instructions:47`); environment context
`core/src/context/environment_context.rs:60`; user instructions wrapper
`core/src/context/user_instructions.rs`.

The system prompt is `BaseInstructions { text }` resolved from the model
(`get_model_instructions`), which prefers a per-model template with a personality
placeholder, else the default markdown. It is passed as `Prompt.base_instructions`
and sent as the Responses `instructions` field — **not** prepended into the message
array. The `Prompt` carries input items, tool specs, parallel flag, base
instructions, and an optional strict output JSON schema:

```rust
pub struct Prompt {
    pub input: Vec<ResponseItem>,
    pub(crate) tools: Vec<ToolSpec>,
    pub(crate) parallel_tool_calls: bool,
    pub base_instructions: BaseInstructions,
    pub output_schema: Option<Value>,
    pub output_schema_strict: bool,
}
```

Repo memory comes from **AGENTS.md** (`agents_md.rs`): files are discovered from the
project root down to cwd (plus configurable fallback filenames, capped at
`project_doc_max_bytes`), then injected as a `user`-role item wrapped in
`# AGENTS.md instructions ... <INSTRUCTIONS> ... </INSTRUCTIONS>`
(`user_instructions.rs:18`). Environment state (workspace roots + sandbox permission
profile) is rendered as an XML `<filesystem>...<permission_profile>` block
(`environment_context.rs:60`) and injected as a context item; the `ContextManager`
diffs it against the `reference_context_item` so only changes are re-sent each turn.
`core/src/context/` holds ~30 other reminder/instruction fragments (skills, plugins,
permissions, current-time reminders, turn-aborted markers, etc.) — most are product
features a lean agent can skip.

---

## 5. Model / provider I/O

**Anchors:** provider info `model-provider-info/src/lib.rs:89` (`ModelProviderInfo`),
`:57` `WireApi`; client `core/src/client.rs:463` (`new_session`), `:1728` (`stream`),
`:1351` (`stream_responses_api`), `:1477` (`stream_responses_websocket`); event enum
`codex-api/src/common.rs:74` (`ResponseEvent`); SSE parse `codex-api/src/sse/responses.rs:315`
(`process_responses_event`), `:466` (`process_sse_with_treatment`); retries
`core/src/responses_retry.rs:22`.

`ModelProviderInfo` describes a provider: name, `base_url`, `env_key`, `wire_api`,
retry caps. **This version only supports `WireApi::Responses`** (no Chat Completions
in core). `stream` (`client.rs:1728`) picks WebSocket if enabled (falling back to
HTTP on failure) else HTTP-SSE. Both produce a `ResponseStream` — an `mpsc::Receiver`
of `Result<ResponseEvent>` fed by a background task that parses the wire and cancels
upstream when the consumer drops (`client_common.rs:101`).

The SSE parser (`codex-api/src/sse/responses.rs`) uses `stream.eventsource()` with an
idle `timeout`, deserializes each `data:` JSON, and maps the `kind` string to a typed
event:

```rust
match event.kind.as_str() {
    "response.output_item.done"      => ResponseEvent::OutputItemDone(item),
    "response.output_text.delta"     => ResponseEvent::OutputTextDelta(delta),
    "response.reasoning_text.delta"  => ResponseEvent::ReasoningContentDelta { .. },
    "response.completed"             => ResponseEvent::Completed { token_usage, end_turn, .. },
    "response.failed"                => /* classify: ContextWindowExceeded / QuotaExceeded / Retryable{delay} */,
    _ => /* ignored */
}
```

Tool calls are not special-cased in the SSE layer: they arrive as ordinary
`output_item.done` items typed `FunctionCall`/`CustomToolCall`, and extraction happens
in `ToolRouter::build_tool_call`. Retries (`responses_retry.rs:22`) honor `max_retries`
from provider info, prefer a server `retry-after` delay, else exponential `backoff`,
emitting a "Reconnecting…" notice; the turn-scoped `ModelClientSession` is reused
across retries to keep sticky routing/WebSocket state.

---

## 6. Permissions / sandboxing / approval

**Anchors:** decision tree `core/src/safety.rs:32` (`assess_patch_safety`),
`enum SafetyCheck:20`; exec policy bridge `core/src/exec_policy.rs:269`
(`create_exec_approval_requirement_for_command`); rule engine `execpolicy/` (`Decision`
`execpolicy/src/decision.rs:9`); sandbox selection `sandboxing/src/manager.rs:60`
(`get_platform_sandbox`), `:339` (command transform), `SandboxType` `:35`; Linux helper
`linux-sandbox/src/` (`landlock.rs`, `bwrap.rs`), `core/src/landlock.rs`; macOS policy
`sandboxing/src/seatbelt_base_policy.sbpl`.

This is Codex's richest subsystem and has **two independent gates**.

**Gate 1 — should we run it / ask the user?** Commands flow through an execpolicy
rule engine: a `Policy` of allow/prompt/forbidden rules (Starlark-style, `execpolicy/`)
returns a `Decision` (`Allow`/`Prompt`/`Forbidden`). `ExecPolicyManager::create_exec_approval_requirement_for_command`
(`exec_policy.rs:269`) combines that with the user's `AskForApproval` mode (`Never`,
`OnRequest`, `UnlessTrusted`, `Granular`) to yield `Skip{bypass_sandbox}` /
`NeedsApproval{reason}` / `Forbidden`. For patches, `safety.rs:32` maps the same
inputs to a `SafetyCheck`:

```rust
pub enum SafetyCheck {
    AutoApprove { sandbox_type: SandboxType, user_explicitly_approved: bool },
    AskUser,
    Reject { reason: String },
}
```

`AskUser` surfaces an approval `EventMsg` to the client and blocks until a
`ReviewDecision` returns; approvals can be remembered (an execpolicy allow-prefix
rule is appended, `exec_policy.rs:append_amendment_and_update`).

**Gate 2 — run it inside a real OS sandbox.** `get_platform_sandbox`
(`manager.rs:60`) chooses a `SandboxType` per platform:

```rust
pub fn get_platform_sandbox(windows_sandbox_enabled: bool) -> Option<SandboxType> {
    if cfg!(target_os = "macos")      { Some(SandboxType::MacosSeatbelt) }
    else if cfg!(target_os = "linux") { Some(SandboxType::LinuxSeccomp) }
    else if cfg!(target_os = "windows") && windows_sandbox_enabled
                                      { Some(SandboxType::WindowsRestrictedToken) }
    else { None }
}
```

`SandboxManager` then *rewrites the argv* (`manager.rs:339`): macOS prepends
`sandbox-exec` + a generated `.sbpl` policy from the filesystem/network permission
profile; Linux prepends a **re-exec of the Codex binary itself** as a
`codex-linux-sandbox` helper that applies Landlock (FS) + seccomp (syscalls/network)
before exec'ing the command (`linux-sandbox/`, with `bwrap`/bubblewrap as an
alternative); Windows uses a restricted token. The permission profile defines
readable/writable roots and network policy; `<filesystem>` in the prompt mirrors it
so the model knows its limits. A managed network proxy can inject a MITM CA into the
sandbox's readable roots for controlled egress.

---

## 7. Sub-agents / MCP / orchestration

**Anchors:** MCP manager `core/src/mcp.rs:43` (`McpManager`); MCP tool handler
`core/src/tools/handlers/mcp.rs:67`; tool call `core/src/mcp_tool_call.rs`; rmcp client
`rmcp-client/src/rmcp_client.rs` (transports `:47` StreamableHTTP, `:71` stdio);
MCP **server** mode `mcp-server/src/` (codex-as-an-MCP-server: `codex_tool_runner.rs`,
`exec_approval.rs`); sub-agents `core/src/agent/` (`control/spawn.rs`, builtins
`agent/builtins/{explorer,awaiter}.toml`); spawn/wait tools
`core/src/tools/handlers/multi_agents*.rs`.

**MCP client.** Codex connects to external MCP servers via the official `rmcp` crate.
`McpManager` (`mcp.rs:43`) owns connections; transports are stdio child-process
(`stdio_server_launcher.rs`) and StreamableHTTP (with optional OAuth,
`rmcp_client.rs:95`). Discovered MCP tools are wrapped as `McpHandler`
(`handlers/mcp.rs:67`), which implements `ToolExecutor` like any built-in: its `spec()`
exposes the server's JSON schema (namespaced `server/tool`), `supports_parallel_tool_calls`
honors the tool's `read_only_hint`, and `handle()` calls `handle_mcp_tool_call` and
boxes the result back as a `ToolOutput`. So MCP tools are first-class registry
entries, not a special path.

**MCP server.** Codex can itself be an MCP server (`mcp-server/`), exposing a `codex`
tool plus exec/patch approval round-trips — letting another agent drive Codex.

**Sub-agents.** `core/src/agent/` implements multi-agent orchestration: roles
(`role.rs`), a registry, and `control/spawn.rs` which forks a child thread (filtered
rollout history, inherited environments/exec-policy) for a delegated agent. Built-in
roles ship as TOML (`agent/builtins/explorer.toml`, `awaiter.toml`). The model spawns
and awaits children via the `spawn`/`wait` collaboration tools
(`tools/handlers/multi_agents*.rs`). This is a substantial product feature, not core
to a minimal agent.

---

## 8. Essential vs Bloat

| Component | Essential (any agent) | Bloat for a lean framework |
|---|---|---|
| Agent loop | `run_turn` model→tool→record loop + `end_turn`/follow-up stop condition (`turn.rs:225`) | steering re-run loop, plan-mode streaming, turn-diff tracker, extension contributors |
| Tool system | `ToolExecutor` trait + registry + JSON-schema specs + dispatch (`tool_executor.rs`, `registry.rs`) | tool_search/deferred tools, code-mode, dynamic/extension tools, argument-diff consumers |
| Tools | shell/exec + apply_patch (+ maybe read-file) | view_image, sleep, request_user_input, multi-agent spawn/wait, plugins, connectors |
| Context | `Vec<ResponseItem>` history + full resend + estimate (`history.rs`) | remote compaction v1/v2, world-state diffing, rollout reconstruction/forking |
| Compaction | one summarize-then-replace pass (`compact.rs:585`) | dual remote compaction backends, token-budget reminders |
| Prompts | system prompt + AGENTS.md + env block (`agents_md.rs`, `environment_context.rs`) | ~30 context fragments, personalities, collaboration-mode templates, skills/plugins |
| Provider I/O | one wire API, SSE→typed-event mapping, retries (`sse/responses.rs`, `responses_retry.rs`) | WebSocket transport + HTTP fallback, sticky routing, safety-buffering, OTEL spans everywhere |
| Permissions | approval gate + one OS sandbox (`safety.rs`, one `SandboxType`) | execpolicy rule engine + amendments, 3 sandbox backends, network proxy/MITM, granular policies |
| MCP | stdio MCP client → tools-as-handlers (`handlers/mcp.rs`) | StreamableHTTP+OAuth, MCP-server mode, elicitation, resource tools |
| Orchestration | (optional) one level of sub-agent delegation | role registry, residency, forked rollouts, multi-agent v2, guardian reviewer |

**Minimum viable kernel:** the `run_turn` loop + the `ToolExecutor` trait/registry +
shell & apply_patch handlers + `Vec<ResponseItem>` history + one SSE→event mapping +
one approval gate. Everything else in `codex-rs` is product surface.

---

## Ideas worth stealing

1. **Spec-and-runtime in one trait.** `ToolExecutor::spec()` + `handle()` keeps the
   model-facing JSON schema next to the code that runs it — they can't drift, and
   registering a tool is one `.add(Handler::new())`.
2. **Tool calls as `FuturesOrdered` drained after the stream.** Stream the whole
   model response first, queue tool futures, then await them in order
   (`turn.rs:1853`). Clean separation of "parse" and "execute", with free parallelism
   for read-only tools via a shared `RwLock` (`parallel.rs`).
3. **`needs_follow_up` as the single loop predicate.** One boolean (tool call seen OR
   `end_turn=false` OR pending input) drives continue-vs-stop, instead of scattered
   conditionals. Easy to reason about and test.
4. **Two-gate side-effect model.** Decide *whether to run* (policy + approval) and
   *how to run safely* (OS sandbox) as orthogonal layers (`safety.rs` vs
   `sandboxing/`). The sandbox is enforced by **argv rewriting / self-re-exec**, so
   no in-process trust is required.
5. **System prompt via the API `instructions` field, repo memory as a diffed context
   item.** AGENTS.md/env state are injected as conversation items and *diffed against
   a baseline* each turn (`reference_context_item`), so only deltas are re-sent —
   cheap context refresh without re-stuffing the prompt.
6. **Compaction = summarize then rebuild `[init]+[recent]+[summary]`.** Simple,
   inline, triggered by a byte-heuristic budget mid-loop with a `continue`
   (`turn.rs:917`, `compact.rs:585`) — no separate state machine.
7. **Typed tool errors steer the model.** `RespondToModel(msg)` feeds the error back
   as the tool result so the model can self-correct; only `Fatal` aborts. Failure
   becomes a normal turn-of-the-loop, not an exception.
8. **MCP tools are just handlers.** Wrapping external MCP tools in the same
   `ToolExecutor` trait means the loop, hooks, telemetry, and approval logic apply
   uniformly to built-in and remote tools.
