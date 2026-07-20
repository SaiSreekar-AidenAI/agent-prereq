# 1. The Agent Loop

The agent loop is the engine: call the model, run any tools it asked for, feed the
results back, repeat until it stops asking. Everything else in this handbook —
tools, permissions, compaction, sub-agents — hangs off this loop. Get its exit
condition and its tool-pairing invariant right and the rest is detail.

## How it works

A turn is one user request driven to completion through any number of model calls.
Each model call streams back an assistant message that may contain `text` blocks
and `tool_use` blocks. If it contains tool calls, the loop must execute them,
append their results, and call the model again — the model has not finished. If it
contains no tool calls, the model is done and the turn ends.

The decisive design choice, shared by four of the five repos, is **what signals
"done."** The naive answer is the provider's `stop_reason` (`end_turn` vs
`tool_use`). Every mature loop distrusts it: providers set it inconsistently, and
some return `stop`/`end_turn` even when the assistant content contains tool calls.
The authoritative signal is **the absence of a `tool_use` block in the assistant's
content** (claude-code `src/query.ts:554`). You scan the content you actually
received; you do not ask the provider's metadata how it went.

Three invariants make the loop robust:

- **Tool-use ↔ tool-result pairing.** The Messages API rejects a request where an
  assistant `tool_use` block has no matching `tool_result` in the next user turn.
  So *every* emitted `tool_use` must get a result before the next call — including
  on abort, error, or model-fallback paths, where you back-fill a synthetic error
  result (claude-code `yieldMissingToolResultBlocks`, `src/query.ts:123`).
- **Errors are tool results, not exceptions.** Schema-validation failures,
  permission denials, and tool exceptions all become `is_error` tool_result blocks
  fed back to the model so it self-corrects. The loop has one happy path and no
  exception-driven control flow.
- **Parse, then execute.** Tool calls are collected from the completed stream, then
  executed — read-only/concurrency-safe ones in parallel, writers serially.

### Flow

1. (Optional) compact if the estimated token count is over threshold.
2. Assemble system prompt + message history + tool schemas; call the model
   (streaming).
3. Accumulate streamed content blocks by index; assemble each `tool_use` input from
   JSON deltas, parsing only at block close. Append the assistant message.
4. **Exit test:** if the assistant content has no `tool_use` block, return — the
   turn is complete. Do not consult `stop_reason`.
5. Otherwise, for each tool call: validate input, run the permission gate, execute.
   Any failure becomes an `is_error` tool_result. Run safe tools in parallel,
   writers serially.
6. Append a user message carrying all the tool_result blocks (one per tool_use).
   Check turn/budget guards; `continue`.

```text
async function runTurn(messages, tools, provider, gate, ctx):
    while true:
        if estimateTokens(messages) > window - BUFFER:
            messages = compact(messages, provider)          # one summary pass

        assistant  = emptyAssistant()
        toolCalls  = []
        for await ev in provider.stream(system, messages, toolSchemas):
            case "text-delta":  assistant.appendText(ev.text)
            case "tool-call":   toolCalls.push(ev)           # input assembled at close
                                assistant.appendToolUse(ev)
            case "finish":      break                        # IGNORE ev.stop_reason
        messages.push(assistant)

        if toolCalls.isEmpty():                              # THE exit signal
            return assistant                                 # no tool_use ⇒ turn done

        results = []
        for batch in partitionBySafety(toolCalls, tools):    # safe ⇒ parallel batch
            results += await parallelMap(batch, tc => runOne(tc, tools, gate, ctx))
        # invariant: results has exactly one entry per toolCalls entry
        messages.push(userMessage(results))
        if ++turn > MAX_TURNS: return                        # budget guard
        continue

function runOne(tc, tools, gate, ctx):
    tool   = tools.byName(tc.name)
    parsed = tool.schema.safeParse(tc.input)
    if not parsed.ok:        return toolResult(tc.id, parsed.error, isError=true)
    decision = gate.decide(tool, parsed.value, ctx)
    if decision == "deny":   return toolResult(tc.id, "denied", isError=true)
    if decision == "ask" and not ctx.askUser(...):
                             return toolResult(tc.id, "rejected", isError=true)
    try:    return toolResult(tc.id, tool.call(parsed.value, ctx))
    except e: return toolResult(tc.id, e.message, isError=true)  # error ⇒ result
```

## In the wild

| Repo | Loop shape | Exit signal |
|---|---|---|
| claude-code | `while(true)` async-gen, mutable `State`+`continue` | no `tool_use` block: `needsFollowUp` false `query.ts:1062` |
| openclaude | same async-gen, single reassigned `state` | streamed `tool_use` absent; `stop_reason` distrusted |
| opencode | `while(true)`, re-derives state from SQLite each turn | last finish ≠ `tool-calls` AND no tool parts `prompt.ts:1111` |
| codex | outer steer loop + inner `run_turn` | `needs_follow_up` false `turn.rs:318` |
| goose | `async_stream` `loop{}` of typed `AgentEvent` | `no_tools_called` (then overrides) `agent.rs:2513` |

Divergences worth knowing:

- **Where loop state lives.** claude-code/openclaude carry one mutable `State` and
  express every retry path (model fallback, compaction, budget, recovery) as
  `state = {...}; continue` (`query.ts:204` region), so the loop is flat and every
  branch is uniform. opencode holds **no** mutable conversation object: each turn it
  reloads history from SQLite and re-derives "latest user / latest finished
  assistant / pending tasks" by max id (`prompt.ts:1096`), making cancel/resume
  correct by construction. codex resends the full transcript every turn.
- **The exit predicate, precisely.** claude-code sets `needsFollowUp = true` the
  moment a `tool_use` block arrives during streaming and exits when it is still
  false afterward (`query.ts:558`, `:834`, `:1062`). codex folds three conditions
  into one boolean: a tool call was seen, OR the provider reported `end_turn:false`
  (`turn.rs:2233`), OR there is queued user input (`turn.rs:318`). goose starts
  `no_tools_called = true` (`agent.rs:2002`), flips it false when a tool runs
  (`agent.rs:2366`), then *vetoes* the stop with goal/grind/stop-hook nudges
  (`agent.rs:2536`, `:2555`) — the one repo that complicates the clean rule.
- **The pairing back-fill.** Only claude-code/openclaude make it explicit:
  `yieldMissingToolResultBlocks` walks the assistant messages and emits a synthetic
  `is_error` tool_result for any `tool_use` left unpaired by an abort, image error,
  or model swap (`query.ts:123`, called at `:900`, `:984`, `:1025`). The others get
  pairing for free because they only append results in lockstep with calls.
- **Parallel vs serial execution.** claude-code partitions consecutive
  concurrency-safe tools into parallel batches (cap 10, `CLAUDE_CODE_MAX_TOOL_USE_
  CONCURRENCY`) and runs everything else serially
  (`toolOrchestration.ts:26`, `:91`). codex enforces the same policy with a single
  `RwLock<()>`: parallel-safe tools take a read lock, writers take the write lock,
  so reads overlap and writes are exclusive (`tools/parallel.rs:117`). goose drains
  many `ToolStream`s in a `tokio::select!`. opencode delegates execution to the
  Vercel AI SDK and does no explicit batching.
- **Guards.** claude-code stops with `reason: 'max_turns'` when the turn count
  exceeds `maxTurns` (`query.ts:1705`) and has a hard `blocking_limit` token stop
  (`query.ts:646`). codex bounds turns with cancellation tokens threaded through
  `run_turn` rather than a counter (`turn.rs:148`).

## Scenario

User: "Rename `getUser` to `fetchUser` across the repo." One turn, two model calls.

1. **Call 1.** The loop sends history + tool schemas. The model streams two
   `tool_use` blocks: `grep {pattern:"getUser"}` and `read {path:"a.ts"}`. Each
   block's `input` is assembled from `input_json_delta` fragments and JSON-parsed at
   `content_block_stop`. The `message_delta` carries `stop_reason` — ignored. The
   assistant message is appended; `needsFollowUp` is true because two `tool_use`
   blocks exist.
2. **Execute.** Both tools are read-only, so they form one parallel batch and run
   concurrently. `grep` returns three files; `read` returns the file. Two
   `tool_result` blocks, paired by `tool_use_id`, go into one user message. `continue`.
3. **Call 2.** The model now streams one `edit` `tool_use`. `edit` is a writer, so
   it runs in its own serial batch. The permission gate returns `ask`; the user
   approves. The edit succeeds; its `tool_result` is appended.
4. **Call 3.** The model streams a single `text` block: "Renamed across 3 files."
   No `tool_use` block. The exit test fires: `toolCalls.isEmpty()` → return. Turn
   complete after three model calls and three tools.

Counter-case showing the invariant: had the user aborted during the `edit`, the
loop would back-fill a synthetic `is_error` tool_result for the in-flight `edit`
`tool_use` (`query.ts:123`) so the persisted history stays paired and the next
request does not 400.

## Lean take

- **One flat `while(true)` with `continue`.** Hold a single mutable
  `{messages, turn, transition}` and reassign it per iteration. Every retry path
  (compaction, fallback, backoff) becomes another `continue` branch — no nested
  state machine (claude-code `query.ts:204`).
- **Exit on absence of a `tool_use` block. Never trust `stop_reason`.** This is the
  single most important line in your loop (claude-code `query.ts:554`).
- **Enforce pairing.** After collecting tool calls, guarantee exactly one
  `tool_result` per `tool_use` before the next call; on any abort/error path,
  back-fill a synthetic `is_error` result (claude-code `query.ts:123`).
- **Make every failure a result.** Validation, denial, and exceptions return
  `is_error` tool_result blocks; the loop never throws to control flow.
- **Parallelize by one `isReadOnly` predicate, serialize writers.** A free latency
  win with no scheduler (claude-code `toolOrchestration.ts:91`; codex
  `parallel.rs:117`). Skip it in v0 if you want — correctness does not depend on it.
- **Skip:** goal/grind/stop-hook "keep going" overrides (goose `agent.rs:2536`) —
  they fight the clean stop rule and add nondeterminism. Add a `MAX_TURNS` guard and
  stop there.
