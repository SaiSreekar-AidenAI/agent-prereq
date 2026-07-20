# BLUEPRINT — A Lean From-Scratch Agentic Framework

Distilled from five production coding agents — claude-code, opencode, openclaude,
codex, goose (see [comparison.md](./comparison.md) and the per-repo maps). This is
the **opinionated** spec: what to build, in what order, and what to deliberately
leave out. Every recommendation cites the repo(s) it's drawn from.

**Design stance:** the genuinely-essential agentic core is ~6 components and a few
hundred lines. All five repos converge on it; the other ~95% of each codebase is
product surface (UI, telemetry, provider breadth, enterprise/cloud, multi-agent
choreography). Build the kernel first, keep it provider-agnostic at one seam, and
add nothing speculatively.

No langchain/autogen. No DI container, no Effect runtime, no plugin bus. Plain
async + an in-memory message list is enough to be correct; persistence and
multi-provider are additive.

---

## 1. The minimal component set

Eight components. The first six are mandatory for any agent that does work; the
last two (MCP, sub-agents) are deferrable.

### 1.1 The agent loop
A single `while(true)` turn loop. Each iteration: (optionally compact) → assemble
the system prompt + messages → call the model (streaming) → collect tool-call
blocks from the assistant output → **if none, stop**; else execute the tools,
append their results as a follow-up message, and continue. Loop state can be a
single mutable object you reassign per iteration (claude-code/openclaude
`query.ts:204`) or — cleaner — re-derived from the message list each turn
(opencode `prompt.ts:1081`). The **exit signal is the absence of a tool-call
block, not the provider's `stop_reason`**, which four of five repos explicitly
distrust (claude-code `query.ts:553`, openclaude `query.ts:856`, codex
`needs_follow_up` `turn.rs:90`, goose `no_tools_called` `agent.rs:2513`).

### 1.2 Message / turn types
A `Message` is `{ role: user|assistant|tool, content: ContentBlock[] }` where a
`ContentBlock` is one of `text`, `tool_use {id, name, input}`, `tool_result {id,
content, isError}` (and optionally `thinking`). The conversation is an ordered
`Message[]`. Keep it minimal and provider-neutral — this is your canonical wire
format (codex `Vec<ResponseItem>` `history.rs:38`; openclaude makes the Anthropic
block shape canonical, `openaiShim.ts`). **Invariant to enforce:** every emitted
`tool_use` must get a matching `tool_result` before the next model call, or the API
400s on unpaired blocks — back-fill a synthetic error result on any failure/abort
path (claude-code `query.ts:123`). Optionally tag each message with dual visibility
flags (`userVisible`, `agentVisible`) so compaction can hide history from the model
without destroying the transcript (goose `context_mgmt:141`).

### 1.3 Tool interface
A tool is `{ name, description, inputSchema (JSON Schema), call(input, ctx) →
result, isReadOnly?, checkPermissions?(input) }`. `description` + `inputSchema` are
what the model sees; `call` is the implementation; `isReadOnly` drives both
permissions and parallelism. Keep the model-facing schema **next to** the executing
code so they can't drift (codex's one `ToolExecutor` trait pairs `spec()` with
`handle()` `tool_executor.rs:49`; goose derives schema from the param struct via
`schemars`). Provide a `buildTool()`-style factory with **fail-closed defaults**
(`isReadOnly→false`, `checkPermissions→allow-then-defer-to-gate`) so a new tool is
safe-by-default and tiny to declare (claude-code/openclaude `Tool.ts:757`).
**Schema-validation failure becomes a tool result, not a crash** — feed the
validation error back to the model so it self-corrects (opencode `tool.ts:113`,
codex `RespondToModel`).

### 1.4 Tool registry
A flat, hand-written list of built-in tools plus a merge step for external
(MCP/plugin) tools. Convert each `inputSchema` to JSON Schema once and hand the
array to the provider. Sort tools by name for prompt-cache stability (goose
`reply_parts.rs:214`). On name conflict, built-ins win (claude-code
`assembleToolPool` `tools.ts:345`). A registry is a literal array, not a framework
(claude-code `getAllBaseTools` `tools.ts:193`) — resist building a plugin system.

### 1.5 Provider client
One function: `stream(system, messages, tools) → AsyncIterator<StreamEvent>`. It
POSTs with streaming on, parses SSE, accumulates content blocks by index, and
assembles each tool call's JSON from incremental deltas, parsing the assembled
string **only at block close** (claude-code `claude.ts:2087`, goose
`formats/anthropic.rs:733`). Emit a small internal event union (`text-delta`,
`tool-call`, `usage`, `finish`) so the loop never sees raw SSE — goose's
`MessageStream` and codex's typed `ResponseEvent` are the model here
(`base.rs:386`, `sse/responses.rs:315`). Wrap it in retry-with-backoff (honor
server `retry-after`; cap overload retries). Make this an **injectable seam** so
the loop is testable without the network (claude-code `deps.callModel`
`query/deps.ts`). If you ever go multi-provider, keep ONE canonical event shape and
translate each provider into it rather than branching downstream (openclaude
`openaiShim.ts:1998`).

### 1.6 Context manager
Track an estimated token count for the message list (a byte heuristic is fine to
start — codex `history.rs:160`). When it crosses a threshold
(`contextWindow − buffer`, ~0.8 of the window — claude-code `autoCompact.ts:103`,
goose `0.8` `context_mgmt:188`), run one compaction pass: ask the model to
summarize the transcript, then rebuild history as `[initial context] + [recent
user messages] + [summary]` (codex `compact.rs:585`). Mark the compacted-away
messages agent-invisible rather than deleting them (goose). Also cap individual
tool-result size and spill oversized output to a file pointer + preview to bound
growth before any summarization is needed (claude-code `Tool.ts:466`, opencode
`tool.ts:131`).

### 1.7 Approval gate (permissions)
A function `decide(tool, input, ctx) → allow | ask | deny` called **before** every
`tool.call()`. Start with the simplest powerful model: an **ordered wildcard rule
list, last-match-wins, default `ask`** (opencode `index.ts:28`). `allow` runs the
tool; `ask` blocks for a user decision (and "always" appends a new allow rule at
runtime); `deny` returns an `is_error` tool_result fed back to the model — **never
abort the turn** (claude-code `toolExecution.ts:995`). Auto-allow read-only tools
via the `isReadOnly` flag (goose SmartApprove `permission_inspector.rs:159`). Add a
**bypass-immune safety floor**: writes to `.git/`, the agent's own config, and
shell rc files always prompt regardless of mode (claude-code `permissions.ts:1144`).
OS sandboxing is optional and separate (see §5).

### 1.8 MCP client (optional)
Adapt external Model Context Protocol tools into your tool interface and merge them
into the registry — they should be indistinguishable from built-ins to the loop
(goose serves *everything*, even built-ins, through `McpClientTrait`
`mcp_client.rs:78`; codex wraps MCP tools in the same `ToolExecutor`
`handlers/mcp.rs:67`). Start with stdio transport only; SSE/HTTP/OAuth are
additive. Defer this to v3.

---

## 2. The core loop (annotated pseudocode)

This is the ~few-hundred lines that actually matter. Language-agnostic; drawn from
the intersection of all five loops. Everything not shown here is recovery/UI/telemetry.

```text
# ── one turn entry ─────────────────────────────────────────────────────────────
async function run(conversation, tools, provider, gate, ctx):
    messages = conversation                 # ordered Message[]; the source of truth

    while true:
        # 1. CONTEXT: keep the request under the model's window.
        #    (codex compact.rs:585 — summarize then rebuild; goose 0.8 threshold)
        if estimateTokens(messages) > contextWindow - BUFFER:
            summary  = await summarize(messages, provider)          # one extra model call
            messages = [ initialContext(messages),
                         recentUserMessages(messages, maxTokens=20_000),
                         summary ]                                   # rebuild, don't delete

        # 2. PROMPT: system prompt is stable-cacheable; per-turn facts go elsewhere.
        #    (claude-code api.ts:449 — memory as a leading <system-reminder> USER msg)
        system   = buildSystemPrompt(tools, ctx)                    # identity + tool list + env + memory
        toolDefs = tools.map(t => { name, description, jsonSchema(t.inputSchema) })

        # 3. MODEL CALL (streaming). Provider seam is injectable for tests.
        #    (claude-code deps.callModel; goose Provider::stream base.rs:386)
        assistant   = emptyAssistantMessage()
        toolCalls   = []
        for await event in provider.stream(system, messages, toolDefs):
            switch event.type:
                case "text-delta":   assistant.appendText(event.text)
                case "tool-call":    # JSON already assembled at block close
                                     #   (claude-code claude.ts:2087 — accumulate input_json_delta)
                                     toolCalls.push(event)          # {id, name, input}
                                     assistant.appendToolUse(event)
                case "usage":        ctx.recordUsage(event)
                case "finish":       break                          # do NOT trust stop_reason for exit
        messages.push(assistant)

        # 4. EXIT TEST: the ONLY stop signal is "no tool calls".
        #    (claude-code query.ts:1062; codex needs_follow_up; goose no_tools_called)
        if toolCalls.isEmpty():
            return assistant                                        # turn complete

        # 5. EXECUTE TOOLS. Read-only/concurrency-safe → parallel; writers → serial.
        #    (claude-code toolOrchestration.ts:91; codex parallel.rs RwLock read=parallel)
        results = []
        for batch in partitionBySafety(toolCalls, tools):           # consecutive safe ⇒ one batch
            batchResults = await parallelMap(batch, async (tc) => {
                tool = tools.byName(tc.name)

                # 5a. VALIDATE: schema failure is a RESULT, not a crash.
                #     (opencode tool.ts:113 — InvalidArgumentsError.message → model)
                parsed = tool.inputSchema.safeParse(tc.input)
                if not parsed.ok:
                    return toolResult(tc.id, parsed.error, isError=true)

                # 5b. PERMISSION GATE before side effects.
                #     (opencode index.ts:28 last-match-wins; claude-code safety floor)
                decision = await gate.decide(tool, parsed.value, ctx)
                if decision == "deny":
                    return toolResult(tc.id, "Permission denied.", isError=true)  # feed back, don't abort
                if decision == "ask":
                    if not await ctx.askUser(tool, parsed.value):
                        return toolResult(tc.id, "User rejected.", isError=true)

                # 5c. RUN. Tool errors are also results (codex RespondToModel).
                try:    out = await tool.call(parsed.value, ctx)
                except e: return toolResult(tc.id, e.message, isError=true)

                out = capAndSpill(out, tool.maxResultSize)          # bound context (claude-code Tool.ts:466)
                return toolResult(tc.id, out)
            })
            results.push(...batchResults)

        # 6. APPEND results and loop. Pairing invariant: every tool_use got a tool_result.
        #    (claude-code query.ts:123 — back-fill any missing result so next call won't 400)
        messages.push(userMessageWith(results))
        continue
```

**Why this shape:**
- Flat `while(true)` + `continue` keeps every retry/recovery path uniform; you can
  add compaction-retry, model-fallback, or rate-limit backoff as more `continue`
  branches without a state machine (claude-code `query.ts:204`).
- Validation failures, permission denials, and tool exceptions all become
  `isError` tool results — the model sees them and self-corrects. The loop has a
  single happy path and no exception-driven control flow (codex, opencode, goose
  all do this).
- Tool calls are collected from the *content*, executed *after* the stream
  completes, and parallelized by a single `isReadOnly`/safety predicate — clean
  parse/execute separation with free latency wins (codex `FuturesOrdered`
  `turn.rs:1853`).

---

## 3. Tool interface + worked examples

The interface (TypeScript-flavored pseudocode; trivially portable to Rust traits):

```text
interface Tool<Input> {
    name:          string
    description:   string                       # shown to the model
    inputSchema:   Schema<Input>                # → JSON Schema for the API tools array
    isReadOnly:    boolean        = false       # fail-closed default (claude-code Tool.ts:757)
    maxResultSize: int            = 30_000      # chars; spill beyond this
    checkPermissions?(input): "allow" | "ask" | "deny"   # tool-specific rules (e.g. bash prefixes)
    call(input, ctx): Promise<string>           # returns the model-facing text result
}
```

### read (the simplest tool — read-only, no extra permission)
```text
read = {
    name: "read",
    description: "Read a UTF-8 text file. Returns up to `limit` lines with line numbers.",
    inputSchema: { path: string, offset?: int, limit?: int = 2000 },
    isReadOnly: true,                           # ⇒ auto-allowed, parallelizable
    call: async ({path, offset=0, limit=2000}, ctx) => {
        assertInsideWorkspace(path, ctx)        # cheap path guard
        lines = (await fs.read(path)).split("\n").slice(offset, offset+limit)
        return lines.map((l,i) => `${offset+i+1}\t${l}`).join("\n")   # cat -n style
    }
}
```

### write (a writer — gated, serialized)
```text
write = {
    name: "write",
    description: "Write `content` to `path`, creating or overwriting the file.",
    inputSchema: { path: string, content: string },
    isReadOnly: false,                          # ⇒ goes through the ask/deny gate; runs serially
    checkPermissions: ({path}) =>               # bypass-immune safety floor (claude-code permissions.ts:1144)
        isProtected(path)  ? "ask"              # .git/, agent config, shell rc → always prompt
                           : "allow",           # otherwise defer to the global rule list
    call: async ({path, content}, ctx) => {
        assertInsideWorkspace(path, ctx)
        await fs.write(path, content)
        return `Wrote ${content.length} bytes to ${path}`
    }
}
```

### bash (the hard tool — sub-command-aware permissions, optional sandbox)
```text
bash = {
    name: "bash",
    description: "Run a shell command in the workspace. Avoid interactive commands.",
    inputSchema: { command: string, timeoutMs?: int = 120_000 },
    isReadOnly: false,
    checkPermissions: ({command}) => {
        # opencode tree-sitter-parses into sub-commands and asks per real sub-command (shell.ts:257).
        # Lean version: prefix-match each &&/|/; segment against an allow/deny list.
        subs = splitSubcommands(command)
        if subs.any(isDenied):  return "deny"
        if subs.all(isKnownSafe): return "allow"     # e.g. ls, cat, git status, grep
        return "ask"
    },
    call: async ({command, timeoutMs}, ctx) => {
        # OPTIONAL OS sandbox (codex manager.rs: argv rewrite / self-re-exec; claude-code bwrap).
        argv = ctx.sandbox ? wrapInSandbox(command, ctx.sandbox) : ["bash","-c",command]
        { stdout, stderr, code } = await exec(argv, { timeoutMs, cwd: ctx.cwd })
        return `exit=${code}\n${truncate(stdout)}\n${stderr ? "stderr:\n"+truncate(stderr) : ""}`
    }
}
```

Notes: `read`/`write`/`bash` (+ `edit`, `glob`, `grep`) are the irreducible tool
set every repo ships; codex's minimum kernel is literally "shell + apply_patch"
(`codex.md` §8). `checkPermissions` lets a tool own its risk logic while the global
gate owns cross-tool rules.

---

## 4. Context-management strategy

**When to compact.** Maintain a running token estimate of the agent-visible message
list. Trigger compaction when `estimate > contextWindow − BUFFER` (use ~0.8 of the
window, or `window − ~13k` reserve). A byte heuristic (`bytes/4`) is adequate to
start — codex ships exactly this (`history.rs:160`); upgrade to a real tokenizer
only if it misfires. Check the threshold at the **top of each loop iteration**
(proactive) and also handle a real `context-length-exceeded` provider error
**inside the loop** as a recovery path that compacts and retries (goose
`agent.rs:2372`, claude-code reactive path).

**How to compact (one pass, leanest viable).**
1. Run a separate model call over the transcript with a summarization prompt. A
   single structured summary (intent, files touched, decisions, errors, current
   work, next step) is enough; claude-code's 8-section template (`prompt.ts:61`) is
   the gold standard if you want detail.
2. Rebuild history as `[initial context] + [most recent user messages up to ~20k
   tokens] + [summary]` (codex `compact.rs:585`). Always preserve the latest user
   message verbatim.
3. **Don't delete** — mark compacted-away messages agent-invisible so the user's
   transcript stays whole and replay is clean (goose dual-visibility
   `context_mgmt:141`).

**Cheaper tiers (add only if needed, cheapest-first).** Before summarizing: cap
each tool result's size and spill oversized output to a file pointer + preview
(claude-code `Tool.ts:466`, opencode temp-file truncation); then a non-LLM
`prune`/`snip` that drops stale tool-output *content* by id while protecting recent
tokens (opencode `compaction.ts:243`, claude-code microcompact). The full 5-layer
cascade in claude-code/openclaude is **bloat for a lean framework** — one good LLM
summary pass plus tool-result spilling covers the real cases.

---

## 5. WHAT TO OMIT

Each line is real surface seen in these repos that a lean framework should **not**
build. One reason each.

**Product / personality**
- *"Buddy"/Tamagotchi/proactive/Kairos autonomous modes* (openclaude) — a product
  persona, irrelevant to doing work.
- *Voice / STT* (openclaude) — input modality, orthogonal to the agent.
- *"Dreams" / goal / grind nudges, continuation-nudge heuristics* (goose
  `agent.rs:2513`, openclaude) — keep-going hacks that fight the clean "stop on no
  tools" rule; they add nondeterminism.
- *Ads* (openclaude) — not a framework concern.

**Telemetry / business**
- *Analytics, OTel tracing, PostHog, GrowthBook/Statsig feature gating, cost
  tracking* (all repos) — observability is additive; don't thread it through the
  loop from day one.
- *Session naming via LLM, title/summary side-channels* (opencode, goose) — UX
  polish.

**UI / surfaces**
- *The entire Ink/React TUI, vim mode, keybindings, themes, spinners* (claude-code
  ~800KB `main.tsx`, openclaude) — your loop should emit events; a UI consumes them
  separately (goose's `AgentEvent` stream is the right seam).
- *Desktop (Electron), web docs site, VSCode extension, IDE bridges/ACP* (goose,
  openclaude) — separate products on top of the core.
- *~25-40 React render methods per tool* (claude-code/openclaude `Tool.ts`) — UI
  concerns leaking into the tool interface; keep tools to `{schema, call}`.

**Provider / context over-engineering**
- *12+ providers, lazy-loaded SDK zoo, gateway registries, env-only providers,
  text/XML tool-call recovery for weak models* (openclaude, opencode) — ship ONE
  provider; add a canonical-event translator seam only when you need a second.
- *Dual runtime seam (vendor SDK + hand-rolled parser)* (opencode) — pick one.
- *5-layer compaction, server cache-editing, task-budget carryover, remote
  compaction backends* (claude-code, openclaude, codex) — one summary pass suffices.
- *WebSocket transport + HTTP fallback, sticky routing* (codex) — HTTP-SSE is fine.

**Permissions / safety over-engineering**
- *4 permission modes + LLM security/adversary/egress classifiers + repetition
  inspectors + shadowed-rule detection* (openclaude, goose) — start with one
  ordered rule list + read-only auto-allow + a safety floor.
- *Three OS sandbox backends, network MITM proxy, granular permission profiles*
  (codex) — one optional sandbox (bwrap/Landlock on Linux) is plenty; sandboxing
  can even be v-later.

**Orchestration / cloud / enterprise**
- *Coordinator mode, agent swarms/teams, peer-session orchestrator, multi-agent
  v2, role registries, guardian reviewer* (claude-code, openclaude, codex, goose) —
  one level of "sub-agent = recurse the loop" is the 95% case.
- *gRPC headless server, MCP-server mode, remote/background sessions, cron/
  scheduler/trigger/push-notification tools, worktree isolation* (openclaude, codex,
  goose) — deployment/integration surface, not the agent.
- *SQLite/Drizzle persistence, snapshot/revert, session import formats, rollout
  fork/resume* (opencode, codex) — in-memory `Message[]` is enough to start; add a
  persistence interface later.
- *Effect-TS runtime, Layer/Service DI, plugin hook bus* (opencode) — the
  architecture works fine with plain async; these are weight, not capability.
- *Skills directories, LSP integration, code-graph/analyze tools, MCP Apps/UI,
  elicitation, image normalization, 20+ README translations* (all) — extras.

---

## 6. Staged build order

Build strictly in this order; each stage is independently runnable and testable.
Citations point to the repo whose design to follow for that piece.

### v0 — Loop + 3 tools (no streaming, no approval)
- The `while(true)` loop with the **no-tool-calls exit test** (claude-code
  `query.ts:1062`; codex `needs_follow_up`).
- `Message[]` in memory; the tool-use ↔ tool-result pairing invariant with
  back-fill on failure (claude-code `query.ts:123`).
- Tool interface + `buildTool` fail-closed defaults (claude-code/openclaude
  `Tool.ts:757`); implement `read`, `write`, `bash`.
- A single provider call (non-streaming is fine for v0) behind an **injectable
  seam** so it's testable without the network (claude-code `deps.callModel`).
- System prompt = identity + tool list + cwd/env; memory file (AGENTS.md/CLAUDE.md)
  injected as a leading user message (claude-code `api.ts:449`).
- **Done when:** the agent can read a file, edit it, run a command, and stop.

### v1 — Streaming + approval gate
- Streaming provider client: SSE parse, accumulate content blocks by index,
  assemble tool-call JSON at block close, emit an internal event union (claude-code
  `claude.ts:1940`; goose `formats/anthropic.rs:733`; codex typed events).
- Retry-with-backoff honoring `retry-after` (codex `responses_retry.rs:22`).
- Approval gate: ordered last-match-wins rule list, default ask, "always" appends a
  rule, denial → `isError` result (opencode `index.ts:28`); auto-allow `isReadOnly`
  tools (goose); bypass-immune safety floor for `.git`/config (claude-code).
- Parallelize consecutive read-only tools, serialize writers (claude-code
  `toolOrchestration.ts:91`; codex `parallel.rs`).
- **Done when:** the agent streams output, asks before risky writes, and runs reads
  concurrently.

### v2 — Context compaction
- Token estimate (byte heuristic) + threshold check at top of loop (codex
  `history.rs:160`; goose 0.8).
- One summarization pass → rebuild `[init]+[recent]+[summary]` (codex
  `compact.rs:585`); mark old messages agent-invisible (goose dual visibility).
- Tool-result size cap + disk spill (claude-code `Tool.ts:466`).
- In-loop recovery on a real context-length error (goose `agent.rs:2372`).
- **Done when:** a long session compacts automatically and keeps going without a
  413, and the full transcript is still recoverable for the user.

### v3 — MCP + sub-agents
- MCP client (stdio transport first): adapt remote tools into your tool interface
  and merge into the registry — indistinguishable from built-ins (goose
  `mcp_client.rs:78`; codex `handlers/mcp.rs:67`).
- Sub-agents = **recurse the same loop** with a child context (own message list,
  filtered tool set, a step limit) and return the child's final text as the
  parent's tool result (claude-code `runAgent.ts:748`; goose `subagent_handler.rs:48`;
  opencode `task.ts:142`). No separate agent runtime.
- **Done when:** the agent can call an external MCP server's tools and delegate a
  scoped sub-task to a child agent — with zero new machinery in the loop.

**Beyond v3** (only if the product demands it, in rough priority): a persistence
interface for sessions (opencode); an OS sandbox for bash (codex argv-rewrite /
claude-code bwrap); a second provider via a canonical-event translator (openclaude);
a typed event stream for a UI (goose `AgentEvent`). Everything in §5 stays omitted.
