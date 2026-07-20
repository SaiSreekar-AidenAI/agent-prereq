# 3. The Tool System

The tool system is the contract between the model and the world: a list of named,
schema-described actions the model can request, plus the machinery to validate,
gate, run, and shape their results back into the conversation. It is the only part
of the loop that touches the real filesystem, shell, and network.

## How it works

A tool is a small record: a `name`, a model-facing `description`, an `inputSchema`,
and a `call(input, ctx)` implementation. Two extra fields carry most of the
system's intelligence: `isReadOnly` (drives both parallelism and auto-approval) and
an optional `checkPermissions(input)` for tool-specific risk logic (e.g. bash
sub-command rules). Everything else a real repo piles on — UI renderers, telemetry,
classifier inputs — is product surface, not mechanism.

Three invariants make the system robust. First, the schema lives **next to** the
executing code so the model-facing description and the validator cannot drift.
Second, the schema is rendered to JSON Schema and handed to the provider as the
`tools` array; the model sees *only* `name`, `description`, and that schema. Third,
**every failure becomes a tool result, not an exception** — a schema-validation
failure, a permission denial, and a thrown error all turn into an `is_error`
tool_result fed back to the model so it self-corrects. The loop has one happy path.

The registry is deliberately not a framework: it is a hand-written array of
built-ins plus a merge step that folds in external (MCP/plugin) tools. Built-ins win
name conflicts, and the merged list is sorted for prompt-cache stability.

### Flow

1. **Declare**: each tool is built through a factory (`buildTool`) that fills
   fail-closed defaults — `isReadOnly→false`, `checkPermissions→allow` (defer to the
   global gate) — so a new tool is safe-by-default and tiny to write.
2. **Register**: collect built-ins into a flat array; merge MCP/plugin tools; sort
   by name; built-ins win conflicts.
3. **Render**: for each tool, `description = tool.prompt(...)` and `input_schema =
   zodToJsonSchema(tool.inputSchema)` (or a raw JSON Schema for MCP tools). Cache
   the serialized result per session for prompt-cache stability.
4. **Validate**: on a tool call, `inputSchema.safeParse(input)`; on failure, return a
   `<tool_use_error>` result — no crash.
5. **Gate**: run `checkPermissions` + the global allow/ask/deny gate before any side
   effect; deny returns an `is_error` result.
6. **Run**: `await tool.call(parsed, ctx)`; catch exceptions into error results.
7. **Shape**: map the output to a tool_result block; if it exceeds
   `maxResultSizeChars`, spill to disk and replace the content with a preview +
   pointer.

```text
buildTool(def):
    return { ...TOOL_DEFAULTS, ...def }   # defaults: isReadOnly=false, perms=allow

renderForModel(tools):                    # what the API sees
    return tools.map(t => {
        name:         t.name,
        description:  await t.prompt(ctx), # method, can vary by mode/agent
        input_schema: t.inputJSONSchema ?? zodToJsonSchema(t.inputSchema),
    })

executeOne(tc, tools, gate, ctx):
    tool   = tools.byName(tc.name)        # unknown name => is_error result
    parsed = tool.inputSchema.safeParse(tc.input)
    if not parsed.ok:
        return result(tc.id, "<tool_use_error>"+parsed.error+"</tool_use_error>",
                      isError=true)        # validation failure IS the result
    if (await gate.decide(tool, parsed.value, ctx)) == deny:
        return result(tc.id, "Permission denied.", isError=true)
    try:    out = await tool.call(parsed.value, ctx)
    except e: return result(tc.id, e.message, isError=true)
    block = tool.mapResultToBlock(out, tc.id)
    if size(block) > tool.maxResultSizeChars:
        block = spillToDisk(block)         # preview + file pointer
    return block
```

## In the wild

| Concern | claude-code / openclaude | codex | goose |
|---|---|---|---|
| Tool shape | structural `Tool<In,Out>` | one `ToolExecutor` trait | `rmcp::Tool` + annotations |
| Spec+run | separate object fields | `spec()`+`handle()` | served via MCP |
| Schema source | `zodToJsonSchema` | serde enum `ToolSpec` | `schemars` from struct |
| Defaults | `buildTool` fail-closed | trait defaults | `ToolAnnotations` |

- **claude-code**: the interface is `Tool<Input,Output>` with the core members
  `name`, `inputSchema` (Zod), `prompt()` (the model-facing description), `call()`,
  `checkPermissions()`, and `mapToolResultToToolResultBlockParam()`
  (`claude-code/src/Tool.ts:394,500,518,557`). `buildTool` spreads `TOOL_DEFAULTS`
  with fail-closed values — `isReadOnly→false`, `isConcurrencySafe→false`,
  `checkPermissions→allow` (`claude-code/src/Tool.ts:757,783`). Schema rendering is
  `zodToJsonSchema(tool.inputSchema)` (or `tool.inputJSONSchema` for MCP) inside a
  per-session cache (`claude-code/src/utils/api.ts:160,171`).
- **openclaude** is the same TS interface in a multi-provider fork: `buildTool` at
  `openclaude/src/Tool.ts:812`, `TOOL_DEFAULTS` at `:786`. Because the canonical wire
  format is Anthropic, MCP tools carry a raw `inputJSONSchema` used verbatim while
  Zod tools go through `zodToJsonSchema` (`openclaude/src/utils/api.ts:208`).
- **codex** collapses spec and runtime into one trait: `ToolExecutor` pairs
  `spec()` with `handle()`, with default `supports_parallel→false` and
  `exposure→Direct` (`codex/codex-rs/tools/src/tool_executor.rs:49`). `ToolSpec` is a
  serde enum (`Function{name,description,parameters}` / `Freeform`) that *is* the
  Responses-API tool object (`codex/codex-rs/tools/src/tool_spec.rs:17`).
- **goose** derives the schema from the Rust param struct via
  `schemars::schema_for!` (`goose/.../developer/mod.rs:84`) and declares tools with
  `Tool::new(name, description, schema).annotate(ToolAnnotations::...)`
  (`:101`). The `read_only_hint` annotation — not a separate flag — drives
  auto-approval (`goose/.../permission/permission_inspector.rs:44`).

Validation-failure-as-result is universal: opencode's `wrap` decodes args and maps
a decode failure to `InvalidArgumentsError`, whose message becomes the tool result
(`opencode/.../tool/tool.ts:99,121`); codex returns
`FunctionCallError::RespondToModel(...)` for bad args (vs `Fatal` which aborts)
(`codex/codex-rs/core/src/tools/registry.rs:124,457,488`); claude-code returns an
`InputValidationError` tool_result with `is_error:true`
(`claude-code/.../toolExecution.ts:615,670`).

**Registry as a flat list + merge.** claude-code's `getAllBaseTools()` is a literal
array gated by env/feature flags (`claude-code/src/tools.ts:193`); `assembleToolPool`
sorts built-ins, appends MCP tools, and `uniqBy('name')` so built-ins win
(`claude-code/src/tools.ts:345`). opencode builds its ~14 built-ins the same way —
`invalid, shell, read, glob, grep, edit, write, task, fetch, todo, ...`
(`opencode/.../tool/registry.ts:218`). codex diverges: tools are registered per turn
into a router rather than a static array.

**Result truncation / disk-spill** bounds context growth before any summarization.
claude-code spills any result over `tool.maxResultSizeChars` to a file and gives the
model a preview + path (`claude-code/src/Tool.ts:466`,
`.../toolResultStorage.ts:193`); `Read` sets it to `Infinity` to avoid a
Read→file→Read loop. opencode auto-truncates output past `MAX_LINES=2000` /
`MAX_BYTES=50KB` to a temp file and tells the model to Grep/Read it
(`opencode/.../tool/truncate.ts:15,130,139`).

**Read-only drives two things.** Beyond auto-approval, the read-only flag partitions
execution: consecutive concurrency-safe tools run in parallel while writers
serialize (claude-code `toolOrchestration.ts`, cap 10; codex takes an `RwLock`
read-guard for parallel tools and a write-guard for serial ones,
`codex/codex-rs/core/src/tools/parallel.rs:117`).

## Scenario

The model emits a `tool_use` block: `{name:"write", input:{path:".git/config",
content:"..."}}`.

1. **Render** (earlier): `write` was sent to the model as `{name:"write",
   description:"Write content to a file...", input_schema:{path:string,
   content:string}}` via `zodToJsonSchema`.
2. **Validate**: `inputSchema.safeParse({path,content})` succeeds — both fields
   present and typed. (Had `content` been missing, the executor would return
   `<tool_use_error>InputValidationError: content is required</tool_use_error>` and
   the loop would continue, letting the model retry.)
3. **Gate**: `write.checkPermissions({path:".git/config"})` hits the bypass-immune
   safety floor — writes under `.git/` always `ask`, even in bypass mode — so the
   gate blocks for a user decision. The user denies.
4. **Result**: instead of aborting, the executor emits `{type:tool_result,
   tool_use_id:..., content:"Permission denied.", is_error:true}`. The pairing
   invariant holds (every `tool_use` got a `tool_result`), so the next model call
   won't 400.
5. **Continue**: the model sees the denial, apologizes, and proposes editing a
   different file — self-correction with zero loop-level special-casing.

Had the write succeeded and produced a 200 KB confirmation blob (it won't, but a
`bash` cat would), step 4 would instead map the output to a block, notice it exceeds
`maxResultSizeChars`, write it to disk, and hand back a preview plus the file path.

## Lean take

- Build the four-field tool — `{name, description, inputSchema, call}` — plus
  `isReadOnly` and an optional `checkPermissions`. Keep the schema in the same file
  as `call` so they cannot drift; codex's single `spec()`+`handle()` trait is the
  cleanest expression of this. Skip the ~30 UI/telemetry members entirely.
- Use a `buildTool` factory with fail-closed defaults (`isReadOnly→false`,
  `checkPermissions→allow`). It makes every tool safe-by-default and a few lines to
  declare.
- Make schema-validation failure, permission denial, and thrown exceptions **all**
  return an `is_error` tool result. This is the single highest-leverage decision in
  the chapter: it gives the loop one happy path and lets the model repair itself.
- Ship the irreducible set: `read`, `write`, `edit`, `bash`, `glob`, `grep`. Every
  repo has exactly these; codex's minimum is literally shell + apply_patch.
- The minimalist datapoint: **pi.dev ships only four** — `read`, `write`, `edit`,
  `bash` — on the thesis that the model already knows the coding task, so anything
  else is "situational and opt-in." No MCP/subagents/todos in-core; every extra is a
  user-loaded extension the agent can even write for itself (Ch. 17). If in doubt,
  start at four and grow by demonstrated need.
- The registry is an array, not a plugin bus. Convert each schema to JSON Schema
  once, sort by name for cache stability, merge externals with built-ins winning.
- Cap each result's size and spill the overflow to a file with a preview + pointer.
  This bounds context cheaply and defers the need for compaction. Derive schemas
  from your param type (zod / schemars) rather than hand-writing JSON Schema.
