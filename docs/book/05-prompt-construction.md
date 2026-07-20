# 5. Prompt Construction & Caching

Every turn re-sends the system prompt, the tool schemas, and the full message
history. Prompt construction decides *what goes where* — and the layout is driven
almost entirely by one constraint: the provider caches a prefix, so anything that
changes between turns must live behind everything that does not.

## How it works

The request to the model has three top-level regions, and the cache treats them as
an ordered hierarchy: `tools → system → messages`. A cache breakpoint hashes the
cumulative prefix up to and including the marked block; a later request reads that
entry only if the prefix matches byte-for-byte. Change a block at or before the
breakpoint and the hash differs — a cache miss, and a re-write of everything after
the change. Changing a tool definition invalidates *all three* regions; changing
the system prompt invalidates system + messages but not tools.

That single rule dictates the whole design:

- **Tool descriptions travel in the `tools` field, not the prose.** They are the
  first cache region, so they must be the most stable bytes in the request.
  claude-code memoizes each tool's serialized schema for the whole session so a
  feature-flag flip or a `tool.prompt()` recompute can't churn those bytes
  (`claude-code/src/utils/api.ts:136-150`).
- **The system prompt is split into a static cacheable prefix and a dynamic
  suffix.** Identity, tone, tool-usage rules, and task guidance go first and never
  change within a session. Env info, memory, output style, MCP instructions go
  after a boundary marker. Only the prefix carries a `cache_control` marker.
- **Per-session and per-turn facts go even further back — into the message array.**
  Memory (`CLAUDE.md`/`AGENTS.md`) and the date are injected as a leading
  `<system-reminder>` *user* message, so editing memory mid-session never touches
  the cached system prefix.

### Flow

1. Build the `tools` array: for each tool, `description = await tool.prompt(...)`,
   `input_schema = zodToJsonSchema(tool.inputSchema)`; cache the result per tool
   for the session (`claude-code/src/utils/api.ts:160,171`).
2. Build the system prompt as an ordered `string[]`: static sections, then a
   `DYNAMIC_BOUNDARY` sentinel, then dynamic sections
   (`claude-code/src/constants/prompts.ts:560-576`).
3. At request time, split the array at the boundary into `{text, cacheScope}`
   blocks; attach `cache_control: ephemeral` only to blocks whose scope is non-null
   (`claude-code/src/utils/api.ts:321`, `claude-code/src/services/api/claude.ts:3213`).
4. Append session-stable system *context* (git status) to the tail of the system
   prompt (`appendSystemContext`, `claude-code/src/utils/api.ts:437`).
5. Prepend per-session *user* context (memory + date) as a `<system-reminder>` user
   message at the front of the message array (`prependUserContext`,
   `claude-code/src/utils/api.ts:449`).

```text
request layout (cache hierarchy: tools -> system -> messages)

  tools:    [ {name, description=tool.prompt(), input_schema} ... ]   <- session-stable
  system:   [ STATIC PREFIX                         ]  <- cache_control: ephemeral
            |  identity / tone / tool-usage / tasks |       (the cached prefix)
            [ ---- DYNAMIC_BOUNDARY (dropped) ----- ]
            [ env, memory*, output-style, mcp       ]  <- no cache marker
            [ + appended systemContext: git status  ]
  messages: [ <system-reminder> user msg: CLAUDE.md + date ]  <- per-session, uncached
            [ ...real conversation..., tool_results ]
            [ + per-turn reminder attachments       ]

  * memory may be a dynamic system section AND/OR the user-message reminder.
```

The `<system-reminder>` is a plain convention, not an API feature: text wrapped in
that tag inside a user message or tool result. The system prompt tells the model
these tags are injected by the system and "bear no direct relation" to the message
they ride in (`claude-code/src/constants/prompts.ts:131-133`). The memory reminder
adds "this context may or may not be relevant... do not respond to it unless highly
relevant" to curb over-anchoring (`claude-code/src/utils/api.ts:463-469`).

## In the wild

| Repo | System prompt assembly | Where dynamic facts go |
|---|---|---|
| claude-code | static prefix + `DYNAMIC_BOUNDARY` + dynamic sections `prompts.ts:560` | memory+date as `<system-reminder>` user msg `api.ts:449`; git appended to system `api.ts:437` |
| openclaude | same boundary marker + sections `prompts.ts:115,557` | `prependUserContext` `<system-reminder>` `api.ts:499`; memory also a dynamic section `prompts.ts:491` |
| opencode | per-model prompt + `input.system` + user system, joined `request.ts:58` | `<env>` block (model/cwd/git/date) as a system part `system.ts:63` |
| codex | `BaseInstructions.text` sent in Responses `instructions` field `client.rs:849,877` | AGENTS.md as a `user` item; env as a context item, not in instructions |
| goose | MiniJinja render of `system.md` `prompt_manager.rs:164` | hints/extras appended as `# Additional Instructions` `prompt_manager.rs:193` |

Divergences worth noting:

- **Cache marker placement.** claude-code/openclaude attach `cache_control` only to
  the pre-boundary blocks; the post-boundary join gets `cacheScope: null`
  (`claude-code/src/utils/api.ts:392-396`). The boundary is the breakpoint.
- **System as a field, not a message.** codex puts base instructions in the
  Responses `instructions` field (`client.rs:877`) — outside the message list
  entirely. In its `responses_lite` path it instead injects them as a leading
  `developer`-role message (`client.rs:835-846`). opencode does the field-form only
  for OpenAI OAuth (`request.ts:99`), otherwise it maps each system string to a
  `role: "system"` message (`request.ts:105-110`).
- **Templating.** goose is the only one that templates the prompt: MiniJinja over
  `system.md` with a typed context struct (`prompt_template.rs:3,85`). Everyone
  else concatenates strings.
- **Cache-stable ordering as an explicit goal.** goose sorts extensions by name
  before rendering "for multi session prompt caching"
  (`prompt_manager.rs:128-129`); opencode collapses the system array to exactly two
  blocks (header + rest) so plugins can't fragment the prefix
  (`request.ts:74-78`). Same instinct as claude-code's boundary.

## Scenario

Turn 1 of a session in claude-code. `getSystemPrompt(tools, model)` returns a
`string[]`: `[intro, system-rules, doing-tasks, actions, tool-usage, tone,
efficiency, __DYNAMIC_BOUNDARY__, session-guidance, memory, env_info, ...]`
(`prompts.ts:560-576`). `getUserContext()` discovers `CLAUDE.md` by walking cwd and
returns `{claudeMd, currentDate}` (`context.ts:170-187`); `getSystemContext()`
snapshots git status once (`context.ts:124`).

At request time `splitSysPromptPrefix` finds the boundary index, joins blocks 0..n
before it into one `{cacheScope:'global'}` block and blocks after it into one
`{cacheScope:null}` block (`api.ts:362-404`). `buildSystemPromptBlocks` stamps
`cache_control: {type:'ephemeral'}` on the global block only (`claude.ts:3213`).
`appendSystemContext` tacks git status onto the system tail; `prependUserContext`
inserts the `<system-reminder>` user message carrying `CLAUDE.md` + date ahead of
the user's first real message (`api.ts:437,449`).

Turn 2: the user sends a follow-up. The static system prefix and the tool schemas
are byte-identical, so the provider returns a cache hit for the tools region and
the system prefix — only the new user message and tool results are fresh input. The
user edits `CLAUDE.md` mid-session: because memory rides in a *user* message (after
system in the hierarchy), the system-prefix cache still hits; only the messages
region re-writes. Had memory been in the static system prefix, that edit would have
invalidated system *and* every cached message after it.

## Lean take

- **Three regions, one breakpoint.** Put a single `cache_control` marker at the end
  of your static system prefix. Keep tool schemas and the prefix byte-stable for the
  whole session; that is 90% of the caching win for ~10 lines of code.
- **Small beats clever.** Caching makes a big prompt *cheap to resend*, not *good* —
  a bloated system prompt still crowds the model's attention and buries the task. The
  spread in the wild is enormous: pi.dev ships **under 1,000 tokens**, opencode
  ~15k, claude-code ~55k. Start tiny (identity + tool-usage rules + a memory hook)
  and add a line only when a real failure demands it; every addition is a permanent
  tax on every turn.
- **Tool descriptions belong in the `tools` field.** Never inline them in the prose.
  They are the first and most cache-sensitive region; one edit invalidates the whole
  request.
- **Push volatile facts as far back as the hierarchy allows.** Env/date/git after a
  boundary in the system suffix; memory and per-turn context as `<system-reminder>`
  user messages. Anything that changes within a session must sit behind the
  breakpoint.
- **`<system-reminder>` is just a tagged string + one sentence of system-prompt
  framing.** Adopt the convention (and the "may not be relevant" hedge); skip
  building any special machinery.
- **Skip, until you need them:** per-model prompt variants, MiniJinja templating,
  multi-scope (`global`/`org`) cache tiers, the 1-hour TTL, and a second breakpoint
  for long conversations. Add the second breakpoint only once history routinely
  pushes the first one past the 20-block lookback window.
