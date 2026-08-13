# agent-prereq — understanding how coding agents actually work

A study kit for learning the architecture of real, production coding agents — in
order to build a **lean, from-scratch agentic framework** (no langchain / autogen /
langgraph bloat). It clones five reference codebases, maps each against the same
8 dimensions, compares them side-by-side, distills an opinionated blueprint, and
ships a **working multi-provider coding agent** that implements it.

> Everything here is for **understanding patterns**. `repos/claude-code` is a
> leaked snapshot of Anthropic's proprietary code — study the *ideas*, don't paste
> its source into your own framework.

## What's here

```
repos/        # 5 shallow clones (read-only study material)
docs/         # the analysis (start here)
  Agent-Architecture-Handbook.pdf   # ★ the 64-page handbook (read this first)
  book/         # the handbook's chapter sources (00-frontmatter .. 17-lean-build)
  claude-code.md  opencode.md  openclaude.md  codex.md  goose.md   # per-repo maps
  comparison.md   # one big table: every dimension × every repo, with file:line cites
  BLUEPRINT.md    # the opinionated lean-framework spec + staged build order
prototype/    # lean-agent: the working agent the blueprint describes
              #   ~4.5k lines, zero dependencies, Anthropic + OpenAI + OpenRouter
              #   + any OpenAI-compatible endpoint; 69 tests that need no API key
build/        # the PDF renderer (render.py + venv) and build_pdf.sh
```

## The handbook (PDF)

`docs/Agent-Architecture-Handbook.pdf` is the main deliverable: a 64-page,
no-fluff technical handbook on how coding agents actually work, with pseudocode,
flows, end-to-end scenarios, and `file:line` citations into the cloned source. 17
chapters across 5 parts — the core loop, messages, tools, provider/streaming,
prompts, context/compaction (Part I); permissions/sandboxing, hooks, memory
(Part II); skills, slash commands, output styles, subagents, MCP (Part III);
sessions/persistence/todos/background (Part IV); end-to-end scenarios + the lean
build (Part V).

Regenerate it after editing any chapter in `docs/book/`:

```bash
bash build/build_pdf.sh    # stitches docs/book/*.md → docs/Agent-Architecture-Handbook.pdf
```

## The reference repos

| dir | repo | lang | why it's here |
|---|---|---|---|
| `repos/claude-code` | yasasbanukaofficial/claude-code | TS | leaked Claude Code — the canonical architecture (battle-tested loop ergonomics) |
| `repos/opencode` | sst/opencode | TS | cleanest modern open-source agent; best overall structure |
| `repos/openclaude` | Gitlawb/openclaude | TS | multi-provider fork of Claude Code (canonical-format-as-interface) |
| `repos/codex` | openai/codex | **Rust** | strongest security design (real OS sandbox via argv-rewrite/self-re-exec) |
| `repos/goose` | block/goose | **Rust** | MCP as the universal tool bus; dual message-visibility compaction |

**Note:** `openclaude` is **TypeScript**, not Rust (a common misconception) — it's
a multi-provider fork of Claude Code. The genuine Rust references are **codex** and
**goose**.

## The 5 headline findings

1. **Convergence.** Five independently-built agents land on the *same kernel*: a
   `while(true)` turn loop, a `{name, JSON-schema, call}` tool, a streaming
   provider call with tool-call extraction, threshold-triggered context
   compaction, and an allow/ask/deny gate. The other ~95% of each codebase is
   product surface.
2. **The exit signal is the absence of a tool-call block — NOT the provider's
   `stop_reason`** (4 of 5 repos explicitly distrust `stop_reason`). This is the
   single most load-bearing detail; `prototype/` implements exactly this, and
   `test/e2e.ts` checks it.
3. **Everything is a tool result.** Schema-validation failures, permission denials,
   and tool exceptions all get fed back to the model as `is_error` results — the
   loop has one happy path and no exception-driven control flow.
4. **The pairing invariant.** Every emitted `tool_use` must get a matching
   `tool_result` before the next model call, or the API 400s — back-fill a
   synthetic error result on any failure/abort path.
5. **Most of what these tools ship is optional.** See `docs/BLUEPRINT.md` §5
   "What to omit" — buddy/voice/dreams, telemetry, UIs/IDE bridges, the provider
   zoo, over-built permission/sandbox layers, cloud/enterprise/orchestration.

## Suggested reading order

1. **`prototype/src/loop.ts`** — the loop top-to-bottom; the ~40 lines that matter,
   with every design choice annotated with the chapter it comes from.
2. **`docs/claude-code.md`** — see that exact loop inside a production agent.
3. **`docs/opencode.md`** — the cleanest modern take; then **`docs/codex.md`** for
   the Rust/sandbox angle and **`docs/goose.md`** for MCP-native design.
4. **`docs/comparison.md`** — how all five solve each problem, side by side.
5. **`docs/BLUEPRINT.md`** — the spec for *your* framework + a v0→v3 build order,
   and (§7) exactly which parts of it `prototype/` implements.

## Run the agent

```bash
cd prototype
node agent.ts                       # interactive; with no API key: offline demo
node test/e2e.ts                    # 69 tests, no key, no network beyond loopback

export ANTHROPIC_API_KEY=sk-ant-... # or OPENAI_API_KEY / OPENROUTER_API_KEY
node agent.ts "why does test/foo.spec.ts fail?"
node agent.ts -m gpt-5 -p "summarize README.md"
node agent.ts --provider http://localhost:11434/v1 -m qwen2.5-coder   # local
```

Slash commands: `/help /clear /compact /resume /model /permissions /context
/cost /tools /memory /todos /status /init /reload /exit`, plus your own
markdown commands in `.agent/commands/`.

Needs **Node ≥ 22.6** (runs `.ts` directly via native type-stripping); developed
on Node 24. See `prototype/README.md` for the full option list and for what the
agent deliberately does *not* implement.

## Environment notes

- Built with: `git`, **Node 24**, `go`. No `cargo`/`rustc` or `bun` on this box —
  so codex/goose (Rust) and the Bun apps are **cloned and read, not built** (the
  deep-dive is source reading). `prototype/` runs on plain Node with no
  dependencies, and its test suite needs no API key.
- Repos are **shallow clones** (`--depth 1`). To get history for one:
  `git -C repos/<name> fetch --unshallow`.
