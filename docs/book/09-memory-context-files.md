# 9. Memory & Context Files

Persistent project/user instructions the agent loads from disk on every turn —
`CLAUDE.md`, `AGENTS.md`, `.goosehints` — plus the directives that pull other
files inline. This is how an agent "remembers" your conventions across sessions
without any of it living in the model.

## How it works

A context file is a markdown file the agent discovers by walking the filesystem,
concatenates into one blob, and feeds the model every turn. Three independent
decisions define the mechanism:

- **Discovery hierarchy** — which files, in what precedence. Universally:
  *enterprise/managed* (machine-wide policy) < *user* (`~/.claude`, all projects)
  < *project* (checked-in, cwd walked up to root) < *local* (private, gitignored).
  Later = higher priority because the model weights later text more
  (claude-code `claudemd.ts:1-10`).
- **Embeds** — a file can pull in others. claude-code/openclaude use `@path`
  (`claudemd.ts:18-25`); goose uses the same `@path` token with an *import
  boundary* (`import_files.rs:9`). Both cap recursion depth and dedup by path.
- **Injection** — *where* the blob lands. Two camps: a leading
  **`<system-reminder>` user message** prepended to history (claude-code,
  openclaude, codex), versus a **system-prompt section** ("hints") baked into the
  system string (goose, opencode). User-message injection survives prompt-cache
  prefix reuse better and is easy to mark `isMeta`; system injection keeps it out
  of the transcript.

The discovery is a memoized directory walk. Files closer to cwd load *later*
(higher priority). `@`-includes are spliced *before* the including file so the
parent's text wins on conflict.

### Flow

1. Resolve roots: managed dir (`/etc/...`), user home (`~/.claude`), then
   collect every directory from cwd up to filesystem root.
2. For each root in priority order (managed → user → project root → … → cwd),
   try the known filenames (`CLAUDE.md`, `.claude/CLAUDE.md`, `.claude/rules/*.md`,
   `CLAUDE.local.md`). Skip already-seen paths.
3. For each file read: strip frontmatter/HTML comments, scan leaf text nodes for
   `@path` tokens, recurse into each (depth-capped, cycle-guarded), splice
   children before parent.
4. Tag each entry with its type (Managed/User/Project/Local) and render with a
   provenance label + the override instruction header.
5. Join into one string; inject as a leading user `<system-reminder>` (or a
   system-prompt section). Memoize the whole walk; bust the cache on
   `/memory` edit, compaction, or worktree change.

```text
discover(cwd):
  roots = [managed_dir, user_home]
  d = cwd; while d != fs_root: roots.push(d); d = parent(d)
  # project/local walk goes root -> cwd so nearer files load later (win)
  out = []; seen = {}
  for root in [managed, user] + reverse(roots_cwd_to_root):
    for name in filenames_for(root):           # CLAUDE.md, .claude/rules/*.md ...
      out += process(join(root, name), seen)
  return out

process(path, seen):
  if path in seen or depth > MAX: return []
  seen.add(path)
  raw = read(path) or return []
  body = strip_frontmatter(strip_html_comments(raw))
  children = []
  for inc in extract_at_includes(body):        # @path in leaf text nodes only
    children += process(resolve(inc, dir(path)), seen)   # spliced BEFORE parent
  return children + [{path, type, body}]
```

## In the wild

| Repo | Files / hierarchy | Injection point |
|---|---|---|
| claude-code | Managed/User/Project/Local + `.claude/rules/*.md` `claudemd.ts:1` | user `<system-reminder>` `api.ts:449,463` |
| openclaude | same 4 tiers + TeamMem/AutoMem `claudemd.ts:1177` | user `<system-reminder>` `api.ts:513` |
| codex | `AGENTS.md` root→cwd + `AGENTS.override.md` `agents_md.rs:13,39` | user item `<INSTRUCTIONS>` `user_instructions.rs:18` |
| goose | `.goosehints`/`AGENTS.md`/`CLAUDE.md`, global+local `load_hints.rs:10,46` | system-prompt `hints` extra `prompt_manager.rs:174` |
| opencode | `AGENTS.md`/`CLAUDE.md`, first match wins `instruction.ts:61,83` | system section, `Instructions from:` `instruction.ts:127` |

Divergences worth copying or avoiding:

- **claude-code is the richest hierarchy.** Six types (`Managed`, `User`,
  `Project`, `Local`, plus feature-gated `AutoMem`/`TeamMem`), each path resolved
  by `getMemoryPath` (`config.ts:1779`): `~/.claude/CLAUDE.md`,
  `<cwd>/CLAUDE.md`, `<cwd>/CLAUDE.local.md`, `<managed>/CLAUDE.md`. Project
  discovery walks cwd→root and loads root→cwd so nearer files win
  (`claudemd.ts:854,878`). The render labels provenance inline —
  `(project instructions, checked into the codebase)` vs
  `(user's private global instructions...)` (`claudemd.ts:1168`) — so the model
  knows whose rule it is.
- **`.claude/rules/*.md` with conditional globs.** Rule files carry frontmatter
  `paths:` globs; an unconditional rule loads always, a conditional one only
  when a tool touches a matching path (lazy, nested-directory load via
  `getMemoryFilesForNestedDirectory` `claudemd.ts:1249`, glob match
  `processConditionedMdRules:1354`). This is the closest thing to "subdir lazy
  load" in the TS repos.
- **`@`-include is a lexer pass, not a regex.** claude-code lexes markdown
  (`marked`) and only extracts `@path` from **text/list leaf nodes**, skipping
  code spans and fenced blocks (`claudemd.ts:452`). Accepts `@x`, `@./x`, `@~/x`,
  `@/abs`; depth cap 5 (`:537`); circular refs blocked by a `seen` set; external
  (outside-cwd) includes require explicit approval. Non-text extensions are
  rejected to keep binaries out of context.
- **codex caps total bytes and concatenates root→cwd.** It finds the project root
  by `.git` marker (`find_nearest_ancestor_with_markers`), concatenates every
  `AGENTS.md` from root down with a `--- project-doc ---` separator
  (`agents_md.rs:43,322`), and truncates at `project_doc_max_bytes`
  (`:89,115`). `AGENTS.override.md` is a local, gitignored override (`:39,224`).
- **goose is the only true lazy subdir loader.** Eager load is global
  (`~/.config/goose` + `~/.agents/AGENTS.md`) plus git-root→cwd
  (`load_hints.rs:54,89`). A `SubdirectoryHintTracker` then watches every tool's
  `path`/`command` args (`:42`), and on the next turn `load_new_hints` reads
  `.goosehints`/`AGENTS.md` from any **newly-touched subdir** under cwd and
  appends it as a `subdir_hints:<dir>` system extra (`:72,109`). Hints land in
  the system prompt, not the transcript (`prompt_manager.rs:174`).
- **opencode dedups hard: first project match wins.** It does not stack
  `AGENTS.md` from every ancestor — the first existing file up the tree ends the
  search (`instruction.ts:83-93`), plus one global file and config-listed extra
  paths/URLs, each rendered `Instructions from: <path>`.

The `/memory` editing command (claude-code `commands/memory/memory.tsx`) is a
thin file picker: it lists the discoverable memory paths, `mkdir -p`s the
`~/.claude` dir if needed, creates the file with `wx` (no-clobber), opens
`$EDITOR`/`$VISUAL` (`:42`), then **clears the memoize cache** so the next turn
re-reads (`call:83-89`). It is not a tool the model calls — it is human-driven.

**Persistent memory dirs** are a separate system from instruction files. Both
forks add a write-as-you-go store the *agent* maintains:

- claude-code/openclaude AutoMem: `~/.claude/memory/MEMORY.md` index + date-named
  daily logs + topic files (`memdir/paths.ts:85,93,257`), injected as an extra
  memory type, truncated to line+byte caps.
- openclaude SessionMemory: a background **forked subagent** periodically writes
  `<projectDir>/<sessionId>/session-memory/summary.md` of the live conversation
  (`SessionMemory/sessionMemory.ts:1`, path `filesystem.ts:289`) — non-blocking,
  per-session.
- openclaude TeamMem: `<base>/projects/<root>/memory/team/MEMORY.md`, synced
  across the org with a secret-scanner guard before write
  (`teamMemPaths.ts:92`, `teamMemorySync/`).

## Scenario

You run `claude` in `~/work/api/services/billing/`, a git repo rooted at
`~/work/api/`.

1. `getUserContext()` calls `getMemoryFiles()` (`context.ts:171`). The walk
   collects roots: managed dir, `~/.claude`, then `~/work/api`,
   `~/work/api/services`, `~/work/api/services/billing` (`claudemd.ts:854`).
2. It reads in priority order: `~/.claude/CLAUDE.md` ("use bun, be concise"),
   then root→cwd — `~/work/api/CLAUDE.md` ("monorepo: kebab-case routes"), then
   `~/work/api/services/billing/CLAUDE.md` ("this service owns Stripe webhooks").
   The billing file contains `@./CONVENTIONS.md`; the lexer finds the token in a
   list item (`:452`), resolves it, and splices `CONVENTIONS.md` *before* the
   billing file (`:664`).
3. Each entry is rendered `Contents of <path> (project instructions, checked into
   the codebase):\n\n<body>` and joined under the header `Codebase and user
   instructions are shown below... These instructions OVERRIDE any default
   behavior` (`:90,1194`).
4. `getClaudeMds` returns the blob into `userContext.claudeMd`
   (`context.ts:186`). On the model call, `prependUserContext` wraps it in a
   single leading `<system-reminder>` user message marked `isMeta`
   (`api.ts:449`) ahead of the real conversation.
5. The model now sees, before your first prompt: bun preference, monorepo
   conventions, the Stripe ownership note, and the spliced `CONVENTIONS.md` — the
   nearer billing rules visually last, so they win on any conflict.

## Lean take

- **Build the walk and one injection point.** cwd→root collection, load root→cwd
  so nearer wins, three tiers (user `~/.agent/AGENT.md`, project `AGENT.md`,
  local `AGENT.local.md`). Inject as a single leading user message with a
  "these override defaults; may be irrelevant" header. ~100 lines.
- **Add `@include` early — it pays for itself.** A regex over non-code text,
  resolve relative to the file's dir, a `seen` set, a depth cap of ~5. Skip the
  full markdown-lexer sophistication until users actually put `@x` inside code
  fences.
- **Memoize the walk; bust on edit.** One cache keyed on cwd; clear it when your
  `/memory` command writes a file or when you compact. Re-reading disk every turn
  is the bug, not the feature.
- **`/memory` is a file picker + `$EDITOR`, not a tool.** Don't let the model
  edit instruction files via a tool call; make it a human command that
  `mkdir -p`s, no-clobber-creates, opens the editor, and invalidates the cache.
- **Skip until needed:** managed/enterprise tier, conditional `rules/*.md` globs,
  team sync, and per-session auto-memory subagents. They are product surface, not
  mechanism. Adopt goose's lazy subdir reload (track tool path args, load that
  dir's hints next turn) *only* if your projects are large monorepos.
- **Pick injection by your cache strategy.** User-message injection if you cache
  the system-prompt prefix and want memory to vary per cwd without busting it;
  system-section injection (goose) if you want it out of the visible transcript.
