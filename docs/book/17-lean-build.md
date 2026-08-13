# 17. The Lean Build

You have seen every component. This closing chapter is the opinionated assembly
order: the minimal kernel, what to deliberately omit, and a staged path from a
50-line toy to a real agent. It condenses `docs/BLUEPRINT.md`; every recommendation
traces to a repo studied in this book.

## The minimal kernel

Six components do the real work. The last two are deferrable.

| Component | Contract | Chapter |
|---|---|---|
| Agent loop | turn loop; exit on no `tool_use` | 1 |
| Message list | ordered `Message[]`, pairing invariant | 2 |
| Tool + registry | `{name, schema, call, isReadOnly}` + a flat list | 3 |
| Provider client | `stream(system, msgs, tools) -> events` | 4 |
| Context manager | token estimate + compaction at threshold | 6 |
| Approval gate | `decide(tool, input) -> allow/ask/deny` | 7 |
| MCP client | adapt external tools into the registry (later) | 14 |
| Subagents | recurse the loop with a child context (later) | 13 |

Everything in this book outside that table is optional. Build the six, keep one
provider seam, and add nothing speculatively.

## What to omit (and why)

These are real features in the five repos that a lean framework should **not** build
up front. Each is a product or scale concern, not part of the kernel.

### Product / personality
- Companion/Tamagotchi, proactive "keep-going" nudges, voice/STT, ads (openclaude,
  goose) — persona and input-modality, irrelevant to doing work; nudges actively
  fight the clean "stop on no tools" rule.

### Telemetry / business
- Analytics, OTel, feature-flag gating, cost tracking, LLM session-titling (all
  repos) — observability is additive; don't thread it through the loop on day one.

### UI / surfaces
- The entire TUI (claude-code's `main.tsx` is hundreds of KB), desktop/Electron, web
  console, IDE bridges, and ~25–40 per-tool React renderers — your loop should emit
  *events*; a UI consumes them separately. Keep tools to `{schema, call}`.

### Provider / context over-engineering
- A 12-provider zoo, gateway registries, dual SDK+hand-rolled parsers, 5-layer
  compaction, server cache-editing, WebSocket transport with HTTP fallback — ship
  one provider and one good summary pass; add a translator seam only for provider #2.

### Permissions / safety over-engineering
- Four permission modes, LLM security/egress classifiers, repetition inspectors,
  three OS sandbox backends, a network MITM proxy — start with one ordered rule list
  + read-only auto-allow + a bypass-immune safety floor; sandboxing can come later.

### Orchestration / cloud / enterprise
- Coordinator swarms, peer-session orchestrators, role registries, gRPC/MCP server
  modes, remote/background sessions, SQLite persistence, snapshot/revert, an
  Effect/DI runtime, a plugin hook bus — one level of "subagent = recurse the loop"
  is the 95% case; plain async + an in-memory `Message[]` is enough to be correct.

## Self-extension: the harness that rewrites itself

Omitting features is only safe if they are cheap to add back. The pi.dev insight is
to make the harness **extensible by the agent itself**: expose tools (and commands)
as small code modules in an `extensions/` directory, load them at startup, and give
the agent a `reload_extensions` tool. Because the agent already has `write` + `edit`,
it can author a new tool on demand and load it mid-session — *"if a capability does
not exist, you ask the agent to build it."* This is the whole of "self-building": it
is not self-improving AI, just code-writing plus hot-reload.

### Flow

1. At startup, scan `extensions/`, import each module, let it register tools onto the
   registry (which is already just a list, Ch. 3).
2. Rebuild the tool array **every turn**, so a newly-registered tool shows up in the
   next model call.
3. Expose `reload_extensions` as a built-in. When the agent writes a new extension
   file, it calls reload and the tool becomes usable immediately.

```text
# an extension is a module that adds tools; the agent can write one itself
register(pi):
    pi.addTool({ name, description, inputSchema, run })

loadExtensions(dir):
    for file in dir/*.ts:
        mod = import(file + "?v=" + now)      # cache-bust the URL => hot reload
        mod.register(api)                      # api.addTool(...) collects tools
    return tools

# in the loop, rebuilt per turn:
tools = [ ...builtins, reloadTool, ...loadExtensions(dir) ]
```

The caveat pi makes explicit: it ships **no permission system** and trusts a
sandbox/container instead. If an agent can write and load its own tools, keep the
approval gate (Ch. 7) or run the whole thing sandboxed — self-extension widens the
blast radius of a bad instruction. The reference implementation in `prototype/`
takes the first option: `src/extensions.ts` is the loader, `reload_extensions` is
the built-in, and an extension tool goes through the same gate as a built-in, with
`buildTool`'s fail-closed default treating a tool that forgets to declare
`readOnly` as a writer. Watch it happen, offline:

```bash
cd prototype && node agent.ts --mock --yes "build a shout extension and use it"
```

## Staged build order

Each stage is independently runnable and testable. Do not skip ahead.

### v0 — Loop + 3 tools (no streaming, no approval)
- The `while(true)` loop with the **no-`tool_use` exit test** (Ch. 1).
- `Message[]` in memory; the pairing invariant with back-fill on failure (Ch. 2).
- Tool interface with fail-closed defaults; implement `read`, `write`, `bash` (Ch. 3).
- One non-streaming provider call behind an injectable seam so it is testable
  without the network (Ch. 4).
- System prompt = identity + tool list + cwd; memory file injected as a leading user
  message (Ch. 5, 9).
- Done when: the agent can read a file, edit it, run a command, and stop.

### v1 — Streaming + approval gate
- Streaming client: SSE parse, accumulate blocks by index, assemble tool-call JSON at
  block close, emit an internal event union; retry with backoff (Ch. 4).
- Approval gate: ordered last-match-wins rules, default ask, "always" appends a rule,
  deny -> `is_error` result; auto-allow read-only tools; safety floor for
  `.git`/config (Ch. 7).
- Parallelize consecutive read-only tools; serialize writers (Ch. 1, 3).
- Done when: output streams, risky writes prompt, reads run concurrently.

### v2 — Context compaction
- Token estimate (byte heuristic) + threshold check at the top of the loop;
  one summarization pass -> rebuild `[init]+[recent]+[summary]`; mark old turns
  invisible; tool-result cap + disk spill; in-loop recovery on a real
  context-length error (Ch. 6).
- Done when: a long session compacts automatically and keeps going, and the full
  transcript is still recoverable.

### v3 — Extensibility
- MCP client (stdio first): adapt remote tools into your registry, indistinguishable
  from built-ins (Ch. 14).
- Subagents: recurse the same loop with a child context, filtered tools, and a step
  limit; return the child's final text as the parent's tool result (Ch. 13).
- Then, only as the product demands: skills (Ch. 10), custom commands (Ch. 11),
  hooks (Ch. 8), and a persistence interface for sessions (Ch. 15).
- Done when: the agent can call an external MCP server and delegate a scoped subtask
  — with zero new machinery in the loop.

## The reference implementation

Everything above is buildable in one sitting, and `prototype/` in this repo is
that build: ~4,500 lines of dependency-free TypeScript, no framework, running on
plain Node. It is not pseudocode — it streams from Anthropic, OpenAI, OpenRouter,
or any OpenAI-compatible endpoint, and its 69-test suite runs with no API key by
pointing the same binary at a local server that speaks both wire formats.

Each module is one chapter, so the book and the code can be read against each
other:

| Chapter | File | What it is |
|---|---|---|
| 1, 13 | `src/loop.ts` | the loop, tool execution, subagents |
| 2 | `src/types.ts` | canonical blocks, dual visibility, pairing back-fill |
| 3 | `src/tools.ts` | tool interface, ten built-ins, cap-and-spill |
| 4 | `src/providers.ts`, `src/config.ts`, `src/mock.ts` | two SSE clients, one event union, provider resolution |
| 5 | `src/prompt.ts` | cacheable prefix + dynamic suffix, reminders |
| 6 | `src/context.ts` | estimate, threshold, summarize-and-rebuild |
| 7 | `src/permissions.ts` | rule list, modes, safety floor |
| 9 | `src/memory.ts` | `AGENTS.md` discovery, tiers, `@includes` |
| 11 | `src/commands.ts` | client + markdown prompt commands |
| 15 | `src/session.ts` | JSONL persistence, resume, fork |
| 17 | `src/extensions.ts` | the self-extension loader |

Four chapters are implemented **nowhere**, on purpose, and their absence is the
argument of this one: MCP (Ch. 14), hooks (Ch. 8), skills (Ch. 10), and output
styles (Ch. 12). Each has an obvious seam waiting for it — MCP tools merge
through `mergeTools`, hooks wrap the single `runOne` call site, a UI consumes
`TurnHooks` instead of `ui.ts` — which is the point: a kernel with clean seams
lets you defer, and deferring is cheap only when the seam already exists.

Three things that emerged from actually running it, which pseudocode hides:

- **Compaction needs a floor, not just a ceiling.** On a small context window the
  system prompt and tool schemas alone can cross the threshold, so a naive
  proactive check compacts an empty transcript, burns a model call, makes the
  request *larger*, and does it again next turn. Gate the check on having
  something to summarize.
- **A non-interactive run must refuse, not block.** `--print` has nobody to answer
  a prompt, so an `ask` that awaits stdin hangs forever. Non-interactive mode has
  to turn `ask` into a denial the model can read and route around.
- **The exit test has a twin in the tool loop.** "One result per call, in the
  order asked" is not free once calls run in parallel batches: collect into a map
  keyed by `tool_use_id` and re-emit in the original order.

## The disagreements you must resolve

The repos do **not** agree on everything; pick a side deliberately:

- **History:** resend full history each turn (codex) vs. slide a window after a
  compaction boundary (claude-code). Lean default: in-memory window.
- **Loop state:** mutable object reassigned per turn (claude-code) vs. re-derive from
  a persisted store each turn (opencode). Lean default: mutable in-memory.
- **Permissions:** fixed precedence (claude-code) vs. ordered last-match-wins rules
  (opencode). Lean default: last-match-wins — simpler and more powerful.
- **Sandbox:** real OS sandbox (codex) vs. ask-before-side-effect only (opencode,
  goose). Lean default: ask-only to start; add a sandbox when you run untrusted code.
- **Streaming:** hand-rolled SSE (codex, goose, claude-code) vs. a vendor SDK
  (opencode). Lean default: hand-roll one provider so you understand it.

The one point of near-unanimous agreement, and the most important line of code in
the whole system: **exit the loop when the assistant emits no tool calls — never
trust `stop_reason`.**
