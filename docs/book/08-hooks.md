# 8. Hooks

Hooks are user-configured shell commands (or HTTP/LLM-prompt actions) that the
agent runtime fires at fixed lifecycle points — before/after a tool runs, when a
prompt is submitted, when the turn stops. They let a user *observe*, *block*, or
*modify* the agent's behavior without touching its code: a synchronous side
channel into the loop, governed by exit codes and JSON on stdout.

## How it works

A hook is matched by **event** (when it fires) and **matcher** (a sub-filter,
usually a tool-name pattern). On the event, the runtime serializes a JSON
*hook input* describing what is about to happen, spawns each matching command
with that JSON on **stdin**, and interprets the command's **exit code** and
**stdout** as a decision:

- **exit 0** — success. stdout may be JSON (a structured decision) or plain text
  (injected as context, depending on event).
- **exit 2** — blocking error. stderr is fed back to the model as the reason; the
  pending action is denied (PreToolUse) or the turn is forced to continue (Stop).
- **other non-zero** — non-blocking error; logged/shown, action proceeds.

For richer control the command can print a JSON object on stdout: `{"decision":
"block","reason":...}` or, per-event, `hookSpecificOutput` carrying a
`permissionDecision` (`allow`/`deny`/`ask`), an `updatedInput` (rewrite the tool
args), or `additionalContext` (text injected into the conversation). JSON
overrides the exit code. The two channels are equivalent for the common
deny-with-reason case; JSON exists for the modify/allow/ask cases that an exit
code can't express.

Config lives in `settings.json` keyed by event → array of `{matcher, hooks[]}`
groups; each hook is `{type:"command", command, timeout?, if?}` (claude-code also
has `prompt`/`agent`/`http` types). Multiple matched hooks run **in parallel**;
their results are aggregated, with any block winning.

### Flow (PreToolUse, the load-bearing case)

1. Model emits a `tool_use`. Before the permission gate, the runtime builds a
   `PreToolUse` hook input: `{hook_event_name, tool_name, tool_input,
   tool_use_id, session_id, cwd, ...}`.
2. It collects hooks registered for `PreToolUse` whose `matcher` (regex /
   pipe-list / `*`) matches `tool_name`, plus any `if:` rule filter.
3. Each command is spawned via the shell with the input JSON on stdin and a
   per-hook timeout.
4. Each result is parsed: exit 2 → block; stdout JSON → permission decision /
   `updatedInput` / `additionalContext`; else plain success.
5. Results aggregate. A `deny` short-circuits: the tool never runs; an error
   `tool_result` carrying the reason goes back to the model. `updatedInput`
   rewrites the args that reach `tool.call()`. `additionalContext` is appended.
6. If allowed, the normal permission gate and `tool.call()` proceed; afterward
   `PostToolUse` fires the same way (it can inject context or rewrite MCP output,
   but cannot un-run the tool).

```text
on PreToolUse(tool_name, tool_input, tool_use_id):
  hooks = matchingHooks("PreToolUse", tool_name)         # matcher + if-filter
  results = parallel(for h in hooks: spawn(h, stdin=JSON(input), timeout=h.t))
  agg = { behavior: "allow", updatedInput: tool_input }
  for r in results:                                       # any block wins
    if r.exit == 2:                       agg.behavior="deny"; agg.reason=r.stderr
    elif json := parse(r.stdout):
      if json.decision == "block":        agg.behavior="deny"; agg.reason=json.reason
      d = json.hookSpecificOutput
      if d.permissionDecision:            agg.behavior = d.permissionDecision
      if d.updatedInput:                  agg.updatedInput = d.updatedInput
      if d.additionalContext:             agg.contexts += d.additionalContext
  if agg.behavior == "deny":  return errorToolResult(agg.reason)   # tool skipped
  input = agg.updatedInput                                # feeds tool.call()
  proceed to permission gate -> tool.call()
```

## In the wild

claude-code and openclaude are the same codebase (openclaude line numbers differ;
they carry the full feature set). codex and goose are leaner Rust ports that adopt
the same wire protocol (exit-2 / `decision:block`).

| Aspect | claude-code / openclaude | codex (Rust) | goose (Rust) |
|---|---|---|---|
| Events | 27 (full set) | ~10 | 8 |
| Config | `settings.json` matchers | `hooks.toml` | plugin `hooks.json` |
| Action types | command/prompt/agent/http | command | command |
| Block channel | exit 2 + JSON | exit 2 + JSON | exit 2 + JSON |

- **Event set (claude-code):** `HOOK_EVENTS` lists 27 events incl. `PreToolUse`,
  `PostToolUse`, `PostToolUseFailure`, `UserPromptSubmit`, `Stop`, `StopFailure`,
  `SubagentStart`/`SubagentStop`, `Notification`, `PreCompact`/`PostCompact`,
  `SessionStart`/`SessionEnd`, `PermissionRequest`/`PermissionDenied`, `Setup`,
  `FileChanged`, `CwdChanged`, `WorktreeCreate`/`Remove` —
  `claude-code/src/entrypoints/sdk/coreTypes.ts:25`.
- **Config schema:** `HooksSchema` = partial record of event → `HookMatcher[]`,
  where `HookMatcher = {matcher?, hooks: HookCommand[]}` and the command hook is
  `{type:"command", command, if?, shell?, timeout?, ...}` —
  `claude-code/src/schemas/hooks.ts:194,211` (openclaude
  `src/schemas/hooks.ts:194,211`).
- **Spawn:** command hooks run via the shell with input JSON written to stdin and
  newline-terminated — `claude-code/src/utils/hooks.ts:977,1210` (openclaude
  `:1166,1203`). PowerShell uses an explicit argv path.
- **Matcher semantics:** `*`/empty = match all; `[a-zA-Z0-9_|]+` is exact or
  pipe-list; anything else is a regex — `claude-code/src/utils/hooks.ts:1346`.
  The `if:` field is permission-rule syntax (e.g. `Bash(git *)`) evaluated against
  tool input before spawning — `claude-code/src/schemas/hooks.ts:19`,
  `:1390` (`prepareIfConditionMatcher`).
- **Decision parsing:** exit 2 → `outcome:"blocking"` with stderr as reason
  (`claude-code/src/utils/hooks.ts:2648`); JSON `decision:"approve"|"block"` maps
  to allow/deny (`:525`); `hookSpecificOutput.permissionDecision` for PreToolUse
  maps allow/deny/ask and pulls `updatedInput`/`additionalContext` (`:593-622`).
- **Parallel + aggregate:** all matched hooks run via `all(hookPromises)`; results
  fold into one `AggregatedHookResult` — `claude-code/src/utils/hooks.ts:2143,2744`.
- **PreToolUse consumer:** the tool executor drains `runPreToolUseHooks`, applies
  `hookPermissionResult` and `hookUpdatedInput`, and on `stop` returns a
  tool-result error without calling the tool —
  `claude-code/src/services/tools/toolExecution.ts:800-862,921`.
- **Stop consumer:** when the model emits no tool_use, `handleStopHooks` runs; a
  blocking error rebuilds `State` with the reason appended and `continue`s the
  loop (forcing the agent to keep working) — `claude-code/src/query.ts:1267-1306`.
- **codex:** TOML config `HookEventsToml` with `MatcherGroup{matcher?, hooks[]}`
  and command handlers — `codex/codex-rs/config/src/hook_config.rs:36,133,143`;
  `PreToolUseHookResult::{Continue{updated_input}, Blocked(reason)}` mirrors the
  modify/deny split — `codex/codex-rs/core/src/hook_runtime.rs:55,198-216`.
- **goose:** plugin `hooks/hooks.json`, regex matcher, command actions;
  `HookManager::emit_blocking` returns `HookDecision::{Allow, Deny}` and
  `deny_reason` checks exit code 2 *or* `{"decision":"block"}` —
  `goose/crates/goose/src/hooks/mod.rs:50,224,364,429`. Non-blocking events use
  `emit`. Wired in `agents/agent.rs:1052-1066` (PreToolUse gate). Key divergence:
  goose stops at the **first** deny (`:377`), claude-code runs all and folds.

## Scenario

A user wants to forbid the agent from editing `.env` files. They add to
`settings.json`:

```json
{ "hooks": { "PreToolUse": [
  { "matcher": "Edit|Write",
    "hooks": [ { "type": "command",
                 "command": "jq -e '.tool_input.file_path|endswith(\".env\")' \
                             >/dev/null && { echo blocked >&2; exit 2; } || exit 0" } ] }
] } }
```

1. Model emits `Edit{file_path:".env", ...}`. Executor builds the `PreToolUse`
   input and matches `Edit` against `"Edit|Write"` → hit
   (`hooks.ts:1346`, pipe-list path).
2. The command spawns with the input JSON on stdin (`hooks.ts:977,1210`). `jq`
   sees `file_path` ends in `.env`, prints `blocked` to stderr, exits 2.
3. `execCommandHook` returns `status:2`; the result becomes
   `{outcome:"blocking", blockingError:{reason:"blocked"}}` (`hooks.ts:2648`).
4. Aggregation sets `permissionBehavior:"deny"`; `resolveHookPermissionDecision`
   yields a deny, the executor never calls `Edit`, and a `tool_result` error
   ("Edit hook error: blocked") returns to the model (`toolExecution.ts:921`).
5. The model reads the denial and routes around it (e.g. asks the user). Had the
   hook instead printed `{"hookSpecificOutput":{"hookEventName":"PreToolUse",
   "permissionDecision":"allow","updatedInput":{...}}}`, the executor would have
   rewritten the args and let the edit through.

## Lean take

- Ship three events first: **PreToolUse** (deny/modify — the only one that
  changes outcomes), **PostToolUse** (observe / inject context), and **Stop**
  (force-continue). UserPromptSubmit and SessionStart are cheap follow-ons.
- Adopt the **exit-2 + `{"decision":"block","reason"}`** protocol verbatim —
  goose does this in ~450 lines (`hooks/mod.rs`) and it interops with existing
  hook scripts. Pass the event payload as JSON on stdin; read stdout/exit.
- Config = `event -> [{matcher, hooks:[{command, timeout}]}]`. Matcher: treat `*`
  as all, a plain string / `A|B` as exact, else regex (`hooks.ts:1346`). Skip the
  permission-rule `if:` filter until you need it.
- Run matched hooks in parallel; **any block wins**; fold `updatedInput` and
  `additionalContext`. First-deny-wins (goose) is simpler and fine.
- Make hooks **fail-open**: spawn errors, timeouts, and non-2 exits must NOT block
  the agent (goose `:362`) — a broken hook should degrade, not brick the loop.
- Skip for v1: prompt/agent/http action types, async/background hooks, plugin/
  skill sourcing, workspace-trust gating, the 20+ niche events. All are product
  surface, not mechanism.
