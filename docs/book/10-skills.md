# 10. Skills

A skill is an on-demand, model-invoked instruction bundle: a folder with a
`SKILL.md` (YAML frontmatter + markdown body) and optional scripts/reference
files. The point is **progressive disclosure** — only the skill's name and
one-line description sit in context up-front; the heavy body loads only when the
model decides to use it, so a hundred skills cost a few hundred tokens, not the
whole context window.

## How it works

A skill folder is `<root>/skills/<skill-name>/SKILL.md`. The frontmatter carries
metadata; the body is the prompt that gets injected on invocation:

```text
---
name: pdf                       # optional display name (dir name is the default)
description: Extract and fill PDF forms   # the ALWAYS-in-context hint
when_to_use: when the user has a PDF...    # optional extra match signal
allowed-tools: Bash, Read, Write           # tool scoping for the skill turn
disable-model-invocation: false            # if true, only a human can run it
context: inline                            # "inline" | "fork" (subagent)
model: sonnet                              # optional per-skill model override
---
<markdown body — workflow steps, references to ./scripts/foo.py, etc.>
```

Discovery runs at startup: walk a fixed set of roots (managed/policy, user,
project, `--add-dir`), read each `<dir>/SKILL.md`, parse frontmatter, and build a
lightweight `Command` record. The body is read into memory but **never sent**
until invocation — at startup only `name + description (+ when_to_use)` are
estimated for token cost. The full set of metadata is then formatted into a
single budgeted listing and injected as a `<system-reminder>` user message:
"The following skills are available for use with the Skill tool: …". That
listing is the up-front half of progressive disclosure.

When the model wants a skill it calls the `Skill` tool with `{skill, args}`. The
tool validates the name, runs the permission gate, then loads the body: it reads
the SKILL.md, prepends `Base directory for this skill: <dir>`, substitutes
`$ARGUMENTS` / `${CLAUDE_SKILL_DIR}` / `${CLAUDE_SESSION_ID}`, runs any inline
shell (`!`...``) blocks, and returns the expanded text as **new user messages**
appended to the conversation. The model reads those next turn and follows the
instructions. That is the on-demand half.

### Flow

1. **Startup discovery.** Walk skill roots; for each `<name>/SKILL.md`, parse
   frontmatter into a `Command` (name, description, allowed-tools, context,
   model, body-in-memory). Dedup by canonical path (realpath) so symlinks /
   overlapping roots don't double-list.
2. **Up-front listing.** Each turn, diff loaded skills against an already-sent
   set; format the *new* ones as `- name: description` within a ~1% char budget;
   inject as a `skill_listing` system-reminder. Body excluded.
3. **Model selects.** Seeing the listing + the `Skill` tool description, the
   model emits `tool_use{ Skill, {skill:"pdf", args:"form.pdf"} }`.
4. **Validate + gate.** Tool checks the name exists, isn't
   `disable-model-invocation`, then evaluates deny/allow rules → ask the user if
   unknown.
5. **Load body.** Read SKILL.md, prepend base-dir header, expand
   args/vars/inline-shell. Apply `allowed-tools` scoping for the skill's turn.
6. **Inject + continue.** Return the expanded body as new user messages (inline)
   or run it in a forked subagent (`context: fork`) and return its result. The
   loop iterates; the model now has the full instructions.

```text
# Pseudocode: discovery + progressive disclosure + invocation

# --- at startup (once) ---
skills = {}
for root in [managed, user, project, *addDirs]:
  for dir in listdir(root/"skills"):
    fm, body = parse_frontmatter(read(dir/"SKILL.md"))
    skills[dir.name] = Skill(name=dir.name, desc=fm.description,
                             allowed_tools=fm["allowed-tools"], body=body,
                             ctx=fm.context, base_dir=dir)   # body kept, NOT sent

# --- each turn, before calling the model ---
new = [s for s in skills.values() if s.name not in sent]
if new:                                   # only names+descriptions, budget-capped
  listing = "\n".join(f"- {s.name}: {s.desc}" for s in fit_budget(new))
  messages.append(system_reminder(f"Skills available:\n{listing}"))
  sent |= {s.name for s in new}

# --- Skill tool .call({skill, args}) ---
s = skills[skill]
if s.disable_model_invocation: return error("not model-invocable")
if not permit("Skill", skill): return ask_or_deny
text = f"Base directory for this skill: {s.base_dir}\n\n{s.body}"
text = expand(text, args, CLAUDE_SKILL_DIR=s.base_dir, SESSION_ID=sid)
text = run_inline_shell(text)             # !`...` blocks, with allowed_tools scope
return { new_messages: [user(text)],      # inline: body enters context now
         context_modifier: scope_tools(s.allowed_tools) }
```

## In the wild

The Claude-Code lineage (`claude-code`, `openclaude`) implements skills as an
explicit `Skill` tool that injects the body inline. Codex has **no skill tool**:
it lists skills in a developer message and instructs the model to *read the
SKILL.md path itself* with its file tools. Opencode has a `skill` tool that
returns the body wrapped in `<skill_content>` tags.

| Concern | claude-code / openclaude | codex / opencode |
|---|---|---|
| Invocation | `Skill` tool, body injected | codex: read path; opencode: `skill` tool |
| Up-front cost | `name + desc` listing | name + desc + path/locator |
| Body load | new user messages | codex: model `Read`s file |
| Scoping | `allowed-tools` per turn | opencode: permission per skill |

- **Format / frontmatter.** Fields parsed in
  `claude-code/src/skills/loadSkillsDir.ts:185` (`parseSkillFrontmatterFields`):
  `description`, `name`, `allowed-tools`, `when_to_use`, `model`,
  `disable-model-invocation`, `user-invocable`, `context`, `agent`, `effort`,
  `paths`, `hooks`. Codex frontmatter is just `name`/`description`
  (`codex/.codex/skills/code-review/SKILL.md:1`); opencode adds `slash`
  (`opencode/packages/core/src/skill.ts:33`).
- **Discovery / dir layout.** Only `skill-name/SKILL.md` directory form is
  accepted (`claude-code/src/skills/loadSkillsDir.ts:407`), roots walked in
  `getSkillDirCommands` (`:638`), deduped by `realpath`
  (`getFileIdentity`, `:118`). Opencode globs `{*.md,**/SKILL.md}`
  (`opencode/packages/core/src/skill.ts:79`). Codex loads via its own
  `SkillsService` (`codex/codex-rs/core/src/skills.rs:17`).
- **Progressive disclosure — the listing.** Built by
  `formatCommandsWithinBudget` and capped at ~1% of the context window in chars,
  per-entry `MAX_LISTING_DESC_CHARS = 250`
  (`claude-code/src/tools/SkillTool/prompt.ts:21,29,70`). Injected as a
  `skill_listing` attachment (`src/utils/attachments.ts:2661`,
  `:2741`) rendered to "The following skills are available…"
  (`src/utils/messages.ts:3728`). Token estimate uses frontmatter only
  (`estimateSkillFrontmatterTokens`, `loadSkillsDir.ts:100`). Codex uses a 2%
  budget (`codex/codex-rs/core-skills/src/render.rs:19`) with an explicit
  truncation warning when it overflows (`:24`).
- **The Skill tool.** `claude-code/src/tools/SkillTool/SkillTool.ts:331`,
  input `{skill, args}` (`:291`), tool name `"Skill"`
  (`SkillTool/constants.ts:1`). Tool description tells the model the listing
  lives in system-reminders and invocation is a "BLOCKING REQUIREMENT"
  (`SkillTool/prompt.ts:173-195`). Openclaude is identical
  (`openclaude/src/tools/SkillTool/SkillTool.ts:331`).
- **Body load + substitution.** `createSkillCommand.getPromptForCommand`
  prepends the base-dir header, substitutes `$ARGUMENTS` / `${CLAUDE_SKILL_DIR}`
  / `${CLAUDE_SESSION_ID}`, then runs inline shell — except for MCP skills,
  which are untrusted and skip shell execution
  (`claude-code/src/skills/loadSkillsDir.ts:344-398`).
- **allowed-tools scoping.** On inline invocation, `call()` returns a
  `contextModifier` that merges the skill's `allowedTools` into
  `alwaysAllowRules` for that turn
  (`claude-code/src/tools/SkillTool/SkillTool.ts:775-806`). Opencode asserts a
  per-skill permission before loading (`opencode/.../tool/skill.ts:76`).
- **Permission default.** Unknown skills default to `ask`; skills with only
  "safe" frontmatter properties auto-allow (`SAFE_SKILL_PROPERTIES`,
  `SkillTool.ts:529-538,875`); deny/allow rules support `name` and `prefix:*`
  matching (`ruleMatches`, `:451`).
- **Inline vs fork.** `context: 'fork'` runs the skill as an isolated subagent
  with its own token budget via `runAgent`
  (`claude-code/src/tools/SkillTool/SkillTool.ts:122,622`); `inline` (default)
  injects into the main conversation.
- **Dynamic / conditional discovery.** claude-code re-scans nested
  `.claude/skills` dirs as files are touched (`discoverSkillDirsForPaths`,
  `loadSkillsDir.ts:861`) and activates `paths:`-gated skills only when a
  matching file is edited (`activateConditionalSkillsForPaths`, `:997`).
- **MCP / remote skills.** Skills can come from MCP servers (`skill://` URIs,
  `openclaude/src/skills/mcpSkills.ts:14`) or remote stores; codex exposes
  `skills.list`/`skills.read` for orchestrator-owned skills
  (`codex/.../core-skills/src/render.rs:30`); opencode downloads a remote
  `index.json` + files into a cache dir (`.../skill/discovery.ts:99`).

## Scenario

A repo has `.claude/skills/pdf/SKILL.md` with frontmatter
`description: Fill and extract PDF forms`, `allowed-tools: Bash, Read, Write`,
and a body that references `./scripts/fill.py`.

1. **Startup.** `getSkillDirCommands` reads the file, parses frontmatter into a
   `Command{name:"pdf", description:"Fill and extract PDF forms", allowedTools:
   ["Bash","Read","Write"], body:<…>}`. The body (~3K tokens) stays in memory.
2. **Turn 1.** Before the model call, `getSkillListingAttachments` sees `pdf`
   is unsent, formats `- pdf: Fill and extract PDF forms` (~12 tokens), and
   injects it as a system-reminder. Cost in context so far: ~12 tokens, not 3K.
3. **User:** "fill out form.pdf with my address." The model matches the listing,
   emits `tool_use{ Skill, {skill:"pdf", args:"form.pdf"} }`.
4. **Gate.** `checkPermissions` finds no deny rule; `pdf` has only safe
   properties → auto-allow.
5. **Load.** `call()` runs `getPromptForCommand("form.pdf")`: prepends
   `Base directory for this skill: /repo/.claude/skills/pdf`, substitutes
   `$ARGUMENTS → form.pdf` and `${CLAUDE_SKILL_DIR}`, and returns the expanded
   body as a new user message. `contextModifier` scopes the turn's tools to
   `Bash/Read/Write`.
6. **Result.** Next iteration the model sees the full workflow, runs
   `Bash python ${CLAUDE_SKILL_DIR}/scripts/fill.py form.pdf`, and completes —
   the 3K-token body entered context only for this task.

## Lean take

- **Build the folder + frontmatter + a `Skill` tool, nothing else.** Discovery
  = "glob `*/SKILL.md`, parse YAML, keep body in memory." Up-front = "inject
  `- name: desc` lines as a system message." Invocation = "tool reads the
  matching body and appends it as a user message." That is the entire mechanism.
- **Keep the body out of context until invoked.** This is the whole value — if
  you inline every skill body you have re-invented a bloated system prompt. A
  char/token budget on the listing is enough; skip the 1%/2% tuning.
- **Two cheap substitutions earn their keep:** a `Base directory:` header (so the
  body can point at `./scripts/*`) and `$ARGUMENTS`. Add `${SKILL_DIR}` only if
  your bodies shell out.
- **Scope tools per skill** via `allowed-tools` — one line, real safety, and it
  lets a skill grant `Bash(python:*)` for its turn without a global allow.
- **Default unknown skills to `ask`**, support `name` and `prefix:*` allow rules,
  and never run inline shell from remote/MCP skill bodies.
- **Skip for v1:** forked-subagent execution, conditional `paths:` activation,
  dynamic nested-dir re-scan, remote/MCP skill stores, per-skill model/effort
  overrides, and the resume-dedup bookkeeping. All are refinements on top of the
  three-line core.
