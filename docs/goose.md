# goose (Block / AAIF) — Architecture Map for a Lean Agent Framework

Repo: `/home/user/projects/agent-prereq/repos/goose` · Language: **Rust** (async/tokio, streams everywhere)

goose is a production coding agent (CLI `goose`, server `goosed`, Electron desktop, ACP) built around **MCP as the universal tool bus**. Every tool — even the built-in shell/file editor — is exposed through an in-process MCP client (`McpClientTrait`). The single most important file is `crates/goose/src/agents/agent.rs` (~3000 lines); the agent loop lives in `Agent::reply_internal` (`agent.rs:1788`), an `async_stream` that yields `AgentEvent`s.

---

## TL;DR (5 bullets)

- **The loop is a streaming state machine.** `Agent::reply_internal` (`agent.rs:1788`) is an `async_stream::try_stream!` containing `loop { ... }` (`agent.rs:1888`). Each iteration: optionally inject MOIM/steers → stream the model → categorize tool calls → run inspectors (permission/security) → execute approved tools as concurrent streams → append request+response message pairs → if **no tools were called**, decide whether to nudge (goal/grind), retry, or exit. The whole thing emits `AgentEvent::{Message, Usage, McpNotification, HistoryReplaced}` (`agent.rs:264`) to the UI.
- **Everything is a tool, and every tool is MCP.** Tools are `rmcp::model::Tool` (JSON-schema input). They're served by anything implementing `McpClientTrait` (`mcp_client.rs:78`) — real stdio/SSE/HTTP MCP servers *and* in-process "platform extensions" like the built-in `developer` editor (`platform_extensions/developer/mod.rs:101`). Dispatch flows `dispatch_tool_call` (`agent.rs:1032`) → `ExtensionManager::dispatch_tool_call` (`extension_manager.rs:1744`) → the client's `call_tool`.
- **Provider abstraction is one trait, streaming-first.** `Provider::stream` (`providers/base.rs:386`) returns a `MessageStream` of `(Option<Message>, Option<ProviderUsage>)`. SSE is parsed per-format (`formats/anthropic.rs:733`). `complete()` is just `collect_stream(stream)`. A "toolshim" mode emulates tool-calling for models without native support by embedding tool JSON in the system prompt.
- **Permissions are a pluggable inspector pipeline.** A `ToolInspectionManager` (`tool_inspection.rs:57`) runs ordered `ToolInspector`s (Security → Egress → Adversary → Permission → Repetition; `agent.rs:621`). Each returns `Allow / Deny / RequireApproval`. The 4 modes are `Auto / Approve / SmartApprove / Chat` (`goose_mode.rs`). SmartApprove uses tool annotations + an LLM "is this read-only?" classifier with caching (`permission_inspector.rs:130`).
- **Context management is automatic + middle-out.** Before each turn it checks token ratio vs `GOOSE_AUTO_COMPACT_THRESHOLD` (default 0.8) (`context_mgmt/mod.rs:188`), summarizes via the LLM (`compact_messages`, `context_mgmt/mod.rs:67`), and marks old messages `agent_invisible` while keeping them `user_visible`. There's also per-tool-pair summarization and a `ContextLengthExceeded` recovery path inside the loop (`agent.rs:2372`).

---

## 1. Entry point → AGENT LOOP

**Anchors:** `agent.rs:1522` (`reply`, public entry), `agent.rs:1788` (`reply_internal`), `agent.rs:1888` (the `loop`), `agent.rs:1972` (`stream_response_from_provider` call), `agent.rs:2014` (per-chunk match), `agent.rs:2513` (no-tools-called branch), `agent.rs:2655` (commit messages). Consumer side: `goose-cli/src/session/mod.rs:1202`.

`reply()` is the public turn entry. It runs `UserPromptSubmit` hooks, intercepts slash-commands (`/clear`, `/compact`, goal-setting) via `execute_command`, persists the user message through the `SessionManager`, checks if **auto-compaction** is needed, and then delegates to `reply_internal`, streaming everything as `AgentEvent`s. Note: conversation state is **persisted to and re-read from the `SessionManager`**, not held purely in memory — `reply` re-fetches `session.conversation` (`agent.rs:1697`).

`reply_internal` builds the `ReplyContext` (tools + system prompt + model config, `agent.rs:1795`), appends project instructions, then enters the loop. Key per-turn mechanics:

1. **Turn guard:** `turns_taken` vs `max_turns` (`GOOSE_MAX_TURNS`, default `DEFAULT_MAX_TURNS`) (`agent.rs:1958`).
2. **MOIM injection:** `moim::inject_moim` (`agent.rs:1964`) injects "middle of the message" reminders (turn budget, etc.) into the conversation copy sent to the model — without persisting them.
3. **Model stream:** `stream_response_from_provider` (`agent.rs:1972`). Each yielded chunk is a `(Option<Message>, Option<ProviderUsage>)`.
4. **Tool categorization:** `categorize_tools` (`agent.rs:2029`) splits requests into frontend vs backend, coercing args against the tool's JSON schema (`reply_parts.rs:379`).
5. **No tool calls →** accumulate assistant text, `continue` to drain the rest of the stream (`agent.rs:2066`).
6. **Tool calls →** run inspectors → `handle_approved_and_denied_tools` + `handle_approval_tool_requests` → collect each tool as a `ToolStream` and `select_all` them, draining results in a `tokio::select!` inner loop (`agent.rs:2179`). Results become `ToolResponse` content via `add_tool_response_with_metadata`.
7. **Append the request/response pairs** to `messages_to_add`, preserving thinking/reasoning blocks (Gemini/DeepSeek need them echoed) (`agent.rs:2298`).
8. **End-of-iteration:** if `no_tools_called && !exit_chat`, branch on final-output-tool / pending-steers / goal / grind / retry-config to decide whether to nudge-and-continue or `exit_chat = true` (`agent.rs:2513`). All `messages_to_add` are persisted and `conversation.extend`ed (`agent.rs:2655`). A `Stop` hook can *block* exit and force another turn, capped by `GOOSE_STOP_HOOK_BLOCK_CAP`.

The "stop when no tool calls" rule is the classic agent termination, but goose layers several "keep going" overrides on top (goal/grind/final-output-tool/stop-hook), which is the part a lean framework would drop.

```rust
// agent.rs:1888 (core loop, condensed)
loop {
    if is_token_cancelled(&cancel_token) { break; }
    // ... drain pending steers, check final_output_tool ...
    turns_taken += 1;
    if turns_taken > max_turns { /* yield MAX_TURNS msg */ break; }

    let conversation_with_moim = super::moim::inject_moim(/* turn budget reminder */).await;
    let mut stream = Self::stream_response_from_provider(
        self.provider().await?, model_config.clone(), &session_config.id,
        &system_prompt, conversation_with_moim.messages(), &tools, &toolshim_tools,
    ).await?;

    let mut no_tools_called = true;
    while let Some(next) = stream.next().await {
        match next {
            Ok((response, usage)) => {
                if let Some(usage) = usage { yield AgentEvent::Usage(usage); }
                if let Some(response) = response {
                    let ToolCategorizeResult { frontend_requests, remaining_requests, filtered_response }
                        = self.categorize_tools(&response, &tools, surfaced_thinking_in_turn).await;
                    yield AgentEvent::Message(filtered_response.clone());
                    if frontend_requests.len() + remaining_requests.len() == 0 {
                        last_assistant_text.push_str(&filtered_response.as_concat_text());
                        messages_to_add.push(response); continue;              // no tools -> done
                    }
                    // inspectors -> permission check -> execute tools as streams -> append pairs
                    no_tools_called = false;
                }
            }
            Err(ProviderError::ContextLengthExceeded(_)) => { /* compact + retry */ }
            Err(e) => { yield AgentEvent::Message(err_msg(e)); break; }
        }
    }
    if no_tools_called && !exit_chat { /* goal/grind/retry/final-output decision -> maybe exit */ }
    for msg in &messages_to_add { session_manager.add_message(&session_config.id, msg).await?; }
    conversation.extend(messages_to_add);
    if exit_chat { /* Stop hook may veto */ break; }
}
```

---

## 2. TOOL SYSTEM

**Anchors:** tool type = `rmcp::model::Tool` (the official Rust MCP SDK); trait `McpClientTrait` (`mcp_client.rs:78`); built-in dev tools `platform_extensions/developer/mod.rs:101`; dispatch `agent.rs:1032` → `extension_manager.rs:1744`; categorization/coercion `reply_parts.rs:379`; tool list assembly `reply_parts.rs:147`.

**Definition.** A tool is `Tool::new(name, description, input_schema)` where `input_schema` is a JSON Schema (`serde_json::Map`). goose derives schemas from Rust structs via `schemars` (`Self::schema::<FileWriteParams>()`, `developer/mod.rs:106`) and adds `ToolAnnotations` — `read_only_hint`, `destructive_hint`, `idempotent_hint`, `open_world_hint` — which **drive the permission system** (`developer/mod.rs:108`). Optional `with_output_schema::<T>()` documents return shape.

**Registration / serving.** Tools come from "extensions". An `ExtensionConfig` (`extension.rs:163`) is one of `Stdio | Sse | StreamableHttp | Builtin | Frontend`. Each is wired to an `McpClientTrait` impl:
- Real MCP servers → `McpClient` (`mcp_client.rs`) talking JSON-RPC over the rmcp transport.
- Built-ins → in-process structs implementing `McpClientTrait` directly (the `developer`, `orchestrator`, `todo`, `memory`, `analyze`, etc. platform extensions, registered in `platform_extensions/mod.rs:30`+).

`prepare_tools_and_prompt` (`reply_parts.rs:147`) gathers `list_tools` from every active extension, filters to model-visible tools, and **sorts by name for prompt-cache stability** (`reply_parts.rs:214`).

**Description to the model.** Tools are passed natively to `provider.stream(.., tools)`. The format layer (e.g. `formats/anthropic.rs`) serializes them into provider tool-spec JSON. For toolshim models, tools are instead injected as text into the system prompt and stripped from the native `tools` arg (`reply_parts.rs:240`).

**Execution.** `dispatch_tool_call` (`agent.rs:1032`): runs `PreToolUse` hooks (can `Deny`), special-cases platform tools (`platform__manage_schedule`, the final-output tool), else delegates to `ExtensionManager::dispatch_tool_call` (`extension_manager.rs:1744`) which resolves `extension::tool` namespacing and calls the client's `call_tool`. A `PostToolUse` hook wraps the result.

**Result formatting.** Tools return `CallToolResult` (MCP) → wrapped via `add_tool_response_with_metadata` into a `MessageContent::ToolResponse` on a `user`-role message, paired by `request.id` with the assistant's `ToolRequest`. A `large_response_handler` (`agents/large_response_handler.rs`) truncates oversized outputs.

**Built-in tools (the `developer` extension):** `write`, `edit`, `shell`, `tree`, `read_image` (`developer/mod.rs:261`). Other platform extensions add: `orchestrator` (`list_sessions`/`view_session`/`start_agent`/`send_message`/`interrupt_agent`, `orchestrator.rs:588`), `platform__manage_schedule` (`platform_tools.rs`), `todo`, `memory`, `analyze` (code graph), `chatrecall`, `apps`, `summarize`, plus `manage_extensions` and the dynamic skills system.

```rust
// platform_extensions/developer/mod.rs:127 — the shell tool, annotated non-read-only
Tool::new(
    "shell".to_string(),
    format!("Execute a shell command in the current dir. Commands run under `{shell}` ..."),
    Self::schema::<ShellParams>(),
)
.with_output_schema::<ShellOutput>()
.annotate(ToolAnnotations::from_raw(
    Some("Shell".to_string()),
    Some(false),  // read_only_hint = false  -> requires approval in Approve modes
    Some(true),   // destructive_hint = true
    Some(false),  // idempotent_hint
    Some(true),   // open_world_hint
)),
```

---

## 3. CONTEXT / CONVERSATION MANAGEMENT

**Anchors:** auto-compact check `context_mgmt/mod.rs:188`; compaction `context_mgmt/mod.rs:67`; middle-out tool-response filter `context_mgmt/mod.rs:242`; per-tool-pair summarization `context_mgmt/mod.rs:559` + call site `agent.rs:1989`; token counting `token_counter.rs`; `ContextLengthExceeded` in-loop recovery `agent.rs:2372`; cutoff calc `context_mgmt/mod.rs:450`.

**Message shape.** `Conversation` wraps `Vec<Message>`; each `Message` has a role, `created`, and `Vec<MessageContent>` (`Text | ToolRequest | ToolResponse | Thinking | RedactedThinking | Image | ActionRequired | ...`). Crucially, messages carry `MessageMetadata` with **dual visibility** flags: `user_visible` and `agent_visible` (`with_visibility(true,false)`). Only `is_agent_visible()` messages are sent to the model (`reply_parts.rs:269`), so compaction can hide history from the model while keeping the transcript intact for the user.

**Token budgeting.** `check_if_compaction_needed` computes `current_tokens / context_limit` vs threshold (default 0.8 via `GOOSE_AUTO_COMPACT_THRESHOLD`). Token count comes from session metadata if available, else a local `TokenCounter` estimate (`context_mgmt/mod.rs:215`). Providers that `manages_own_context()` skip compaction entirely.

**Compaction.** `compact_messages` (`context_mgmt/mod.rs:67`) calls the LLM to summarize, then rebuilds the conversation: old messages → `agent_invisible` (still user-visible), a summary message → `agent_only`, plus a continuation message. The **most recent user message is preserved** verbatim for non-manual compacts. Triggered three ways: (a) pre-turn auto-compact in `reply` (`agent.rs:1702`), (b) mid-loop on `ProviderError::ContextLengthExceeded` with a 2-attempt cap (`agent.rs:2377`), (c) manual `/compact`.

**Per-tool-pair summarization.** Once a turn crosses `tool_call_cut_off` (`compute_tool_call_cutoff`, `context_mgmt/mod.rs:450`), older request/response *pairs* are summarized individually and marked invisible (`agent.rs:2607`) — a cheaper, more surgical compaction than full summarization.

```rust
// context_mgmt/mod.rs:242 — middle-out removal of tool responses (keep head & tail context)
let num_to_remove = ((tool_indices.len() * remove_percent as usize) / 100).max(1);
let middle = tool_indices.len() / 2;
for i in 0..num_to_remove {
    if i % 2 == 0 { indices_to_remove.push(tool_indices[middle - i/2 - 1]); }   // walk left
    else          { indices_to_remove.push(tool_indices[middle + i/2]);     }   // walk right
}
```

---

## 4. PROMPT CONSTRUCTION

**Anchors:** builder `prompt_manager.rs:117` (`SystemPromptBuilder::build`); template `prompts/system.md`; assembly call `reply_parts.rs:216`; hints constants `hints/load_hints.rs:10`; project instructions `agent.rs:689`; Jinja-style renderer `prompt_template.rs`.

The system prompt is assembled by `SystemPromptBuilder` (`prompt_manager.rs:117`) using a MiniJinja-style template (`prompts/system.md`). The builder injects:
- **Extensions block** — each active extension's name + `instructions` (from MCP `InitializeResult.instructions` or platform override), looped in `system.md:21`.
- **Tool/extension counts** with an over-limit "suggestion" (`MAX_EXTENSIONS`/`MAX_TOOLS`).
- **Goose mode**, `is_autonomous`, subagents-enabled, code-execution-mode flags.
- **MOIM system block** and a stable timestamp **truncated to the hour** for prompt-cache hits (`prompt_manager.rs:209`).

After the base template, `system_prompt_extras` (an `IndexMap`) are appended under `# Additional Instructions:` (`prompt_manager.rs:193`). Extras include **hints** and chat-mode notices. Programmatic injection is via `extend_system_prompt(key, instruction)` (`agent.rs:2705`).

**Memory / AGENTS.md.** Hint files are `.goosehints`, `AGENTS.md`, and also `CLAUDE.md` / `.cursorrules` (test `load_hints.rs:437`) — loaded by `load_hint_files` (`hints/load_hints.rs:225`) from the working dir, merged into the `hints` extra via `with_hints(working_dir)`. **Subdirectory hints are loaded lazily**: as the agent touches files in new dirs, `load_subdirectory_hints` re-reads hints and triggers a prompt rebuild mid-loop (`agent.rs:2501`). Project-level instructions are appended separately in `reply_internal` (`agent.rs:1809`). All injected text is run through `sanitize_unicode_tags` to strip hidden-unicode prompt-injection vectors (`prompt_manager.rs:134`).

```rust
// reply_parts.rs:227 — build the system prompt from live extension state
let mut system_prompt = prompt_manager
    .builder()
    .with_extensions(extensions_info.into_iter())
    .with_frontend_instructions(self.frontend_instructions.lock().await.clone())
    .with_extension_and_tool_counts(extension_count, tool_count)
    .with_code_execution_mode(code_execution_active)
    .with_hints(working_dir)         // .goosehints / AGENTS.md / CLAUDE.md
    .with_goose_mode(goose_mode)
    .build();
```

---

## 5. MODEL / PROVIDER I/O

**Anchors:** trait `providers/base.rs:381`; `stream` `base.rs:386`; `MessageStream` `base.rs:285`; Anthropic impl `anthropic.rs:241`; SSE parser `formats/anthropic.rs:733`; retry `providers/retry.rs`; agent-side wrapper `reply_parts.rs:256`; error types `providers/errors.rs`.

**Abstraction.** `trait Provider` is small: `get_name`, `stream` (required), `complete` (default = collect the stream), `get_context_limit`, `retry_config`, `fetch_*_models`. `stream` takes `(model_config, system, messages, tools)` and returns `MessageStream = Stream<Item = Result<(Option<Message>, Option<ProviderUsage>), ProviderError>>`. There's a `ProviderDescriptor` trait (`base.rs:278`) for declarative registration; providers include anthropic, openai, openai_compatible, ollama, plus declarative/local-inference variants.

**Streaming parse (SSE).** Each provider POSTs with `"stream": true`, reads `response.bytes_stream()`, frames it into lines with a `LinesCodec`, and hands the line stream to a format-specific parser. `formats/anthropic.rs:733` is a hand-rolled SSE state machine: it skips non-`data:` lines, breaks on `[DONE]`, parses each event by `type` (`message_start`, `content_block_start`, deltas: `text_delta` / `input_json_delta` / `thinking_delta` / `signature_delta`), and **accumulates partial tool-call JSON** per content block before emitting a `ToolRequest`. Usage is pulled from `message_start`/`message_delta`.

**Tool-call extraction.** Native tool calls arrive as `MessageContent::ToolRequest` already parsed by the format layer; the agent then coerces arguments against the tool schema (`reply_parts.rs:393`) and dedups repeated ids (`reply_parts.rs:434`). For non-native models, **toolshim** post-processes the full text to extract tool JSON (`reply_parts.rs:316`, `toolshim_postprocess`).

**Retries.** `RetryConfig` (`providers/retry.rs:14`) = `max_retries` + exponential `backoff_multiplier`; `should_retry` (`retry.rs:84`) classifies transient errors (rate limits, network, 5xx via `http_status.rs`). Providers call `with_retry(|| ...)` around the HTTP request (`anthropic.rs:264`). Stream-creation errors are converted into a one-item error stream so the agent loop's error arms handle them uniformly (`reply_parts.rs:310`). Distinct `ProviderError` variants (`ContextLengthExceeded`, `CreditsExhausted`, `Refusal`, `NetworkError`) get distinct in-loop handling (`agent.rs:2372`+).

```rust
// providers/base.rs:386 — the entire provider contract is essentially this
async fn stream(&self, model_config: &ModelConfig, system: &str,
                messages: &[Message], tools: &[Tool]) -> Result<MessageStream, ProviderError>;
async fn complete(&self, ...) -> Result<(Message, ProviderUsage), ProviderError> {
    let stream = self.stream(model_config, system, messages, tools).await?;
    collect_stream(stream).await        // default impl: drain the stream
}
```

---

## 6. PERMISSIONS / SANDBOXING / APPROVAL

**Anchors:** modes `goose_mode.rs`; inspector trait `tool_inspection.rs:34`; manager + registration order `agent.rs:621`; permission inspector logic `permission_inspector.rs:130`; `PermissionCheckResult` `permission_judge.rs:188`; security inspector `security/security_inspector.rs:50`; CLI approval prompt `goose-cli/src/session/mod.rs:1210`; hook-based deny `agent.rs:1064`.

**Modes** (`GooseMode`): `Auto` (allow all), `Approve` (ask every tool), `SmartApprove` (ask only for non-read-only), `Chat` (no tools — calls are skipped with a placeholder response, `agent.rs:2094`).

**Inspector pipeline.** `ToolInspectionManager` runs ordered `ToolInspector`s; each returns `InspectionAction::{Allow, Deny, RequireApproval(Option<msg>)}` with a confidence. Registration order (`agent.rs:621`): **Security** (regex + classifier for dangerous commands / prompt injection) → **Egress** (network exfiltration) → **Adversary** (optional LLM review gated by `~/.config/goose/adversary.md`) → **Permission** (the mode logic) → **Repetition** (loop detection). Results are folded into a `PermissionCheckResult { approved, needs_approval, denied }` (`permission_judge.rs:188`).

**Permission inspector** (`permission_inspector.rs:130`) is the heart: in `Approve`/`SmartApprove` it checks (1) the user's stored permission (`AlwaysAllow`/`NeverAllow`/`AskBefore`), (2) read-only annotation or cached smart-approve decision, (3) special-cases extension management, (4) for uncached SmartApprove tools defers to an **LLM "is this read-only?" classifier** whose verdict is then cached (`permission_inspector.rs:218`). Unknown tools default to requiring approval.

**Approval flow.** Tools needing approval are surfaced as `AgentEvent::Message` carrying an `ActionRequired`/confirmation; the host (CLI `prompt_tool_confirmation`, `session/mod.rs:1211`) prompts the user and calls `agent.handle_confirmation(id, ...)`. **Headless safety:** non-interactive runs in Approve/SmartApprove modes hard-error rather than silently auto-allow (`session/mod.rs:1219`).

**Sandboxing.** There is **no kernel/OS sandbox by default** — `shell`/`write`/`edit` run with the user's privileges in the working dir. The safety boundary is the inspector/approval layer plus `PreToolUse`/`PostToolUse` policy **hooks** (`agent.rs:1064`) that can `Deny` a call. There is an optional `Container` abstraction (`agents/container.rs`) for running in a container, but it's a thin opt-in, not the default model.

```rust
// permission_inspector.rs:145 — the mode decision matrix
let action = match goose_mode {
    GooseMode::Chat => continue,                       // tools skipped entirely
    GooseMode::Auto => InspectionAction::Allow,
    GooseMode::Approve | GooseMode::SmartApprove => {
        if let Some(level) = permission_manager.get_user_permission(tool_name) {
            match level { AlwaysAllow => Allow, NeverAllow => Deny, AskBefore => RequireApproval(None) }
        } else if self.is_readonly_annotated_tool(tool_name)
               || (SmartApprove && cached_allow(tool_name)) { Allow }
        else if tool_name == MANAGE_EXTENSIONS { RequireApproval(Some("...security")) }
        else if SmartApprove && uncached { llm_detect_candidates.push(request); continue }  // LLM classify
        else { RequireApproval(None) }                  // default: ask
    }
};
```

---

## 7. SUB-AGENTS / MCP / ORCHESTRATION

**Anchors:** MCP client trait `mcp_client.rs:78`; real client `call_tool` `mcp_client.rs:783`; extension configs `extension.rs:163`; extension manager `extension_manager.rs`; subagent runner `subagent_handler.rs:48`; subagent execution tool `subagent_execution_tool/mod.rs`; orchestrator tools `orchestrator.rs:588`; subagent prompt `prompts/subagent_system.md`.

**MCP wiring.** goose is an MCP *host*. The `ExtensionManager` owns a map of named extensions, each backed by an `McpClientTrait`. For external servers, `McpClient` (`mcp_client.rs`) speaks JSON-RPC over the rmcp transport (stdio/SSE/StreamableHTTP); for built-ins, the trait is implemented in-process. `McpClientTrait` covers the full MCP surface: `list_tools`, `call_tool`, `list/read_resource`, `list/get_prompt`, and `subscribe` for server→client notifications (`mcp_client.rs:140`) which the agent forwards as `AgentEvent::McpNotification`. Tools are namespaced `extension__tool` and resolved back in `ExtensionManager::dispatch_tool_call` (`extension_manager.rs:1751`). Extensions can be added/removed at runtime via the `manage_extensions` tool, which rebuilds the tool list and system prompt mid-loop (`agent.rs:2496`).

**Sub-agents.** Two complementary mechanisms:
1. **Recipe subagents** (`subagent_handler.rs:48`): `run_subagent_task` spins up a *fresh nested `Agent`* from a recipe (its own system prompt from `subagent_system.md`, own tool subset, own model), runs it to completion, and returns either the last message or all text (`extract_response_text`, `subagent_handler.rs:65`). Used by the `subagent_execution_tool` to run tasks (optionally in parallel).
2. **Orchestrator** (`orchestrator.rs`): a platform extension exposing `start_agent` / `send_message` / `interrupt_agent` / `list_sessions` / `view_session` so the main agent can manage *peer* long-lived agent sessions, each with its own working dir, inheriting the provider/model.

Both reuse the exact same `Agent::reply` machinery — sub-agents are not a separate code path, just another `Agent` instance, which keeps the surface area small.

```rust
// subagent_handler.rs:48 — a sub-agent is just another Agent run to completion
pub async fn run_subagent_task(params: SubagentRunParams) -> Result<String, anyhow::Error> {
    let return_last_only = params.return_last_only;
    let (messages, final_output) = get_agent_messages(params).await /* spawns nested Agent */ ?;
    if let Some(output) = final_output { return Ok(output); }      // final-output tool wins
    Ok(extract_response_text(&messages, return_last_only))         // else flatten transcript text
}
```

---

## 8. ESSENTIAL vs BLOAT

goose is a feature-rich product, not a teaching example. The architecture, however, cleanly separates a small core from a large amount of product surface. The MCP-as-tool-bus + inspector-pipeline + streaming-loop ideas are the durable core; almost everything else is optional.

| Concern | ESSENTIAL (steal this) | BLOAT for a lean framework (skip) |
|---|---|---|
| Loop | `reply_internal` stream loop: model → tools → append → repeat-until-no-tools (`agent.rs:1888`) | goal/grind nudges, stop-hook block cap, MOIM injection, pending-steers, retry-config recipe loop |
| Tools | `Tool` (name+JSON schema) + `McpClientTrait` dispatch (`mcp_client.rs:78`); built-in `shell/write/edit/read` | 15+ platform extensions (todo, memory, analyze code-graph, chatrecall, apps, autovisualiser, peekaboo) |
| Provider | `Provider::stream` + `complete=collect_stream` + SSE parser + retry (`base.rs:381`) | toolshim emulation, canonical model registry, declarative providers, OAuth/signup flows, posthog telemetry |
| Context | token-ratio auto-compact + LLM summarize + dual visibility flags (`context_mgmt/mod.rs`) | per-tool-pair summarization, middle-out tool-response thinning, hour-truncated cache timestamps |
| Prompt | template + extension instructions + hints/AGENTS.md injection (`prompt_manager.rs`) | unicode-tag sanitization, subdirectory lazy hints, code-execution-mode, recipe/app prompts |
| Permissions | mode enum + one inspector returning Allow/Deny/Ask + approval callback (`permission_inspector.rs`) | Security/Egress/Adversary/Repetition inspectors, LLM read-only classifier+cache, hooks system |
| Orchestration | sub-agent = nested `Agent` instance (`subagent_handler.rs`) | orchestrator peer-session management, scheduler/cron, ACP server, recipes, container runtime |
| Persistence | in-memory `Vec<Message>` is enough to start | `SessionManager` SQLite-style session store, session naming via LLM, import formats |

**Minimum viable agent from goose's design:** a `loop` that (1) calls `provider.stream(system, messages, tools)`, (2) collects assistant message + tool calls, (3) for each tool call runs one permission check then dispatches via a `call_tool(name, args) -> result` trait, (4) appends request+response messages, (5) repeats until the model emits no tool calls. That's ~200 lines; everything in the table's right column is additive.

---

## Ideas worth stealing

1. **MCP as the *only* tool interface — even for built-ins.** The `developer` shell/editor implements the same `McpClientTrait` as a remote MCP server (`developer/mod.rs:176`). One dispatch path, one schema format, trivial extensibility, and you get the whole MCP ecosystem for free.
2. **Dual message visibility (`user_visible` vs `agent_visible`).** Compaction hides history from the model while preserving the full transcript for the user — no destructive truncation, clean replay. (`reply_parts.rs:269`, `context_mgmt/mod.rs:141`)
3. **Tool annotations drive permissions.** `read_only_hint`/`destructive_hint` on each `Tool` let SmartApprove auto-allow reads and gate writes *without per-tool config* (`developer/mod.rs:108` → `permission_inspector.rs:159`).
4. **Pluggable inspector pipeline returning Allow/Deny/RequireApproval.** Security, permission, repetition, and LLM-adversary checks are independent `ToolInspector`s composed in order (`agent.rs:621`) — add policy without touching the loop.
5. **The whole turn is an `async_stream` of typed events** (`AgentEvent`, `agent.rs:264`). The same stream feeds CLI, server, and desktop; back-pressure and cancellation (`CancellationToken`) are first-class.
6. **Errors become stream items, not exceptions.** Stream-creation failures are wrapped into a one-item error stream (`reply_parts.rs:310`) so the loop's single error-handling site catches everything uniformly, including typed recovery for `ContextLengthExceeded` (compact-and-retry).
7. **Stable, name-sorted tool ordering + hour-truncated timestamp** purely to maximize provider prompt-cache hits (`reply_parts.rs:214`, `prompt_manager.rs:209`) — a cheap latency/cost win.
8. **Sub-agents are just nested `Agent`s.** No parallel orchestration framework; delegation reuses `Agent::reply` with a scoped tool set and recipe prompt (`subagent_handler.rs`), and a "final-output tool" lets a sub-agent return structured results.
9. **Unicode-tag sanitization on all injected instructions** (`sanitize_unicode_tags`, `prompt_manager.rs:134`) defends against hidden-character prompt injection in hint files / system-prompt overrides.
10. **Preserve thinking/reasoning blocks across tool calls** because some providers (Gemini, DeepSeek/Kimi) require them echoed back on assistant tool-call messages (`agent.rs:2249`) — a subtle correctness requirement most homegrown loops miss.
