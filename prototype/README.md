# Minimal agent prototype

The smallest *real* coding-agent loop — distilled from the five repos studied in
`../docs/` — now with the **self-extension** pattern from pi.dev (Ch. 17). Zero
dependencies, runs on **Node 24** (which strips TS types natively, so `.ts` runs
directly).

```
agent.ts        # THE LOOP + model I/O + dynamic registry + CLI (read this first)
tools.ts        # the 4 built-in tools: bash / read_file / write_file / edit + approval gate
extensions.ts   # the self-extension loader (dynamic TS import + hot reload)
extensions/     # drop-in tools; word_count.ts ships as the example/template
package.json    # just { "type": "module" }
```

## Run it

```bash
# Mock mode — no API key. Scripted demo of the loop.
node agent.ts "list the files here"

# Mock self-build demo — the agent WRITES a tool and hot-loads it, no key needed.
node agent.ts "build a shout extension and use it"

# Real mode — a genuine multi-step agent.
export ANTHROPIC_API_KEY=sk-ant-...
node agent.ts "read package.json and summarize it"

# Options
export ANTHROPIC_MODEL=claude-opus-4-8    # default: claude-sonnet-4-6
node agent.ts "refactor X" --yes           # skip the per-action approval prompt
```

Side-effecting tools (`bash`, `write_file`, `edit`) pause for a `[y/N]` approval
prompt; `read_file` and `reload_extensions` run freely. That gate is the whole
"permission system" in miniature.

## Self-extension (the pi.dev idea)

The tool list is rebuilt **every turn** from `BUILTIN_TOOLS` + whatever
`extensions/*.ts` defines. An extension is a TS module exporting `register(pi)`:

```ts
export function register(pi) {
  pi.addTool({
    name: "word_count",
    description: "Count words/lines/chars in text.",
    input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    needsApproval: false,
    async run(input) { /* ... */ return { content: "..." }; },
  });
}
```

Because the agent has `write_file` + `edit`, it can author such a file itself and
then call the built-in **`reload_extensions`** tool to load it — the new tool is
usable on the very next model call. That is "the harness that builds itself,"
with no plugin marketplace: an `extensions/` dir + a loader + a reload tool.

## What this is (and isn't)

This **is** the irreducible core: the turn loop, the tool contract, the provider
call, the approval gate, and a self-extension seam.

Still deliberately omitted (see `../docs/BLUEPRINT.md`): streaming, context
compaction, sub-agents, MCP, sandboxing, a TUI, sessions/persistence, and
multi-provider adapters. The comments mark where each would slot in — or, in the
spirit of self-extension, several could be added as `extensions/`.

## The loop, in one breath

```
messages = [user(task)]
loop:
  reply = model(system, tools, messages)          # tools rebuilt each turn
  messages += assistant(reply)
  if reply has no tool calls: stop                 # NOT stop_reason
  results = [run(call) for call in reply.tool_calls]   # with approval gate
  messages += user(results)
```

Start with `agent.ts`, then read `../docs/Agent-Architecture-Handbook.pdf`.
