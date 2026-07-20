# 2. Messages, Blocks & Conversation State

The conversation is the agent's entire working memory: an ordered list of
role-tagged messages, each carrying a list of typed content blocks. This chapter
fixes the wire format every loop reads and writes, decides where that list lives
between turns, and states the one structural invariant that keeps the provider
from rejecting your next request.

## How it works

Every provider that supports tool use converges on the same two-level shape: a
**message** with a `role` and a `content` array, and **content blocks** that are a
tagged union — `text`, `tool_use` (the model asks to call a tool), `tool_result`
(you feed the output back), and `thinking`/`reasoning`. A turn is a sequence of
these messages; the loop reads the latest assistant message's blocks to decide
whether to continue (see Chapter 1) and appends new messages as it runs tools.

Two design decisions sit on top of this format. First, **where the list lives**.
The mutable in-memory camp (claude-code, openclaude, codex) holds one growing
array and mutates it each turn; the reload camp (opencode) persists every message
to a store and re-derives "latest user / latest finished assistant / pending work"
from it on every turn, holding no mutable conversation object at all. Second,
**dual visibility**: goose tags each message with `user_visible` and
`agent_visible` flags so compaction can hide a message from the model while
keeping it in the user's transcript — non-destructive by construction.

The invariant that binds it all: **every `tool_use` block must have a matching
`tool_result`** (paired by id) before the next model call, or the API 400s. This
is enforced at the data layer, not the loop layer.

### Flow

1. User input becomes a `user` message with one or more content blocks (text,
   images); append to history.
2. Build the request: system prompt + tool schemas + the message list (full, or
   sliced after the last compaction boundary).
3. Stream the assistant reply; accumulate blocks by index into one `assistant`
   message: `text`, `thinking`, and `tool_use` (args assembled from JSON deltas).
4. For each `tool_use`, run the tool, wrap the output as a `tool_result` block
   carrying the same `id`, and append it inside a `user` message.
5. Before the next request, **normalize**: ensure every emitted `tool_use` has a
   `tool_result`; back-fill a synthetic error result for any unpaired one; drop
   orphan results whose call was compacted away.
6. Loop. State either persists in the mutable array or is re-derived from the
   store.

```text
Message  = { role: 'user'|'assistant', content: ContentBlock[] }
ContentBlock =
  | { type:'text',        text }
  | { type:'thinking',    thinking, signature }
  | { type:'tool_use',    id, name, input }          # assistant -> "run this"
  | { type:'tool_result', tool_use_id, content, is_error? }  # user -> "here"

# the pairing invariant, run at request-build time:
normalize(history):
  emitted  = { b.id          for msg.b in history if b.type=='tool_use' }
  resolved = { b.tool_use_id for msg.b in history if b.type=='tool_result' }
  for id in emitted - resolved:        # tool_use with no result
      append user msg [tool_result(id, "aborted/error", is_error=true)]
  for r in history if r.tool_use_id not in emitted:   # orphan result
      drop r
  assert no duplicate tool_use ids     # API: "tool_use ids must be unique"
```

## In the wild

| Repo | Block union lives in | State model |
|---|---|---|
| claude-code | inferred `Message` (not in tree) | mutable `Message[]` |
| openclaude | `types/message.ts:372` | mutable `Message[]` |
| codex | `ResponseItem` enum `models.rs:934` | mutable `Vec<ResponseItem>` |
| goose | `MessageContent` `message.rs:271` | `Vec<Message>` + flags |
| opencode | AI-SDK parts | reload from SQLite |

- **openclaude** is the cleanest reference for the canonical Anthropic shape:
  `UserMessage` (`types/message.ts:90`) and `AssistantMessageContent`
  (`:144`, `{role,content,id,model,usage}`) wrap `BetaContentBlock` /
  `ContentBlockParam` from the SDK (`:29`). A *normalized* message holds exactly
  one block per message (`NormalizedUserMessage`, `:420`) so the loop can reason
  block-by-block.
- **claude-code** carries the live array in `QueryEngine.mutableMessages`
  (`QueryEngine.ts:186,202`) and a per-turn `State.messages`
  (`query.ts:205`). It distrusts `stop_reason:'tool_use'` and keys the loop on
  block presence (`query.ts:554`).
- **codex** models messages as `ResponseItem::Message{role,content:Vec<ContentItem>}`
  (`models.rs:943`) where `ContentItem` is `InputText|InputImage|OutputText`
  (`models.rs:844`); tool calls are *sibling* items
  (`FunctionCall`/`FunctionCallOutput`, `models.rs:996,1033`), not blocks inside a
  message. History is a `Vec<ResponseItem>` (`history.rs:38-40`) resent in full via
  `for_prompt` (`history.rs:141`).
- **goose** puts visibility on `MessageMetadata` (`message.rs:672`):
  `user_visible` (`:674`) and `agent_visible` (`:676`), both defaulting `true`
  (`:689`). `agent_only()` (`:699`) and `with_agent_invisible()` (`:726`) flip
  them; token counting and provider serialization filter on
  `is_agent_visible()` (`token_counter.rs:143`, `message.rs:1080`).
- **opencode** holds *no* mutable conversation: `MessageV2.latest(msgs)`
  (`message-v2.ts:585`) re-derives latest-user / latest-assistant /
  latest-finished / pending tasks by max id each turn, and `prompt.ts:1096` drives
  stop/continue from that. `filterCompacted` (`message-v2.ts:521`) reorders for the
  model without mutating storage.

**Divergence to note:** claude-code/openclaude/goose nest tool blocks *inside*
messages (Anthropic shape); codex makes calls and outputs *peer items* in a flat
vec (Responses shape). The pairing invariant is identical either way — it is
about `id` ↔ `tool_use_id`/`call_id` matching, not nesting.

## Scenario

The model asks to run two tools but the process is killed after the first
finishes. History at that moment (Anthropic shape):

```text
user:      [text "rename foo.py and run tests"]
assistant: [tool_use id=A name=edit_file ..., tool_use id=B name=bash ...]
user:      [tool_result tool_use_id=A "ok"]        # B never ran
```

On the next turn the loop builds the request and runs the normalizer. It sees
`emitted={A,B}` but `resolved={A}`, so B is unpaired. Rather than abort or 400, it
back-fills a synthetic result (claude-code `yieldMissingToolResultBlocks`,
`query.ts:123-148`; openclaude `ensureToolResultPairing`, `messages.ts:6010`;
codex `ensure_call_outputs_present`, `normalize.rs:17`, emitting `"aborted"`):

```text
user: [tool_result tool_use_id=B content="<interrupted>" is_error=true]
```

Now `emitted == resolved`, the request is well-formed, and the model sees that B
was interrupted and can retry it. The inverse case — a `tool_result` whose
`tool_use` was dropped by compaction — is handled by the orphan sweep
(codex `remove_orphan_outputs`, `normalize.rs:144`; openclaude strips the orphan
result, `messages.ts:6044`). Both run inside `normalize_history` at
prompt-build time (`history.rs:359-364`), so the loop body never has to think
about pairing.

## Lean take

- **Adopt the Anthropic block shape verbatim:** `{role, content[]}` with
  `text | tool_use | tool_result | thinking`. It is the most widely supported
  tagged union and maps cleanly onto OpenAI's flat items if you ever port. Don't
  invent your own.
- **Pair by id, enforce once, at request-build time.** Write one `normalize()`
  that back-fills missing `tool_result`s (with `is_error:true`), drops orphans,
  and de-dups `tool_use` ids. This single function removes a whole class of 400s
  and lets the loop stay dumb.
- **Start with one mutable in-memory array.** Reload-from-store (opencode) is
  genuinely cleaner for cancel/resume/compaction correctness, but it needs a
  persistence layer and monotonic ids first. Add it when you need durable
  sessions, not before.
- **Steal goose's dual visibility flags early** (`user_visible`/`agent_visible`).
  They are two booleans on each message but make compaction non-destructive: hide
  old turns from the model, keep them in the transcript. Filter on `agent_visible`
  wherever you serialize to the provider or count tokens.
- **Keep `thinking` blocks attached to their turn.** They must travel with the
  assistant message (and survive across the following `tool_result`) or the
  provider rejects the trajectory — treat them as load-bearing, not cosmetic.
- **Skip** the dozen system/UI message subtypes (boundaries, summaries, metrics)
  the production repos carry; those are transcript-rendering and telemetry, not
  conversation state.
