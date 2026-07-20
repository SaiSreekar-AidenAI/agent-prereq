# 12. Output Styles

An output style is a swappable block of system-prompt text that changes the
agent's persona and response behavior (e.g. `default` vs `Explanatory` vs
`Learning`). The user picks one; it is injected near the top of the system prompt
and can optionally *replace* the default coding instructions. It is a Claude-Code
feature only — codex, goose, and opencode have no equivalent.

## How it works

A style is a `{ name, description, prompt, source, keepCodingInstructions }`
record (`claude-code/src/constants/outputStyles.ts:11-23`). Two built-ins ship in
code — `Explanatory` and `Learning` — and `default` is the sentinel `null`
(`outputStyles.ts:41-42`). Users add more as markdown files; each file's body
becomes `prompt`, its YAML frontmatter supplies `name` / `description` /
`keep-coding-instructions` (`src/outputStyles/loadOutputStylesDir.ts:34-78`).

The selected style is just a string in `settings.json` (`outputStyle`,
`src/utils/settings/types.ts:639-642`). At prompt-build time `getOutputStyleConfig()`
resolves that string against the merged style map and returns the config or `null`
(`outputStyles.ts:206-211`). The system-prompt assembler then does two things:
it injects the style body as a `# Output Style: <name>` section, and — this is the
load-bearing part — it *drops the default "doing tasks" coding instructions*
unless the style sets `keepCodingInstructions` (`prompts.ts:560-563`). So a style
can either augment the base prompt (both built-ins keep instructions) or wholly
override the agent's behavioral contract.

The intro line also flexes: with a style active the agent is told it helps users
"according to your Output Style below" instead of "with software engineering
tasks" (`prompts.ts:174` / `prompts.ts:180`).

### Flow

1. User sets `outputStyle: "Explanatory"` in settings (via `/config`; the
   `/output-style` slash command is now a deprecation stub —
   `src/commands/output-style/output-style.tsx:3`).
2. On each system-prompt build, `getAllOutputStyles(cwd)` merges built-ins +
   plugin + managed + user + project markdown styles, last-writer-wins
   (`outputStyles.ts:137-175`).
3. `getOutputStyleConfig()` reads `settings.outputStyle`, returns the matching
   config (or `null` for `default` / unknown) (`outputStyles.ts:206-211`).
4. Assembler injects `getOutputStyleSection(cfg)` into the dynamic section list
   and conditionally includes the default coding instructions
   (`prompts.ts:501-502`, `prompts.ts:560-563`).
5. Result is the full system prompt sent to the model that turn.

```text
resolve:  name = settings.outputStyle  (default if unset)
          cfg  = allStyles[name]        (null => "default")

assemble system prompt:
  intro    = cfg ? "helps ... according to your Output Style"
                 : "helps ... with software engineering tasks"
  + system section (always)
  + DEFAULT_CODING_INSTRUCTIONS  ONLY IF cfg==null OR cfg.keepCoding==true
  + actions / tools / tone sections (always)
  + ...dynamic sections...
       "# Output Style: <name>\n<cfg.prompt>"   (omitted when cfg==null)
```

## In the wild

| Repo | Output styles? | Mechanism |
|------|----------------|-----------|
| claude-code | Yes | prompt section + instruction override |
| openclaude | Yes (identical) | same code, line-for-line |
| codex / goose / opencode | No | no persona-swap concept |

- claude-code and openclaude are byte-identical here: same `OutputStyleConfig`
  type, same two built-ins, same loader, same injection
  (`openclaude/src/constants/outputStyles.ts:11-216`,
  `openclaude/src/constants/prompts.ts:145-152`, `:556-563`).
- Built-in styles: `Explanatory` (educational insights) and `Learning`
  (asks the user to hand-write `TODO(human)` snippets); both set
  `keepCodingInstructions: true` so they layer on top of the base prompt
  (`outputStyles.ts:43-134`).
- Storage / precedence: `.claude/output-styles/*.md`, loaded user-dir then
  project-dirs then managed/policy, with built-in lowest and project/managed
  highest (`outputStyles.ts:158-172`,
  `src/utils/markdownConfigLoader.ts:303-378`). Plugins may even *force* a style
  via `force-for-plugin` frontmatter (`outputStyles.ts:181-204`).
- The active style name is echoed into the `system_init` event for the
  status line / SDK (`src/utils/messages/systemInit.ts:55`, `:75`).
- Divergence: there is no runtime hot-swap — `getAllOutputStyles` is `memoize`d
  and changes "take effect on the next session" per the deprecation message
  (`outputStyles.ts:137`, `output-style.tsx:3`).

## Scenario

User has `~/.claude/output-styles/blunt.md`:

```text
---
name: Blunt
description: Terse, no preamble
keep-coding-instructions: false
---
You answer in at most three sentences. No filler, no apologies.
```

They set `outputStyle: "Blunt"` and restart. On the next turn:

1. `getOutputStyleConfig()` returns `{ name: "Blunt", prompt: "You answer...",
   keepCodingInstructions: false, source: "userSettings" }`.
2. Intro renders "helps users according to your Output Style below"
   (`prompts.ts:174`).
3. Because `keepCodingInstructions === false`, the entire
   `getSimpleDoingTasksSection()` block — read-before-edit, no-gold-plating,
   security guidance — is **omitted** (`prompts.ts:560-563`).
4. A `# Output Style: Blunt` section carrying the body is appended in the dynamic
   region (`prompts.ts:501-502`, `:150-151`).
5. The model now operates under the terse contract with the default coding
   doctrine stripped out; tool schemas and the always-on system/tools sections
   are unchanged.

## Lean take

- Model a style as `{ name, prompt, replace?: bool }`. The whole feature is "pick
  a string, look up a record, splice it into the prompt." Build it in an
  afternoon.
- The one non-obvious bit worth copying: a `replace` flag that lets a style
  *delete* your default behavioral instructions, not just append. Append-only is
  the trivial 80%; full override is what makes a style a true persona.
- Store styles as markdown-with-frontmatter under a config dir and key the
  selection off one settings field. Skip plugin sources, forced styles, managed
  precedence, and per-turn re-resolution — read once at session start.
- Keep it distinct from your other prompt inputs: memory (CLAUDE.md) is
  always-on project context injected as a user-side reminder; skills are
  on-demand tool-triggered instructions; an output style is a single,
  user-chosen, session-wide persona that can rewrite the base prompt.
- Don't bother with a dedicated slash-command UI; a config field plus
  "applies next session" is enough and avoids cache-busting the prompt prefix
  mid-session.
