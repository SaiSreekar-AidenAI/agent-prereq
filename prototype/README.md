# lean-agent — the handbook, made runnable

A working multi-provider coding agent in ~4,500 lines of dependency-free
TypeScript. Every module maps to a chapter of
[`../docs/Agent-Architecture-Handbook.pdf`](../docs/Agent-Architecture-Handbook.pdf),
and the file header says which one and why the design is what it is.

Zero dependencies. Runs on **Node ≥ 22.6** (which strips TS types natively, so
`.ts` files run directly). `node test/e2e.ts` passes 69 tests with no API key.

```bash
node agent.ts                                   # interactive; no key ⇒ offline demo
node agent.ts "why is test/foo.spec.ts failing?"
node agent.ts -p "summarize README.md"          # one-shot, prints and exits
node test/e2e.ts                                # the whole suite, offline
```

## Providers

One canonical message/event shape, translators at the edge, nothing above the
provider layer knows which one is in use (Ch. 4). Pick one of:

```bash
export ANTHROPIC_API_KEY=sk-ant-...      # → claude-opus-5 by default
export OPENAI_API_KEY=sk-...             # → gpt-5
export OPENROUTER_API_KEY=sk-or-...      # → anthropic/claude-opus-5

node agent.ts -m claude-sonnet-5         # provider inferred from the model name
node agent.ts -m gpt-5
node agent.ts -m meta-llama/llama-3.3-70b-instruct        # a "/" ⇒ OpenRouter
node agent.ts --provider http://localhost:11434/v1 -m qwen2.5-coder  # Ollama, vLLM,
                                                                     # LM Studio, Groq…
```

Resolution order: `--provider` → the shape of `--model` → whichever API key is
in the environment → the offline mock. With no key at all the agent runs a
scripted demo of the loop rather than erroring.

## What's in the box

| Command | |
|---|---|
| `/help` | list commands (including your own markdown ones) |
| `/clear` | new session, empty context |
| `/compact [focus]` | summarize now and continue from the summary |
| `/resume [id]` | list past sessions, or resume one by id prefix |
| `/model [name]` | show or switch model (and the provider it implies) |
| `/permissions [mode\|rule]` | show the gate, change mode, add a rule |
| `/context` | where the context window is going |
| `/cost` | tokens and estimated spend |
| `/tools` `/todos` `/memory` `/status` `/reload` | inspect the session |
| `/init` | write an `AGENTS.md` for this repo |
| `/exit` | leave (Ctrl-D also works; Ctrl-C interrupts a turn) |

Tools: `bash` `read` `write` `edit` `glob` `grep` `ls` `todo_write` `task`
`reload_extensions`, plus anything in `extensions/`.

Flags: `-p/--print`, `-m/--model`, `--provider`, `--mode`, `-y/--yes`,
`--allow <rule>`, `-c/--continue`, `-r/--resume [id]`, `--mock`.

## Layout

```
agent.ts              CLI, REPL, wiring                       (read this second)
src/
  loop.ts             THE LOOP + tool execution + subagents   Ch. 1, 13  ← read first
  types.ts            canonical messages, blocks, events      Ch. 2, 4
  tools.ts            tool interface + the 10 built-ins       Ch. 3
  providers.ts        Anthropic & OpenAI streaming clients    Ch. 4
  config.ts           provider/model resolution, settings     Ch. 4
  prompt.ts           system prompt, cache breakpoint         Ch. 5
  context.ts          token estimate + compaction             Ch. 6
  permissions.ts      the approval gate + safety floor        Ch. 7
  memory.ts           AGENTS.md / CLAUDE.md discovery         Ch. 9
  commands.ts         slash + markdown commands               Ch. 11
  session.ts          JSONL persistence, resume, fork         Ch. 15
  extensions.ts       self-extension loader                   Ch. 17
  mock.ts             the offline provider (the test seam)    Ch. 4
  ui.ts               terminal rendering
extensions/           drop-in tools; word_count.ts is the template
test/
  fake-provider.ts    a server that speaks both wire formats
  e2e.ts              69 tests, no network beyond loopback
```

## The loop, in one breath

```
messages = [user(task)]
loop:
  if estimate > window × 0.8:  compact
  reply = stream(system, messages, tools)      # tools rebuilt every turn
  messages += assistant(reply)
  if reply has no tool_use block: stop          # NOT stop_reason
  results = [gate → run → cap(call) for call in reply.tool_use]
  messages += user(results)                     # one result per call, always
```

Three invariants hold the whole thing up, and the tests check each one:

1. **The exit signal is the absence of a `tool_use` block**, never the
   provider's `stop_reason`. Four of the five studied repos distrust it.
2. **Every `tool_use` gets exactly one `tool_result`** before the next model
   call, back-filled with a synthetic error on any abort path — otherwise the
   API 400s on unpaired blocks.
3. **Validation failures, permission denials and tool exceptions are all
   `is_error` results.** The loop has one happy path and never throws to
   control flow.

## What is implemented, and what is not

Implemented, with the chapter it comes from:

- **Ch. 1** loop, exit test, pairing back-fill, parallel read-only batching, turn guard
- **Ch. 2** canonical `Message[]`, dual `agentVisible`/`userVisible` flags
- **Ch. 3** `{name, schema, run, readOnly}` tools, fail-closed `buildTool`, result cap + disk spill
- **Ch. 4** hand-rolled SSE for two wire formats, accumulate-then-parse-once, one internal event union, retry with backoff honouring `retry-after`
- **Ch. 5** static cacheable prefix + `cache_control` + dynamic suffix, tool schemas sorted for byte stability
- **Ch. 6** byte-heuristic estimate, proactive threshold *and* reactive `context-length-exceeded` recovery, summarize-and-rebuild, hide-don't-delete
- **Ch. 7** ordered last-match-wins rules, four modes, read-only auto-allow, per-tool `checkPermissions`, bash sub-command splitting, bypass-immune safety floor
- **Ch. 9** `AGENTS.md`/`CLAUDE.md` walk with tiers and `@includes`, injected as a leading `<system-reminder>` user message
- **Ch. 11** built-in commands plus `.agent/commands/**/*.md` with `$ARGUMENTS` and permission-checked `` !`bash` ``
- **Ch. 13** subagents: the same loop recursed with a read-only tool set
- **Ch. 15** append-only JSONL sessions, resume by prefix, `--continue`, fork, todos
- **Ch. 17** `extensions/` loader + `reload_extensions`

Deliberately **not** implemented, because the handbook argues they are product
surface rather than kernel: MCP (Ch. 14), hooks (Ch. 8), skills (Ch. 10),
output styles (Ch. 12), background tasks, OS sandboxing, and a TUI. Each would
slot in at a seam that already exists — MCP tools merge through `mergeTools`,
hooks wrap `Agent.#runOne`, a UI consumes `TurnHooks` instead of `ui.ts`.

## Safety

Read-only tools run without asking. Writers go through the gate. On top of the
rule list sits a **bypass-immune floor**: writes to `.git/`, `.ssh/`, `.env`,
shell rc files, the agent's own config, or anywhere outside the working
directory always prompt — even under `--yes` or `--mode bypass`. With nobody at
the keyboard (`-p`), those calls are refused rather than left hanging on a
prompt no one can answer.

That floor is why the self-extension demo below runs from this directory:
writing into `extensions/` from an unrelated project lands outside the
workspace and is correctly refused.

## Self-extension (Ch. 17)

The tool array is rebuilt **every turn**, so a tool the agent writes becomes
callable on the very next model call. An extension exports `register(pi)`:

```ts
export function register(pi) {
  pi.addTool({
    name: "word_count",
    description: "Count words, lines and characters in text.",
    input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    readOnly: true,                                    // omit it and you get a writer
    async run(input) { return { content: `…` }; },
  });
}
```

Watch the agent write one and load it, with no API key:

```bash
node agent.ts --mock --yes "build a shout extension and use it"
```

Unlike pi.dev — which ships no permission system and trusts a sandbox — an
extension tool here goes through the same gate as a built-in.

## Configuration

`AGENT_MODEL` `AGENT_PROVIDER` `AGENT_BASE_URL` `AGENT_API_KEY`
`AGENT_MAX_TOKENS` (16k) `AGENT_MAX_TURNS` (50) `AGENT_CONTEXT_WINDOW`
`AGENT_COMPACT_RATIO` (0.8) `AGENT_COMPACT_RECENT_TOKENS` (20k)
`AGENT_MAX_TOOL_RESULT_CHARS` (30k) `AGENT_MAX_TOOL_CONCURRENCY` (8)
`AGENT_HOME` (`~/.agent` — sessions, user memory, user commands).

## Where to read next

`src/loop.ts`, then `../docs/Agent-Architecture-Handbook.pdf`, then
`../docs/BLUEPRINT.md` for the spec this implements and the list of everything
it deliberately leaves out.
