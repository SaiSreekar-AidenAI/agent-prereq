# agent-prereq — understanding how coding agents actually work

A study kit for learning the architecture of real, production coding agents — in
order to build a **lean, from-scratch agentic framework** (no langchain / autogen /
langgraph bloat). It clones five reference codebases, maps each against the same
8 dimensions, compares them side-by-side, distills an opinionated blueprint, and
ships a tiny runnable agent that embodies the distilled core.

> Everything here is for **understanding patterns**. `repos/claude-code` is a
> leaked snapshot of Anthropic's proprietary code — study the *ideas*, don't paste
> its source into your own framework.

## What's here

```
repos/        # 5 shallow clones (read-only study material)
docs/         # the analysis (start here)
  Agent-Architecture-Handbook.pdf   # ★ the 61-page handbook (read this first)
  book/         # the handbook's chapter sources (00-frontmatter .. 17-lean-build)
  claude-code.md  opencode.md  openclaude.md  codex.md  goose.md   # per-repo maps
  comparison.md   # one big table: every dimension × every repo, with file:line cites
  BLUEPRINT.md    # the opinionated lean-framework spec + staged build order
prototype/    # a small runnable agent (4 tools + self-extension) that IS the distilled core
build/        # the PDF renderer (render.py + venv) and build_pdf.sh
```

## The handbook (PDF)

`docs/Agent-Architecture-Handbook.pdf` is the main deliverable: a 61-page,
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
   single most load-bearing detail; the prototype implements exactly this.
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

1. **`prototype/agent.ts`** — read the loop top-to-bottom (15 lines that matter).
2. **`docs/claude-code.md`** — see that exact loop inside a production agent.
3. **`docs/opencode.md`** — the cleanest modern take; then **`docs/codex.md`** for
   the Rust/sandbox angle and **`docs/goose.md`** for MCP-native design.
4. **`docs/comparison.md`** — how all five solve each problem, side by side.
5. **`docs/BLUEPRINT.md`** — the spec for *your* framework + a v0→v3 build order.

## Run the prototype

```bash
cd prototype
node agent.ts "list the files here"                 # MOCK mode — no API key needed
export ANTHROPIC_API_KEY=sk-ant-...                 # real multi-step agent
node agent.ts "read package.json and summarize it"
```

Needs **Node 24** (runs `.ts` directly via native type-stripping). See
`prototype/README.md` for options (`ANTHROPIC_MODEL`, `--yes`, the approval gate).

## Environment notes

- Built with: `git`, **Node 24**, `go`. No `cargo`/`rustc` or `bun` on this box —
  so codex/goose (Rust) and the Bun apps are **cloned and read, not built** (the
  deep-dive is source reading). The prototype runs on plain Node.
- Repos are **shallow clones** (`--depth 1`). To get history for one:
  `git -C repos/<name> fetch --unshallow`.
