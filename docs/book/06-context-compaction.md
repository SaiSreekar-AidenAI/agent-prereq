# 6. Context Management & Compaction

Every turn resends the whole conversation, so the message list grows until it
threatens the model's context window. Context management is the subsystem that
keeps the next request under that ceiling: estimate the size, decide *when* to
shrink, and shrink *how* — ideally without losing information the user can still
see.

## How it works

There are four separable concerns, and the repos that do this well keep them
separate.

**1. A token budget.** You need a cheap, synchronous estimate of how many tokens
the agent-visible history will cost. The honest finding across these codebases is
that a real tokenizer is overkill: codex estimates with a flat `bytes / 4`
heuristic (`approx_token_count`, ceiling division) and never tokenizes at all
(`codex/codex-rs/utils/string/src/truncate.rs:71`). claude-code and goose do
count, but the count only feeds a threshold comparison where a 10-20% error is
irrelevant because there is a multi-thousand-token safety buffer underneath.

**2. When to compact.** Two triggers, and you want both:

- *Proactive*: at the top of each turn, if `estimate > threshold`, compact before
  calling the model. The threshold is `contextWindow − buffer`, expressed either
  as an absolute reserve (claude-code: `effectiveWindow − 13k`,
  `claude-code/src/services/compact/autoCompact.ts:72`) or a ratio (goose: usage
  ratio `> 0.8`, `goose/crates/goose/src/context_mgmt/mod.rs:188`).
- *Reactive*: the estimate can be wrong, or a single huge tool result can blow the
  window mid-turn. So the loop must also catch a real `context-length-exceeded`
  provider error, compact, and retry — bounded by an attempt cap so you don't spin
  (goose: cap 2, `goose/crates/goose/src/agents/agent.rs:2372`; claude-code's
  reactive path withholds the 413 from the consumer until recovery fails).

**3. How to compact.** Ask the model to summarize the transcript, then *rebuild*
the history from a few fixed pieces rather than appending the summary. codex
rebuilds `[initial_context] + [recent user msgs ≤ 20k tokens] + [summary]`
(`codex/codex-rs/core/src/compact.rs:585`); claude-code rebuilds
`[boundaryMarker, ...summary, ...preservedTail, ...attachments]`
(`claude-code/src/services/compact/compact.ts:330`). The summary prompt is the
real lever — claude-code's structured template has the model fill nine fixed
sections (intent, technical concepts, files & code, errors/fixes, problem solving,
all user messages, pending tasks, current work, optional next step) inside a
`<summary>` block (`claude-code/src/services/compact/prompt.ts:61`).

**4. Don't delete — hide.** The cleanest idea is goose's **dual visibility**: every
message carries `user_visible` and `agent_visible` flags. Compaction marks the old
messages `agent_invisible` (still user-visible) and the summary `agent_only`
(`goose/crates/goose/src/context_mgmt/mod.rs:141`); only `is_agent_visible()`
messages are sent to the model (`goose/crates/goose/src/agents/reply_parts.rs:269`).
The transcript stays whole for the user and replay is clean.

Below summarization sit **cheaper tiers** you reach for first, because they cost no
extra model call: cap each tool result's size and spill the overflow to a file
pointer + preview (claude-code `maxResultSizeChars`,
`claude-code/src/Tool.ts:466`), and a non-LLM prune that erases stale tool-output
*content* by id once enough recent tokens are protected (opencode,
`opencode/packages/opencode/src/session/compaction.ts:242`).

### Flow

1. Top of turn: compute `estimate = approxTokens(agentVisibleMessages)`.
2. If `estimate > contextWindow − buffer`: run the summarizer (one model call over
   the transcript).
3. Rebuild history: `[initial context] + [recent user messages ≤ N tokens] +
   [summary]`; preserve the latest user message verbatim.
4. Mark the compacted-away messages agent-invisible; mark the summary agent-only.
   Resume the loop on the rebuilt history.
5. If instead the model call returns `context-length-exceeded`: same compaction,
   then retry — up to an attempt cap, after which surface the error.
6. Independently, on every tool result: if `len > cap`, spill to disk and replace
   with a preview + pointer. Optionally prune stale tool outputs without an LLM.

```text
BUFFER          = 13_000            # absolute reserve, OR use ratio 0.8
RECENT_BUDGET   = 20_000            # tokens of trailing user msgs to keep verbatim

function maybeCompact(messages):
    if approxTokens(agentVisible(messages)) <= contextWindow - BUFFER:
        return messages                        # under budget, no-op
    return compact(messages)

function compact(messages):
    summary  = model.summarize(agentVisible(messages))   # one extra call
    initial  = initialContext(messages)                  # system/env, re-derivable
    recent   = takeFromEnd(userMessagesOf(messages), RECENT_BUDGET)  # newest-first
    rebuilt  = initial + recent + [summary]
    for m in messages: m.agentVisible = false            # hide, don't delete
    summary.userVisible = false                          # summary is model-only
    return rebuilt

# in the loop:
try:
    resp = model.call(system, agentVisible(messages), tools)
except ContextLengthExceeded:
    if (attempts += 1) > CAP: raise                      # bounded reactive recovery
    messages = compact(messages); continue
```

## In the wild

| Repo | Trigger / budget | Compaction strategy |
|---|---|---|
| claude-code | `effWindow − 13k` proactive + reactive 413 withhold `autoCompact.ts:72` | cheapest-first cascade → 9-section summary; `[bndry,summary,tail]` `compact.ts:330` |
| openclaude | same `AUTOCOMPACT_BUFFER 13k` `autoCompact.ts:77` | 5-layer cascade ending in same summary |
| codex | `bytes/4` heuristic; tokens `> limit` `truncate.rs:71`, `turn.rs:886` | one pass: `[init]+[recent≤20k]+[summary]` `compact.rs:585` |
| goose | usage ratio `> 0.8` `context_mgmt:188`; reactive cap 2 `agent.rs:2372` | LLM summary + dual-visibility flags `context_mgmt:141` |
| opencode | `usable = limit.input − reserved` `overflow.ts:10` | hidden compaction agent + non-LLM `prune` `compaction.ts:242` |

Divergences worth noting:

- **Tokenizer vs heuristic.** Only codex fully commits to the byte heuristic
  (`approx_token_count = ceil(bytes/4)`); the count exists only to compare against a
  threshold, so precision is wasted effort
  (`codex/codex-rs/core/src/context_manager/history.rs:519`).
- **Reserve as absolute vs ratio.** claude-code/openclaude subtract a fixed
  `13_000`-token buffer (and separately reserve up to `20k` output tokens for the
  summary itself, `autoCompact.ts:33`); goose uses a 0.8 *ratio* of the limit. Both
  reduce to "leave headroom."
- **Recent-window selection.** codex walks user messages newest-first, accumulating
  until it hits the 20k budget, truncating the boundary message if it overflows
  (`codex/codex-rs/core/src/compact.rs:598`). goose instead preserves only the
  single most-recent text-only user message verbatim
  (`goose/crates/goose/src/context_mgmt/mod.rs:112`).
- **Cheaper tiers.** claude-code stacks tool-result disk-spill → snip →
  microcompact → context-collapse → autocompact, most behind feature flags
  (`claude-code/src/query.ts:365`). opencode's `prune` is the leanest: walk back,
  protect ~25% of usable tokens worth of recent tool calls, then mark older
  completed tool outputs `compacted` — no model call
  (`opencode/packages/opencode/src/session/compaction.ts:242`). goose has a
  "middle-out" variant that removes tool responses from the *middle* of the
  transcript outward, keeping head and tail context
  (`goose/crates/goose/src/context_mgmt/mod.rs:242`).
- **Don't-delete.** goose is the only one with first-class dual visibility; codex
  and claude-code achieve non-destructiveness for the *user* via persistence
  (boundary marker / replacement history) rather than per-message flags.

## Scenario

A long refactoring session on a 200k-window model with goose's defaults (threshold
0.8, so an effective ceiling of 160k agent-visible tokens).

1. Turn 41 begins. The agent-visible history — dozens of `read`/`grep` tool
   results plus assistant reasoning — estimates at 168k tokens.
   `check_if_compaction_needed` computes `168k / 200k = 0.84 > 0.8` and returns true
   (`context_mgmt/mod.rs:232`).
2. `compact_messages` finds the most recent text-only user message ("now wire it
   into the CLI") and marks it for verbatim preservation
   (`context_mgmt/mod.rs:112`). It calls the model with the summarization prompt
   over the full agent-visible slice.
3. The model returns a structured summary: files touched, the bug fixed in step 30,
   the pending CLI-wiring task. History is rebuilt: every old message gets
   `with_agent_invisible()`, the summary becomes `agent_only`, and a continuation
   message plus the preserved user message follow (`context_mgmt/mod.rs:141`).
4. The next request now carries ~12k agent-visible tokens. The user's transcript UI
   still shows all 41 turns, because those messages are still `user_visible` —
   nothing was destroyed.
5. Turn 45: a single `cat` of a 900k-character generated file slips through the
   estimate and the provider returns `ContextLengthExceeded`. The loop's error arm
   increments `compaction_attempts` to 1 (under the cap of 2), compacts again,
   replaces the conversation, and breaks to retry the turn
   (`agent.rs:2372`). Had it failed twice, the agent would surface a "context limit
   still exceeded" message instead of looping forever.

## Lean take

- **Ship the byte heuristic.** `ceil(bytes/4)` over the agent-visible messages is
  enough to drive a threshold (codex). Add a real tokenizer only if it visibly
  misfires — it almost never will, because of the buffer.
- **Two triggers, one compaction function.** Check `estimate > window − buffer` at
  the top of the loop *and* catch `context-length-exceeded` inside it; both call the
  same `compact()`. Cap reactive retries (2 is fine) so a too-big single message
  can't spin.
- **One summarize-and-rebuild pass.** `[initial] + [recent user msgs ≤ ~20k] +
  [summary]`, latest user message preserved verbatim. A single structured-summary
  prompt covers the real cases; claude-code's 9-section template is the upgrade if
  you want fidelity. Skip the 5-layer cascade.
- **Hide, don't delete.** Add `agentVisible`/`userVisible` flags from day one and
  filter the model's view by `agentVisible` (goose). It costs almost nothing and
  makes compaction non-destructive and replay correct.
- **Cap and spill tool results before you ever summarize.** A per-tool size cap
  with disk-spill-to-pointer (claude-code `Tool.ts:466`) is the cheapest tier and
  removes the most common cause of blowups; an optional non-LLM prune of stale tool
  outputs (opencode) buys more runway with no model call.
- **Skip** middle-out thinning, per-tool-pair summarization, context-collapse
  commit-logs, and remote compaction backends until a real workload demands them.
