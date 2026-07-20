# 13. Subagents & Orchestration

A subagent is not a new runtime. It is the *same* agent loop invoked recursively
with a child context: its own message list, a filtered tool set, and a step/budget
limit. The parent calls it through a normal tool (`Task`/`Agent`), the child runs
to completion, and the child's final text becomes the parent's `tool_result`. This
buys context isolation (the child's exploration never pollutes the parent window)
at the cost of one recursion level — which is the 95% case.

## How it works

The mechanism has four moving parts. First, a **tool** the model can call (`Task`
or `Agent`) whose input is a free-text `prompt` plus a `subagent_type`. Second, an
**agent definition** selected by that type — a `name`/`description`/`tools`/`model`
record, usually parsed from a Markdown file's YAML frontmatter. Third, a **child
context**: a cloned-but-isolated execution context with its own `agentId`, abort
controller, and a tool pool filtered to what the definition allows. Fourth, the
**same loop** (`query()` / `reply()`) run over the child's messages until it stops,
with its final assistant text captured and returned upward.

Isolation matters most for the *window*, not the *machinery*. The child gets a
fresh `Message[]` seeded only with its task prompt and system prompt; it burns its
own tokens reading files and running tools; the parent sees only the summary. A
step or turn limit caps the child so a runaway exploration cannot hang the parent —
when the limit is hit, the loop strips tools and forces a final text answer rather
than aborting.

Critically, the child's tool set usually **excludes the subagent tool itself**, so
subagents cannot spawn subagents. That one exclusion is what keeps "orchestration"
from metastasizing into unbounded recursion.

### Flow

1. Model emits `tool_use` for `Task` with `{ subagent_type, prompt, description }`.
2. Tool resolves the `AgentDefinition` for `subagent_type` (built-in or from
   `.claude/agents/*.md`); error back to the model if unknown.
3. Build a child context: new `agentId`, fresh abort controller, tool pool filtered
   by the definition's allow/deny lists (and minus the subagent tool).
4. Seed child `Message[]` with the task prompt; pick system prompt + model from the
   definition (or inherit).
5. Run the *same loop* over the child context until no `tool_use` (or step/turn
   limit hit -> strip tools -> force final answer).
6. Capture the child's last assistant text; return it as the parent's
   `tool_result`. Discard the child's intermediate messages.

```text
parent loop                          child = SAME loop, isolated context
-----------                          ----------------------------------
model -> tool_use(Task, prompt) ──┐
                                  ▼
                          resolve AgentDefinition(subagent_type)
                          ctx_child = clone(ctx_parent) but:
                            messages = [user(prompt)]      # fresh window
                            tools    = filter(allTools, def) - [Task]
                            agentId  = new(); abort = new()
                            model    = def.model ?? inherit
                                  ▼
                          for msg in run_loop(ctx_child, stepLimit):
                              record(msg)                   # NOT in parent window
                          final_text = last_assistant_text(child)
                                  ▼
parent.tool_result(tool_use_id) = final_text   ◀── only this crosses back
parent loop continues
```

## In the wild

All five repos converge on "recurse the loop"; they differ only in what the child
context is made of and how the result is harvested.

| Repo | Subagent = | Child context | Result |
|---|---|---|---|
| claude-code | recurse `query()` | `createSubagentContext` + filtered tools | last text -> `tool_result` |
| openclaude | recurse `query()` | same + `agentStepLimit` | last text -> `tool_result` |
| opencode | child `Session` | `parentID` + derived perms | last text part |
| codex | fork child thread | filtered rollout + TOML role | inter-agent message |
| goose | new `Agent` | recipe + filtered extensions | extracted text |

- **claude-code**: `AgentTool.call()` selects an `AgentDefinition`, builds an
  isolated context via `createSubagentContext`
  (`runAgent.ts:700`), then runs `for await (... query({ ... toolUseContext,
  maxTurns }))` (`runAgent.ts:748`). Tools are filtered by
  `resolveAgentTools` / `filterToolsForAgent` against the definition's `tools` and
  `disallowedTools` (`agentToolUtils.ts:122,70`). The `Agent` tool is in
  `ALL_AGENT_DISALLOWED_TOOLS` by default (`constants/tools.ts:41`) — so the child
  cannot recurse. The final-text-as-`tool_result` mapping is
  `mapToolResultToToolResultBlockParam` (`AgentTool.tsx:1340-1373`).
- **openclaude**: identical shape (`runAgent.ts:800`), plus an explicit
  `agentStepLimit`: once `stepsUsed >= maxSteps` it sets `summaryRequested`, which
  makes the next request send an empty tool list (`query.ts:1004`), forcing a
  textual wrap-up instead of more tool calls (`query.ts:1957-2003`,
  `query/agentStepLimit.ts:1`).
- **opencode**: the `Task` tool creates a *child Session* with
  `parentID: ctx.sessionID` (`task.ts:145`), runs the normal `ops.prompt(...)` loop
  (`task.ts:188`), and returns the last text part (`task.ts:199`). Permissions are
  derived per-subagent via `deriveSubagentSessionPermission`.
- **codex**: `spawn_agent` forks a child *thread* (`agent/control/spawn.rs:89`)
  whose rollout is filtered by `keep_forked_rollout_item` — it keeps
  system/developer/user messages and only `FinalAnswer` assistant messages, drops
  tool calls/reasoning (`spawn.rs:34-68`). A child's identity comes from a **TOML
  role** layered onto the config (model, provider, prompt) via
  `apply_role_to_config` (`agent/role.rs:56`). The subagent tool surface is
  `spawn_agent` / wait (`tools/handlers/multi_agents_v2/spawn.rs:27`).
- **goose**: `run_subagent_task` builds a fresh `Agent::with_config`, sets its
  provider/model, adds only the recipe's extensions, renders a dedicated
  `subagent_system.md` carrying `max_turns` + the visible tool list, calls
  `agent.reply(...)` (the same loop), and `extract_response_text` returns the last
  message (or all text) (`subagent_handler.rs:48,122,233,65`).

Divergence to note: claude-code/openclaude/goose seed a *fresh* window;
codex *forks* the parent's history (filtered) so the child sees prior final
answers. opencode is the outlier in modeling a subagent as a first-class
persisted `Session` rather than an ephemeral context.

## Scenario

Parent is asked "find every call site of `parseConfig` and tell me which ones
ignore the return value." The parent doesn't want 40 file reads in its own window.

1. Parent emits `tool_use` Task `{ subagent_type: "explore", prompt: "List call
   sites of parseConfig; flag ones that discard the result", description: "scan" }`.
2. `AgentTool.call()` resolves the `explore` definition (read-only `tools`: Grep,
   Read; `model: inherit`), builds a child context with those two tools only —
   `Agent`, `Write`, `Bash` are filtered out (`agentToolUtils.ts:122`;
   `constants/tools.ts:41`).
3. The child loop runs: greps for `parseConfig`, reads ~12 files, reasons about
   each. All 12 reads + intermediate reasoning live in the *child* window. After,
   say, 18 tool steps it nears its step limit; openclaude's path would now send an
   empty tool list (`query.ts:1004`) to force the summary.
4. Child's final assistant text: "9 call sites. 2 ignore the return:
   `init.ts:40`, `cli.ts:88`." That string is captured (`runAgent.ts:748` loop ->
   last text).
5. Parent receives one `tool_result` with those ~3 lines (`AgentTool.tsx:1347`),
   never the 12 file bodies. Parent answers the user from a near-empty delta to its
   context window.

Net effect: the parent spent ~200 tokens of context to get the distilled result of
a ~15k-token investigation.

## Lean take

- **Build exactly one thing: a `task` tool that recurses your own loop.** New
  `Message[]` seeded with the prompt, a tool pool filtered by an allow-list, a step
  cap, return the last assistant text. That is the entire feature
  (claude-code `runAgent.ts:748`; opencode `task.ts:188`).
- **Make the agent definition a Markdown file with YAML frontmatter**
  (`name`, `description`, `tools`, `model`) — parse it into your existing tool/model
  config. No bespoke registry, no DSL (schema: `loadAgentsDir.ts:73-98`).
- **Exclude the task tool from the child's tools.** One line; it caps recursion at
  one level and kills the whole class of swarm pathologies
  (`constants/tools.ts:41`).
- **Enforce a step/turn limit by stripping tools at the cap**, not by throwing.
  Forcing a final text answer always returns something usable to the parent
  (openclaude `query.ts:1004`).
- **Skip coordinators, swarms, peer-session orchestrators, role registries, and
  background/remote/worktree variants.** They are product surface, not the
  mechanism; codex's multi-agent-v2 and claude-code's coordinator mode are both
  feature-gated and inessential. Add them only when a real workload proves one
  level of recursion is insufficient — it rarely is.
