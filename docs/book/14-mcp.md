# 14. MCP (Model Context Protocol)

MCP is a JSON-RPC protocol that lets an agent plug in external **tools**,
**resources**, and **prompts** from servers it did not write. The agent is an MCP
*host*: it spawns/connects to servers, lists their capabilities, adapts each
discovered tool into its native tool interface, and merges them into the registry
so the model cannot tell a remote tool from a built-in.

## How it works

An MCP server exposes three capability families over JSON-RPC: `tools/list` +
`tools/call`, `resources/list` + `resources/read`, and `prompts/list` +
`prompts/get`. The host opens a **transport** to the server, performs an
`initialize` handshake (exchanging protocol version + capabilities + client
identity), then drives those RPCs. The host can also serve *back* to the server:
`roots/list` (which dirs the agent works in), `sampling/createMessage` (server
asks the agent's LLM to complete), and `elicitation/create` (server asks the user
a question). Notifications flow server→host (progress, logging, `tools/list_changed`).

The single load-bearing idea: a discovered MCP tool carries `{name, description,
inputSchema(JSON), annotations}` — which is *exactly* the shape of a native tool.
So adaptation is mechanical: wrap the MCP tool in the host's `Tool`/`ToolExecutor`
interface, pass the raw JSON schema straight to the model, and route `call()` to
`client.callTool(name, args)`. The result `{content[], isError}` becomes a normal
tool-result block. Built-ins win name conflicts; the merged pool is sorted for
prompt-cache stability.

Transports are additive. **stdio** (spawn a child process, talk JSON-RPC over
stdin/stdout) is the floor and covers most local servers. **SSE** and
**Streamable-HTTP** add remote servers, with **OAuth** layered on top for auth.
**In-process** (a linked transport pair, no subprocess) and **SDK/control**
transports are optimizations for servers you bundle.

### Flow

1. Read server config `{type, command/url, env, headers}`.
2. Build the matching transport (stdio spawns the child; HTTP/SSE attach auth).
3. `new Client(clientInfo, capabilities)`; `client.connect(transport)` runs
   `initialize` and stores the server's `InitializeResult` (incl. instructions).
4. `tools/list` (paginate via `nextCursor`); same for resources/prompts if needed.
5. Adapt each tool: namespace the name (`serverName__tool`), copy the JSON schema,
   map `annotations.readOnlyHint`→ concurrency/permission hints, bind `call()`.
6. Merge adapted tools into the registry (built-ins first, dedup by name).
7. On a tool call the loop dispatches by name; MCP tools route to `callTool`.
8. Result content → tool-result block; `isError` → error result fed back to model.

```text
host                                   server (child proc / http)
  ── spawn/connect transport ───────────►
  ── initialize(version, caps, info) ───►
  ◄── InitializeResult(caps, instr) ─────
  ── tools/list (cursor) ───────────────►   (repeat until nextCursor == null)
  ◄── [{name, description, inputSchema, annotations}, ...]
  for each tool: adapt -> NativeTool{ name: srv__tool, schema, call }
  merge into registry  (built-ins first; dedup by name; sort)
  ...model emits tool_use srv__tool(args)...
  ── tools/call(name, args) ────────────►
  ◄── { content:[...], isError? } ────────  -> tool_result block -> next turn
```

## In the wild

| Repo | Transports | Tool adaptation | Server mode |
|---|---|---|---|
| claude-code | 5 + OAuth `client.ts:944` | raw schema in `MCPTool` `client.ts:1813` | stdio `entrypoints/mcp.ts:47` |
| openclaude | 5 + sdk + OAuth `client.ts:652` | adapt + re-expose `mcp.ts:98` | stdio + gRPC `grpc/server.ts` |
| codex | stdio/HTTP/in-proc `rmcp_client.rs:47` | `ToolExecutor` `handlers/mcp.rs:67` | yes `codex_tool_runner.rs:57` |
| goose | 5 incl. Builtin `extension.rs:163` | all are `rmcp::Tool` `mcp_client.rs:78` | host-only |
| opencode | stdio/SSE/HTTP+OAuth | merged, blanket-ask | — |

Divergences worth noting:

- **goose makes MCP the only tool bus.** `McpClientTrait` (`mcp_client.rs:78`) is
  the universal interface; the built-in `developer` editor implements it in-process
  (`developer/mod.rs:176`) exactly like a remote server. One dispatch path, one
  schema format. Dispatch is `agent.rs` → `ExtensionManager::dispatch_tool_call`
  (`extension_manager.rs:1744`), which resolves `extension__tool` namespacing. The
  trait covers the *full* surface — `list_tools`/`call_tool`/`list_resources`/
  `read_resource`/`list_prompts`/`get_prompt`/`subscribe` (`mcp_client.rs:103-142`)
  — plus host callbacks `create_message` (sampling, `:376`) and `create_elicitation`
  (`:463`), and forwards `tools/list_changed` to rebuild the tool list mid-loop.
- **codex wraps MCP tools in the same trait as built-ins.** `McpHandler`
  (`handlers/mcp.rs:67`) implements `ToolExecutor`: `spec()` exposes the server's
  JSON schema as a Responses-API tool (`:233`), `supports_parallel_tool_calls()`
  honors `read_only_hint` (`:76`), `handle()` calls `handle_mcp_tool_call` (`:145`).
  MCP tools are first-class registry entries, not a special path.
- **The TS repos adapt, then merge with built-ins winning.** claude-code's
  `connectToServer` is `memoize`d (`client.ts:595`); discovered tools are spread
  over a shared `MCPTool` template (`client.ts:1770`) with the **raw** server
  schema as `inputJSONSchema` (no Zod re-validation, `client.ts:1813`) and
  `checkPermissions` returning `passthrough` so the rule engine governs them
  (`client.ts:1814`). `assembleToolPool` sorts each partition and `uniqBy`-dedups
  so **built-ins win name conflicts** and stay a contiguous cache prefix
  (`tools.ts:345-366`).
- **Names are namespaced** to avoid collisions: claude-code `serverName__tool`
  (`buildMcpToolName`, `client.ts:1768`), goose `extension__tool`
  (`extension_manager.rs:1395`), codex `mcp__server__tool` (`handlers/mcp.rs:48,59`).
- **Annotations drive behavior, not just docs.** `readOnlyHint` → concurrency-safe
  + read-only (claude-code `client.ts:1796`), parallel-eligible (codex `:76`),
  SmartApprove auto-allow (goose). `destructiveHint`/`openWorldHint` flow through too.
- **Resources & prompts** get surfaced as their own first-class tools in the TS
  repos: `ListMcpResourcesTool`/`ReadMcpResourceTool` (`client.ts:53,56`) and MCP
  prompts as slash-commands. goose/codex call `list_resources`/`read_resource`
  directly through the client trait.

## Scenario

A user configures a Postgres MCP server: `{"db": {"command": "pg-mcp", "args":
["--dsn", "..."]}}`. End-to-end in claude-code:

1. At startup `connectToServer("db", ref)` sees `type: 'stdio'` (or absent) and
   spawns the child with `StdioClientTransport`, piping stderr away from the UI
   (`client.ts:944-958`).
2. `new Client(...)` declares `roots` + `elicitation` capabilities, registers a
   `ListRoots` handler returning `file://<cwd>`, then `client.connect(transport)`
   runs `initialize` under a timeout (`client.ts:985-1048`).
3. `tools/list` returns `query_sql` with `{inputSchema: {sql: string},
   annotations: {readOnlyHint: true}}`. The adapter produces a tool named
   `mcp__db__query_sql`, `isConcurrencySafe()`→`true`, `inputJSONSchema` = the raw
   schema, `call()` bound to `callMCPTool` (`client.ts:1768-1840`).
4. `assembleToolPool` merges it after the sorted built-ins (`tools.ts:363`). The
   model now sees `mcp__db__query_sql` indistinguishable from `Read`/`Bash`.
5. Model emits `tool_use mcp__db__query_sql({sql:"select ..."})`. The permission
   layer sees `passthrough` and applies the user's allow rule. Dispatch calls
   `client.callTool("query_sql", {sql})`.
6. The server returns `{content:[{type:"text", text:"...rows..."}]}`;
   `transformResultContent` maps it to a tool-result block (`client.ts:2478`).
   Because the tool is concurrency-safe it could have batched in parallel with
   other reads. The result re-enters history and the loop continues.

## Lean take

- **Ship stdio first, nothing else.** Spawn child, JSON-RPC over stdin/stdout,
  `initialize` → `tools/list` → `tools/call`. That is 90% of real-world servers and
  ~150 lines on top of an SDK. Add Streamable-HTTP + OAuth only when a user needs a
  remote server; SSE is effectively legacy.
- **Adapt, don't re-model.** A discovered MCP tool already matches your tool
  interface. Copy its JSON schema verbatim (do *not* round-trip through your schema
  lib), namespace the name (`server__tool`), and bind `call → client.callTool`.
- **Merge so built-ins win.** Concatenate built-ins (sorted) then MCP tools
  (sorted), dedup by name. Built-ins as a stable prefix keeps the prompt cache warm.
- **Honor `readOnlyHint`.** It is the one annotation worth wiring: drive
  parallel-eligibility and auto-approve from it for free, like codex/goose.
- **Steal goose's idea if greenfield:** make MCP your *only* tool interface and
  implement built-ins as in-process clients (`mcp_client.rs:78`). One dispatch path,
  one schema format, and the whole MCP ecosystem for free.
- **Skip until asked:** resources/prompts (surface lazily as their own tools),
  sampling, elicitation, `list_changed` hot-reload, and **server mode** (exposing
  your agent as an MCP server, ~100 lines of `ListTools`/`CallTool` handlers —
  claude-code `entrypoints/mcp.ts:59,99`) are all additive product surface.
