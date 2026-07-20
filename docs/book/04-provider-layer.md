# 4. The Model & Provider Layer

The provider layer is the seam between your agent loop and the LLM API. It builds
one request, opens a streaming connection, parses server-sent events (SSE) into an
internal event union, assembles tool calls from incremental JSON fragments, and
retries or falls back when the network or the model misbehaves. Everything above it
(the loop, tools, compaction) should be provider-agnostic.

## How it works

A turn is one streaming HTTP request. You send the full message history, a system
prompt, and the tool schemas; the server streams back a sequence of typed events
that you fold into assistant message blocks. The defining detail of the Anthropic
Messages API is that **content arrives as indexed blocks built up by deltas**, and a
tool call's arguments arrive as a *string* of incremental JSON fragments
(`input_json_delta`) that is only valid JSON once the block closes.

The request body for the Anthropic Messages API is small: `model`, `messages`,
`system`, `tools`, `tool_choice`, `max_tokens`, and `stream: true`
(`claude-code/src/services/api/claude.ts:1700`). Each tool entry is
`{ name, description, input_schema }`, where `description` is the model-facing prompt
and `input_schema` is JSON Schema derived from a Zod schema via `zodToJsonSchema`, or
a raw `inputJSONSchema` for MCP tools (`claude-code/src/utils/api.ts:157`).

The stream parser keeps a sparse array `contentBlocks[index]`. Events mutate the
block at their `index`: `content_block_start` seeds it (a `tool_use` block starts with
`input: ''` — an empty *string*, not an object), `content_block_delta` appends, and
`content_block_stop` finalizes. The crucial asymmetry: text deltas append to a
string that is always usable, but tool-input deltas append raw JSON characters that
are a syntactically-incomplete fragment until the block closes. So you **never**
`JSON.parse` mid-stream — you accumulate, then parse exactly once at block close.

### Flow

1. Build the request: `messages` (full or windowed history), `system`, `tools`
   (each `{name, description, input_schema}`), `max_tokens`, `stream: true`.
2. Open the SSE stream; `message_start` carries the message envelope and initial
   `usage`.
3. For each `content_block_start`, seed `contentBlocks[index]` by type. A `tool_use`
   block stores its `input` as an empty string accumulator.
4. For each `content_block_delta`, dispatch on `delta.type`: `text_delta` appends to
   `.text`; `input_json_delta` appends `partial_json` to the `.input` string;
   `thinking_delta`/`signature_delta` append to the thinking block.
5. On `content_block_stop`, finalize the block — and for `tool_use`, `JSON.parse` the
   accumulated input string (with a safe fallback to `{}` on parse failure).
6. `message_delta` carries the final `usage` and the real `stop_reason`; write them
   back onto the already-emitted assistant message. `message_stop` ends the stream.
7. On a transient error, retry with backoff; on repeated overload, swap to a
   fallback model and re-issue the whole request.

```text
parse_stream(sse):
  blocks = {}            # index -> partial block
  for event in sse:
    switch event.type:
      message_start:        msg = event.message; usage = msg.usage
      content_block_start:
        if event.block.type == "tool_use":
          blocks[event.index] = { ...event.block, input: "" }   # STRING accumulator
        else:
          blocks[event.index] = { ...event.block, text: "" }
      content_block_delta:
        b = blocks[event.index]
        switch event.delta.type:
          text_delta:        b.text  += event.delta.text
          input_json_delta:  b.input += event.delta.partial_json # raw JSON chars
      content_block_stop:
        b = blocks[event.index]
        if b.type == "tool_use":
          b.input = safe_json_parse(b.input) or {}   # PARSE ONLY HERE
        emit_block(b)
      message_delta:    usage = event.usage; stop_reason = event.delta.stop_reason
      message_stop:     done()
```

Why parse only at close: a partial like `{"path": "/et` is not valid JSON, and the
empty-object fallback at close means a truncated stream degrades to "tool got empty
args" (which validation rejects gracefully) rather than crashing the parser.

## In the wild

All five hand-roll or delegate the same accumulate-then-parse pattern; they differ
in how special-cased tool calls are and how many providers they speak.

| Repo | Wire format | Tool-call assembly |
|---|---|---|
| claude-code | Anthropic Messages | accumulate `input_json_delta`, parse at stop |
| openclaude | Anthropic (canonical) | same, per-provider SSE translated inward |
| codex | OpenAI Responses only | not special-cased; whole item then router |
| goose | per-format state machine | accumulate `partial_json`, parse at stop |
| opencode | Vercel AI SDK | SDK owns SSE; only normalize to events |

- **claude-code** appends `input_json_delta.partial_json` to `contentBlock.input`
  during the stream (`claude-code/src/services/api/claude.ts:2111`), and at
  `content_block_stop` emits the block through `normalizeContentFromAPI`
  (`claude-code/src/utils/messages.ts:2651`) which `safeParseJSON`s the accumulated
  string and falls back to `{}` (`claude-code/src/utils/messages.ts:2677`). The real
  `stop_reason` arrives later on `message_delta` and is mutated back onto the emitted
  message (`claude-code/src/services/api/claude.ts:2242`).
- **goose** runs an explicit SSE state machine in `response_to_streaming_message`
  (`goose/crates/goose-providers/src/formats/anthropic.rs:733`). An
  `InputJsonDelta` pushes `partial_json` into a per-tool `args` string
  (`anthropic.rs:868`); `content_block_stop` parses it with `parse_tool_arguments`
  (`anthropic.rs:903`). Its `Provider::stream` trait returns a `MessageStream`
  (`goose/crates/goose-providers/src/base.rs:386`), and `complete` is just
  `collect_stream(stream)` (`base.rs:394`).
- **codex** does *not* special-case tool calls in the SSE layer. `kind` strings map
  to a typed `ResponseEvent` enum (`codex/codex-rs/codex-api/src/common.rs:74`,
  parsed in `sse/responses.rs:315`); tool calls arrive as ordinary
  `OutputItemDone` items and a separate router extracts them. This cleanly splits
  "parse the stream" from "interpret tool calls".
- **openclaude** keeps the whole codebase Anthropic-shaped and runs per-provider
  translators that *re-emit Anthropic events*. `openaiStreamToAnthropic`
  (`openclaude/src/services/api/openaiShim.ts:1998`) accumulates OpenAI
  `delta.tool_calls` into a per-call `jsonBuffer` and synthesizes
  `content_block_start` / `input_json_delta` / `content_block_stop`. It even recovers
  tool calls weak local models emit as plain text or XML
  (`openaiShim.ts:1578`, `:1680`).
- **opencode** delegates SSE *and* tool dispatch to the Vercel AI SDK and only
  normalizes the SDK's stream parts into its own event union — lowest effort, highest
  dependency.

**The internal event union.** Two shapes recur. claude-code/openclaude keep the
Anthropic stream-event shape *as* the internal union (so non-Anthropic providers
translate inward to it). codex defines its own `ResponseEvent` enum with rich
variants (`Completed { token_usage, end_turn }`, `OutputItemDone`,
`OutputTextDelta`, `RateLimits`) decoupled from any one wire format
(`codex/codex-rs/codex-api/src/common.rs:74`). Either way, the loop above the parser
sees one event type, never raw SSE.

**Retry and fallback.** claude-code's `withRetry`
(`claude-code/src/services/api/withRetry.ts:170`) is a
`for (attempt = 1..maxRetries+1)` generator. It honors a `retry-after` header, else
uses exponential backoff `BASE_DELAY_MS * 2^(attempt-1)` capped at 32s with 25%
jitter (`withRetry.ts:530`). 529 ("overloaded") is capped at `MAX_529_RETRIES = 3`
and dropped immediately for background sources. Model fallback is a *separate*
mechanism: on repeated 529 with a `fallbackModel` set, it throws
`FallbackTriggeredError` (`withRetry.ts:347`) which the agent loop catches to swap
`currentModel = fallbackModel` and re-issue the whole request. codex backs off
similarly, preferring a server-requested delay, and reuses the turn-scoped session
across retries to keep sticky routing; after exhausting retries it switches transport
(WebSocket→HTTPS) before giving up
(`codex/codex-rs/core/src/responses_retry.rs:22`). goose classifies transient errors
with a `RetryConfig`; opencode uses an Effect retry policy keyed per provider.

## Scenario

The model decides to read a file. Request goes out with `stream: true` and the `Read`
tool schema. The SSE stream returns:

```text
message_start         { usage: {input_tokens: 4120, output_tokens: 0}, stop_reason: null }
content_block_start   index=0 { type: "text" }
content_block_delta   index=0 text_delta "I'll read that file."
content_block_stop    index=0                         -> emit text block
content_block_start   index=1 { type: "tool_use", id: "toolu_01", name: "Read",
                                input: "" }
content_block_delta   index=1 input_json_delta '{"file_'
content_block_delta   index=1 input_json_delta 'path": "/e'
content_block_delta   index=1 input_json_delta 'tc/hosts"}'
content_block_stop    index=1     -> JSON.parse('{"file_path":"/etc/hosts"}') = {ok}
message_delta         { stop_reason: "tool_use", usage: {output_tokens: 38} }
message_stop
```

What the parser does: at index=1's `content_block_start` it stores
`blocks[1] = {type:"tool_use", id:"toolu_01", name:"Read", input:""}`. Each delta
appends raw characters — after the second delta `input` is `'{"file_path": "/e'`,
which is *not* parseable, so no parse is attempted. At `content_block_stop` the
accumulated `'{"file_path": "/etc/hosts"}'` parses to `{file_path:"/etc/hosts"}`. The
assistant message is emitted with `stop_reason: null`; the real `stop_reason:
"tool_use"` lands on `message_delta` and is written back. The loop sees a `tool_use`
block present (not the `stop_reason`), so it executes `Read`, appends a `tool_result`,
and re-issues the next turn. Had the stream truncated mid-arguments, the close-time
parse would fail and fall back to `{}`, surfacing as an input-validation error the
model can correct — not a crash.

## Lean take

- **Hand-roll one provider's SSE accumulator.** It is ~150 lines: a
  `blocks[index]` map, a `switch` on event type, and a `switch` on delta type. Target
  the Anthropic Messages shape — indexed blocks make assembly trivial.
- **Accumulate tool-call JSON as a string; parse exactly once at block close**, with
  an empty-object fallback. Never parse a partial. This single rule eliminates a whole
  class of mid-stream crashes.
- **Define one internal event union and translate every provider inward to it.** Copy
  openclaude's seam (one canonical shape, per-transport translators) rather than
  branching the loop on provider. Skip multi-provider entirely until you need a second
  model.
- **Trust the content, not `stop_reason`.** Drive the loop off the *presence of a
  `tool_use` block*; treat `message_delta`'s `stop_reason` as advisory usage/metadata.
- **Retry is exponential backoff + `retry-after`, plus one fallback-model swap.** Cap
  overload retries low. Implement model fallback as a thrown signal the loop catches,
  not as branching inside the parser.
- **Skip:** WebSocket transport, non-streaming fallback, sticky-session reuse,
  Bedrock/Vertex field-stripping, and weak-model text/XML tool-call recovery — all
  real, all deferrable until a concrete provider forces them.
