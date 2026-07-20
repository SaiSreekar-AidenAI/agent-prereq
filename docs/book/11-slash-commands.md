# 11. Slash & Custom Commands

Slash commands are the CLI's command palette: text that starts with `/` is
intercepted *before* the agent loop. Some are handled entirely client-side and
never reach the model (`/clear`, `/model`, `/compact`); others are user-authored
markdown files that **expand into a prompt** and are then injected as a user turn.
This chapter is about the two kinds and the expand-then-inject machinery.

## How it works

There are two command categories, and they share one dispatch table but diverge
at execution. A **local command** (`type: 'local'` / `'local-jsx'`) carries a
lazy `load()` returning a `call()` implementation; it runs in-process, mutates
session state or renders UI, and returns messages with `shouldQuery: false` so
the loop does not call the model (`claude-code/src/types/command.ts:62-152`,
dispatched at `processSlashCommand.tsx:657-669`). A **prompt command**
(`type: 'prompt'`) is the markdown kind: its `getPromptForCommand(args, ctx)`
returns content blocks, which are pushed as a user message with `shouldQuery:
true` — the model runs as if the user had typed the expanded text
(`command.ts:25-57`, `processSlashCommand.tsx:869-920`).

Markdown commands are discovered by walking `.claude/commands/` (and `skills/`)
from cwd up to the git root, plus the user dir `~/.claude/` and a managed/policy
dir; files are read with ripgrep `--files --glob '*.md'` and YAML frontmatter is
split off (`markdownConfigLoader.ts:234-289,546-600`). Each file becomes a
`PromptCommand`. The **command name** is the path relative to the base dir with
`/` turned into `:`, so `.claude/commands/git/commit.md` is `/git:commit` —
directory **namespacing** (`loadSkillsDir.ts:523-552`).

Frontmatter fields map onto the command: `description`, `argument-hint` (gray
hint in the picker), `allowed-tools` (extra tool grants for this command's turn),
`model` (override; `inherit` means parent model), `arguments` (named positionals),
plus `context: fork` to run as a sub-agent (`loadSkillsDir.ts:208-264`). The body
is the prompt template.

At invocation `getPromptForCommand` runs three substitution passes over the body,
in order: argument substitution, then `${CLAUDE_SKILL_DIR}`/`${CLAUDE_SESSION_ID}`
literals, then embedded shell execution (`loadSkillsDir.ts:344-398`). `@file`
mentions are *not* expanded here — they ride out as text and are turned into file
attachments downstream by the same `@`-mention attachment pass that handles normal
user input (`processSlashCommand.tsx:897`).

### Flow

1. Input starts with `/` → `parseSlashCommand` splits `commandName` and the rest
   as a single `args` string (`slashCommandParsing.ts:25-60`).
2. Look up the command in the merged table (built-ins + discovered markdown +
   plugin/MCP). Unknown → error.
3. If `type !== 'prompt'`: lazy-`load()` and `call()` it in-process; emit result
   messages with `shouldQuery: false`. **Done — model never invoked.**
4. If `type === 'prompt'`: call `getPromptForCommand(args, ctx)`:
   a. `substituteArguments`: replace `$name`, `$ARGUMENTS[i]`, `$i`, `$ARGUMENTS`;
      if no placeholder matched, append `ARGUMENTS: <args>`.
   b. replace `${CLAUDE_SKILL_DIR}` / `${CLAUDE_SESSION_ID}`.
   c. `executeShellCommandsInPrompt`: run `` !`cmd` `` and ```` ```! …``` ```` ,
      permission-checked, splice stdout in place.
5. Wrap the expanded text as a user message (plus a metadata tag message and a
   `command_permissions` attachment carrying `allowedTools`/`model`), set
   `shouldQuery: true`, hand to the loop.

```text
# argument substitution core (mirrors substituteArguments + apply_skill_arguments)
substitute(body, rawArgs, argNames):
    if rawArgs is null: return body                      # not invoked with args
    parts = shell_split(rawArgs)                          # quote-aware tokens
    for i, name in argNames:                              # $name -> parts[i]
        body = replace(body, /\$name\b/, parts[i] or "")
    body = replace(body, /\$ARGUMENTS\[(\d+)\]/, parts[idx] or "")
    body = replace(body, /\$(\d+)\b/,            parts[idx] or "")  # $1..$9
    body = replaceAll(body, "$ARGUMENTS", rawArgs)        # whole string, raw
    if nothing was replaced and rawArgs:                  # graceful fallback
        body = body + "\n\nARGUMENTS: " + rawArgs
    return body

# then, only for non-MCP (trusted) sources:
for match in body.matchAll(/!`([^`]+)`/) + /```!\n(.*?)```/:
    assert permission_allows(Bash, match.command)         # gate before exec
    body = body.replace(match, run_shell(match.command).stdout)
```

## In the wild

| Mechanism | claude-code / openclaude | opencode | goose / codex |
|---|---|---|---|
| Built-in (no model) | `type:'local'` w/ `load()` | TUI dispatch | enum match |
| Markdown source dir | `.claude/commands` | `command/`, `commands/` | `.agents/skills` |
| `$ARGUMENTS`/`$1` | yes | yes | yes (goose) |
| `` !`bash` `` embed | yes | yes | no |
| `@file` embed | downstream attach | `resolvePromptParts` | no |
| Namespacing | dir → `a:b` | path → name | flat |

Tight notes with anchors:

- **claude-code / openclaude** share the implementation verbatim.
  `substituteArguments` does named → `$ARGUMENTS[i]` → `$i` → `$ARGUMENTS`, then
  appends `ARGUMENTS:` if nothing matched (`argumentSubstitution.ts:94-145`;
  openclaude `argumentSubstitution.ts:124-141`). Shell embedding uses
  `` !`cmd` `` (inline) and ```` ```! ```` (block) regexes, each
  permission-checked against `BashTool` before running
  (`promptShellExecution.ts:49-143`; openclaude identical at `:53-110`). MCP
  skills are explicitly barred from shell execution as untrusted
  (`loadSkillsDir.ts:374-396`). openclaude's only real divergence is the `model`
  frontmatter resolving through a multi-provider `parseUserSpecifiedModel`
  (`openclaude/src/skills/loadSkillsDir.ts:222-225`).
- **opencode** loads `command/**/*.md` and `commands/**/*.md` via glob, frontmatter
  → config, body → `template` (`config/command.ts:12-39`). Expansion lives in the
  session: positional `$1..$N` (last placeholder absorbs the tail), then
  `$ARGUMENTS`, then `` !`…` `` shell, with `@file` turned into file message parts
  by `resolvePromptParts` (`session/prompt.ts:1371-1431`,
  regexes `:1591-1595`, `config/markdown.ts:5-6`). A `subtask`/agent command runs
  in a sub-session instead of inlining (`session/prompt.ts:1438-1450`).
- **goose** lists built-ins (`prompts`, `compact`, `clear`, `skills`, `doctor`,
  `goal`, `grind`, `status`) separately from disk-loaded skills, merging with
  builtin > recipe > skill precedence on normalized names
  (`slash_command.rs:30-53,68-72`). Its `apply_skill_arguments` is a faithful Rust
  port: one regex covers `$ARGUMENTS[i]`, `$ARGUMENTS`, `$pos`, `$name`, with the
  same no-placeholder `ARGUMENTS:` append (`skills/arguments.rs:6-52`). No
  shell/`@file` embedding.
- **codex** keeps built-ins as a `SlashCommand` enum dispatched in a `match`
  arm that handles `/clear`, `/compact`, `/model` locally
  (`tui/src/slash_command.rs:12-122`, `chatwidget/slash_dispatch.rs:233-271`).
  Custom prompts exist but argument handling is a TUI placeholder-fill, not a
  full `$ARGUMENTS`/bash/file engine — the leanest of the five.

## Scenario

A repo has `.claude/commands/git/fixup.md`:

```text
---
description: Stage and amend with a generated message
argument-hint: [scope]
allowed-tools: Bash(git add:*), Bash(git commit:*)
---
Current staged diff:
!`git diff --cached --stat`
Amend the last commit for scope "$1". Files touched: $ARGUMENTS
```

User types `/git:fixup auth login`.

1. `parseSlashCommand` → `{commandName:'git:fixup', args:'auth login'}`
   (`slashCommandParsing.ts:25`). The `:` came from the `git/` namespace at load
   (`loadSkillsDir.ts:545-552`).
2. Command is `type:'prompt'`; loop calls `getPromptForCommand('auth login', ctx)`.
3. `substituteArguments`: tokens `["auth","login"]`. `$1`→`auth`,
   `$ARGUMENTS`→`auth login` (`argumentSubstitution.ts:106-136`).
4. `executeShellCommandsInPrompt`: `` !`git diff --cached --stat` `` is
   permission-checked (allowed by the temporary `allowed-tools` grant) and
   replaced with the stat output (`promptShellExecution.ts:89-131`).
5. The expanded body is wrapped as a user message; a `command_permissions`
   attachment carries `Bash(git add:*)`/`Bash(git commit:*)` so the model's
   ensuing `git commit --amend` is auto-allowed for this turn; `shouldQuery:true`
   sends it (`processSlashCommand.tsx:902-916`). The model proceeds with the diff
   already in context.

Contrast: `/model` on the same CLI hits `type:'local-jsx'`, opens a picker, sets
the model in app state, and returns with `shouldQuery:false` — no API call.

## Lean take

- Build one dispatch table keyed by name. Tag each command "client" or "prompt".
  Client commands run a function and return; prompt commands expand and get
  injected as a user turn. This single split is the whole feature.
- Make markdown commands the default extension point: a directory of `*.md`,
  frontmatter for `description`/`model`/`allowed-tools`, body as template. Name =
  relative path with `/`→`:` for free namespacing. Skip a plugin system at first.
- Implement substitution in one pass with the documented precedence (named → `$i`
  → `$ARGUMENTS`) and the no-placeholder `ARGUMENTS:` append — it is what makes
  zero-placeholder commands still receive their args. Use a quote-aware splitter
  for `$1..$9`.
- `` !`bash` `` embedding is high-value and cheap, but **gate every embedded
  command through your permission check** and **never run shell from untrusted
  (remote/MCP) command sources** — that is the one security-load-bearing rule.
- Reuse your existing `@file` attachment path rather than special-casing it in the
  expander; the expanded text is just user input.
- Skip for v1: forked/subtask execution, `context:fork`, conditional `paths`
  activation, inode dedup, worktree fallbacks, per-turn `allowed-tools` grants.
  Add the tool-grant attachment only once permissions actually bite.
