# 7. Permissions, Approval & Sandboxing

The approval gate is the function that runs *before* every side-effecting
`tool.call()` and returns `allow | ask | deny`. It is the agent's one chance to
stop a destructive action before it happens, to ask a human, or to refuse — and a
denial must feed back to the model as a result, never abort the turn. OS
sandboxing is a separate, optional layer underneath it.

## How it works

The gate sits between "the model asked to run tool X with input Y" and "the side
effect happens". Two design questions define it:

1. **Where do the rules live, and how do they combine?** Two families. A
**fixed-precedence pipeline** runs a hardcoded sequence of checks (deny rules →
ask rules → the tool's own `checkPermissions` → a bypass-immune safety floor →
the permission *mode*), first decisive result wins (claude-code
`permissions.ts:1071`, `:1158`). An **ordered rule list** is flatter: one list of
`{permission, pattern, action}`, **last wildcard match wins**, default `ask`
(opencode `permission/index.ts:28`). The pipeline is more rigid but bakes in a
safety floor; the rule list is tiny and composable.

2. **Who owns tool-specific logic?** A general gate can't know that
`git status` is safe but `rm -rf` is not. So a tool exposes its own
`checkPermissions(input)` that the gate calls. For `bash` this means parsing the
command into sub-commands and deciding per sub-command (claude-code splits the AST
and combines results; opencode tree-sitter-parses and asks per real sub-command,
`shell.ts:257`).

Three invariants every repo shares: **the gate runs before the side effect**; a
**deny becomes an `is_error` tool result fed back to the model**, not an exception
that kills the turn (claude-code `toolExecution.ts:1034`, codex `parallel.rs:76`);
and a **safety floor** for the agent's own config (`.git/`, `.claude/`, shell rc
files) prompts even when the user has turned all prompting off.

### Flow

1. Model emits `tool_use {id, name, input}`; the loop validates `input` against
   the tool schema (schema failure is itself an `is_error` result, not a gate
   call).
2. Gate checks **deny** first — an explicit deny rule short-circuits to `deny`.
3. Gate checks **ask** rules and the **tool's `checkPermissions`** (e.g. bash
   per-sub-command allow/ask/deny).
4. Gate checks the **safety floor**: writes to protected paths force `ask` even
   under bypass.
5. Gate applies the **permission mode** (default / acceptEdits / bypass / plan):
   mode can only *relax* toward allow for things the floor didn't catch.
6. Result: `allow` → run the tool; `ask` → block for a human (a persistent
   "always" answer appends a new allow rule); `deny`/rejection → synthesize an
   `is_error` tool result and **continue the loop**.
7. (Optional) If allowed and the tool shells out, run it inside an OS sandbox.

```text
function decide(tool, input, ctx) -> allow | ask | deny:
    # ---- fixed-precedence pipeline (claude-code permissions.ts:1071) ----
    if denyRuleFor(tool, input):              return deny     # 1. explicit deny wins
    if askRuleFor(tool):                      return ask      # 2. blanket ask rule
    r = tool.checkPermissions?(input)         # 3. tool owns its risk logic
    if r == deny:                             return deny     #    (bash sub-cmd denied)
    if r == ask and r.fromExplicitRule:       return ask      #    content ask rule
    if isProtectedPath(input):                return ask      # 4. SAFETY FLOOR (immune)
    if ctx.mode in (bypass, planWithBypass):  return allow    # 5. mode can relax
    if alwaysAllowRuleFor(tool, input):       return allow
    return (r == passthrough) ? ask : r       # default: ask

# ---- alternative: ordered rule list, last-match-wins (opencode index.ts:28) ----
function evaluate(permission, pattern, rules) -> rule:
    return rules.flat()
                .findLast(r => match(permission, r.permission)
                          and match(pattern, r.pattern))
           ?? { action: "ask" }               # default ask if nothing matches

# ---- the gate's contract at the call site (claude-code toolExecution.ts:1034) ----
d = decide(tool, input, ctx)
if d == ask:   d = await ctx.askUser(tool, input)   # "always" -> append allow rule
if d == deny:  return toolResult(id, "denied", isError=true)   # FEED BACK, no abort
out = tool.call(input, ctx)                         # the only path to a side effect
```

## In the wild

Two rule models, an orthogonal sandbox axis, and a universal "deny is a result"
rule.

| Repo | Rule model | Safety floor / sandbox |
|---|---|---|
| claude-code | fixed precedence `permissions.ts:1071` | bypass-immune paths; bwrap/Seatbelt |
| openclaude | same precedence + `fullAccess` `permissions.ts:1089` | bypass-immune paths; bwrap |
| opencode | ordered list, last-match-wins `index.ts:28` | none (ask-only) |
| codex | two gates: execpolicy + mode `safety.rs:32` | real OS sandbox `manager.rs:60` |
| goose | inspector pipeline `agent.rs:629` | none default; opt-in container |

- **claude-code / openclaude — fixed precedence + bypass-immune floor.**
  `checkRuleBasedPermissions` runs deny → ask → `tool.checkPermissions` → safety,
  and is the *subset bypass mode respects* (`permissions.ts:1071`, openclaude
  `:1089`). The safety floor is concrete: `DANGEROUS_FILES`
  (`.gitconfig`, `.bashrc`, `.claude.json`, …) and `DANGEROUS_DIRECTORIES`
  (`.git`, `.vscode`, `.claude`) in `filesystem.ts:57,74`, enforced by
  `checkPathSafetyForAutoEdit` (`filesystem.ts:620`) which returns a `safetyCheck`
  decision that survives even `bypassPermissions` mode (`permissions.ts:1255`).
  Modes: `default`/`acceptEdits`/`bypassPermissions`/`plan` (`types/permissions.ts:17`);
  openclaude adds `fullAccess`.
- **opencode — ordered list, last-match-wins.** `evaluate` flattens all rulesets
  and takes the *last* matching wildcard rule, default `ask` (`index.ts:28`).
  `ask` blocks on a `Deferred`; a `"always"` reply appends `{action:"allow"}`
  rules at runtime and auto-resolves other pending asks now covered
  (`index.ts:145`). No safety floor, no OS sandbox — gating is purely
  ask-before-side-effect.
- **codex — two orthogonal gates.** *Whether to run* = execpolicy rule engine +
  `AskForApproval` mode (`Never`/`OnRequest`/`UnlessTrusted`/`Granular`) →
  `SafetyCheck::{AutoApprove, AskUser, Reject}` (`safety.rs:20,32`). *How to run
  safely* = pick an OS sandbox: `get_platform_sandbox` returns Seatbelt (macOS) /
  LinuxSeccomp / WindowsRestrictedToken (`manager.rs:60`), and `transform`
  **rewrites the argv** — prepending the `sandbox-exec` binary on macOS
  (`manager.rs:379`) or re-exec'ing the Codex binary as a Landlock+seccomp helper
  on Linux (`manager.rs:406`). Enforcement needs no in-process trust.
- **goose — inspector pipeline + annotation-driven SmartApprove.** An ordered list
  of `ToolInspector`s (Security → Egress → Adversary → Permission → Repetition,
  `agent.rs:629-646`) each returns Allow/Deny/RequireApproval. The
  `PermissionInspector` keys off `GooseMode` (Chat/Auto/Approve/SmartApprove,
  `goose_mode.rs:24`): in SmartApprove a tool's `read_only_hint` annotation
  auto-allows it, and unknown tools are classified by an LLM read-only detector
  (`permission_inspector.rs:159,171`). Reads auto-allow, writes gate, zero
  per-tool config.

**Deny → result, never abort** is unanimous. claude-code builds a `tool_result`
with `is_error:true` and pushes it as a user message (`toolExecution.ts:1034`),
openclaude the same (`:1147`), opencode throws `Rejected`/`Corrected` that becomes
the tool result, codex maps every non-`Fatal` error (including
`RespondToModel`) to a `failure_response` tool result and only `Fatal` aborts
(`parallel.rs:75-76`), goose emits a placeholder tool response on `Deny`.

## Scenario

Bypass mode is on; the model calls `bash` with
`cat README.md && rm -rf .git`.

```text
input  = { command: "cat README.md && rm -rf .git" }   ; mode = bypassPermissions
1. schema validates -> ok
2. bash.checkPermissions parses the AST into sub-commands:
     "cat README.md"  -> known-safe read    -> allow
     "rm -rf .git"    -> matches Bash(rm:*)? no rule -> passthrough
                       -> ".git" hits DANGEROUS_DIRECTORIES (filesystem.ts:74)
                       -> checkPathSafetyForAutoEdit -> safetyCheck (filesystem.ts:620)
3. combine: any sub-command not 'allow' downgrades the whole call
     -> decisionReason.type == 'safetyCheck'  (permissions.ts:1147)
4. mode check: bypassPermissions would allow... BUT step 4 ran BEFORE step 5,
   and safetyCheck is bypass-immune -> stays 'ask'         (permissions.ts:1255)
5. gate result = ask -> human prompted "rm -rf .git — approve?"
6a. human rejects -> tool_result(is_error=true, "Permission denied") (toolExecution.ts:1034)
    -> appended as user message; loop CONTINUES; model sees the denial and adapts.
```

The key beat: even with *all prompting disabled*, the write to `.git` still
prompts, because the safety floor is checked before the mode that would have
waved it through.

## Lean take

- **Start with opencode's model: one ordered `{permission, pattern, action}` list,
  last-match-wins, default `ask`** (`index.ts:28`). It is ~10 lines, composes by
  concatenation, and "always" is just appending an allow rule. Skip a
  fixed-precedence pipeline until you actually need a bypass mode.
- **Give each tool a `checkPermissions(input)` hook** so risky tools own their
  logic. For `bash`, split on `&&`/`|`/`;` and prefix-match each segment against
  allow/deny lists; deny if any segment denies, ask if any is unknown. Tree-sitter
  (opencode `shell.ts:257`) is nicer but a regex split covers the 90% case.
- **Add a bypass-immune safety floor** as a hardcoded check: writes to `.git/`,
  your agent's own config dir, and shell rc files always `ask`, regardless of mode
  (claude-code `filesystem.ts:57,74`). This is the single highest-value safety
  feature and costs a dozen lines.
- **Auto-allow read-only tools** via an `isReadOnly` flag so reads never prompt
  (goose SmartApprove `permission_inspector.rs:159`).
- **Make deny a result, not an abort** — synthesize an `is_error` tool_result and
  continue the loop (claude-code `toolExecution.ts:1034`, codex `parallel.rs:76`).
  Same for schema-validation and tool exceptions. One happy path, no
  exception-driven control flow.
- **Treat OS sandboxing as a separable, later layer.** opencode and goose ship
  with none and are useful. If you add one, copy codex's argv-rewrite approach
  (`manager.rs:379,406`) so enforcement needs no in-process trust — but ship the
  ask-before-side-effect gate first.
