# 16. End-to-End Scenarios

The previous chapters dissected components in isolation. This one runs them
together. Each scenario is a trace: the inputs, how the message list and control
flow evolve, and which mechanism is doing the work. Notation: `messages` is the
ordered conversation; `A` = assistant, `U` = user/tool-results.

## Scenario 1 — A coding task, from prompt to stop

The spine of every session. User: *"make the failing test in `sum.ts` pass."*

```text
messages:
 [0] U  task + <system-reminder: CLAUDE.md memory>  + <skill listing>
 -- turn 1 --
 [1] A  text("Let me look at the test.") + tool_use(read, {path:"sum.test.ts"})
 [2] U  tool_result(<test source>)                  # read is read-only: no prompt
 -- turn 2 --
 [3] A  tool_use(read,{path:"sum.ts"})              # batched? no, sequential here
 [4] U  tool_result(<impl source>)
 -- turn 3 --
 [5] A  text("The bug is the operator.") + tool_use(write,{path:"sum.ts",...})
        --> write needs approval -> gate asks user -> "always" -> rule appended
 [6] U  tool_result("Wrote 412 bytes to sum.ts")
 -- turn 4 --
 [7] A  tool_use(bash,{command:"npm test"})         # gate: matches allow rule
 [8] U  tool_result("Tests: 1 passed")
 -- turn 5 --
 [9] A  text("Fixed: the operator was inverted. Tests pass.")   # NO tool_use
        --> exit test fires: no tool_use blocks => loop returns
```

What fired, in order: prompt construction injected memory + the skill listing
(Ch. 5, 9, 10); each turn streamed text then a tool call, the JSON assembled at
block close (Ch. 4); read ran unprompted while write went through the
allow/ask/deny gate, where "always" appended a runtime rule (Ch. 7); every
`tool_use` got a paired `tool_result` (Ch. 2); the loop stopped on the **absence
of a tool call**, not `stop_reason` (Ch. 1).

## Scenario 2 — A long session crosses the compaction threshold

Turn 30 of a refactor. Before the model call, the context manager estimates tokens.

### Trace

1. Top of the loop: `estimateTokens(messages) = 156k`, window 200k, threshold
   `0.8 * 200k = 160k`. Under — proceed. Three turns later: `163k > 160k`. Trigger.
2. Run a **separate** summarization model call over the transcript → an 8-section
   summary (intent, files touched, decisions, current work, next step).
3. Rebuild: `messages = [initialContext] + [recentUserMessages <= ~20k] +
   [summary]`. Old turns are marked **agent-invisible**, not deleted (Ch. 6).
4. Crucially, the rebuild preserves the **pairing invariant** — no orphaned
   `tool_use` is left without its `tool_result`, or the next call would 400 (Ch. 2).
5. The loop continues with a ~40k-token context. The user sees no interruption; the
   full transcript is still on disk for replay.

```text
before:  [init][t1][t2]...[t29][t30]                 ~163k tokens (agent-visible)
compact: summarize(all) -> S
after:   [init][t28][t29][t30][S]                    ~40k tokens
         (t1..t27 still stored, flagged agent_invisible)
```

Reactive variant: if the estimate is wrong and the provider returns a real
context-length error mid-loop, the same compaction runs as a recovery branch, then
the turn retries (Ch. 6). Same machinery, different trigger.

## Scenario 3 — A hook blocks a dangerous edit

The user has a `PreToolUse` hook forbidding edits to `.env` (Ch. 8).

```text
 [k]   A  tool_use(Edit, {file_path:".env", ...})
        --> PreToolUse fires BEFORE the permission gate:
            build hook input JSON -> spawn matching commands (stdin=JSON)
            hook: jq sees ".env" -> prints reason to stderr -> exit 2
            aggregate: any block wins -> behavior = deny
 [k+1] U  tool_result(is_error: "Edit hook error: <reason>")   # Edit NEVER ran
 [k+2] A  text("That file is protected; I'll skip it and continue with config.ts.")
```

The denial is a normal `is_error` tool result — the model reads it and routes
around it; the loop never throws (Ch. 1, "everything is a tool result"). Had the
hook printed `{"hookSpecificOutput":{"permissionDecision":"allow","updatedInput":
{...}}}` instead, the executor would have rewritten the args and let a *sanitized*
edit through. Hooks sit upstream of the gate, so they can veto even
otherwise-allowed actions.

## Scenario 4 — A skill activates (progressive disclosure)

`.claude/skills/pdf/SKILL.md` exists; its 3K-token body is in memory but not in
context (Ch. 10).

### Trace

1. Each turn, the runtime injects only new skill *descriptions* as a
   system-reminder: `- pdf: Fill and extract PDF forms` (~12 tokens). The body is
   withheld.
2. User: *"fill `form.pdf` with my address."* The model matches the listing and
   emits `tool_use(Skill, {skill:"pdf", args:"form.pdf"})`.
3. Gate: `pdf` has only safe frontmatter → auto-allow. The Skill tool reads
   `SKILL.md`, prepends `Base directory: <dir>`, substitutes `$ARGUMENTS=form.pdf`,
   and returns the expanded body as a **new user message**; `allowed-tools` scopes
   the turn to `Bash/Read/Write`.
4. Next turn the model has the full workflow and runs
   `bash python ${CLAUDE_SKILL_DIR}/scripts/fill.py form.pdf`.

The 3K-token instruction set entered context **only for this task** — a hundred
idle skills would still cost only their one-line descriptions.

## Scenario 5 — Delegating to a subagent

The model decides a scoped search is best run in isolation (Ch. 13).

```text
 [m]   A  tool_use(Task, {description:"find all callers of deprecated foo()",
                          subagent_type:"Explore"})
        --> the Task tool RECURSES the same loop with a CHILD context:
            child.messages = [ U(description) ]
            child.tools    = filtered set (read-only for Explore)
            child.budget   = its own token/step limit
            child runs its own turns ... returns final text
 [m+1] U  tool_result(<child's final summary of callers>)     # parent's result
 [m+2] A  ... parent continues with the summary, never seeing the child's turns
```

There is no separate "agent runtime": a subagent is the loop, recursed, with a
narrower tool set and its own message list (Ch. 1, law 7). The parent context stays
clean — it receives only the child's conclusion, not its intermediate tool calls.
Swarms and coordinators (omitted in Ch. 17) are elaborations of this one move.

## Scenario 6 — Calling an MCP tool

At startup the agent connected to an MCP server (e.g. a database tool) over stdio
(Ch. 14).

### Trace

1. Startup: spawn the server, `initialize`, `tools/list` → adapt each remote tool
   into the native interface and **merge into the registry**. To the loop, the
   tool `db.query` is indistinguishable from a built-in.
2. The merged tool's JSON schema goes to the model alongside built-ins (Ch. 3).
3. Model emits `tool_use(db.query, {sql:"select count(*) from users"})`.
4. The registry routes the call to the MCP client, which sends `tools/call` over
   the transport and returns the result as a normal `tool_result`.
5. The model continues. MCP tools pass through the same permission gate; many
   runtimes apply a blanket "ask" to external tools by default.

The only added machinery is an adapter at registration time. Everything downstream
— schema rendering, the gate, pairing, results — is the same path as a built-in.

## Scenario 7 — A streamed tool call, with a retry

What actually happens on the wire during one model call (Ch. 4).

```text
POST /v1/messages (stream:true)  ->  529 overloaded
  withRetry: backoff = BASE * 2^(n-1), capped; honor retry-after; attempt 2
SSE events:
  message_start
  content_block_start {type:text}            -> open text block 0
  content_block_delta {text:"Reading "}      -> append
  content_block_delta {text:"the file."}     -> append
  content_block_stop                          -> close block 0
  content_block_start {type:tool_use, name:"read", id:"tu_1"}
  content_block_delta {input_json:"{\"pa"}   -> buffer fragment (NOT parsed)
  content_block_delta {input_json:"th\":\"a.ts\"}"} -> buffer fragment
  content_block_stop                          -> NOW JSON.parse the buffer -> {path}
  message_delta {stop_reason:"tool_use"}      -> recorded, but NOT the exit signal
  message_stop
=> assistant content = [ text, tool_use(read,{path:"a.ts"}) ]
=> loop collects 1 tool_use -> executes -> continues
```

Two details carry the design: tool-call arguments are **accumulated across deltas
and parsed only at `content_block_stop`** (parsing a half-streamed fragment would
throw), and `stop_reason` is *recorded but not trusted* — the loop's exit decision
reads the assembled content for tool-use blocks (Ch. 1, 4). The retry wraps the
whole call, so transient `529`s never reach the loop as errors.

## What these scenarios share

Every flow above is the same five moves: assemble the request, stream a reply,
look for tool calls, run them through the gate (with hooks upstream), feed paired
results back — and stop only when no tool call is requested. Skills, subagents,
MCP, and compaction do not change the loop; they change *what a turn contains* or
*what a tool does*. That invariance is the whole point: build the loop once,
correctly, and every feature in this book attaches to it without rewriting it.
