# 15. Sessions, Persistence, Todos & Background Tasks

A **session** is a persisted conversation you can stop, resume, and fork. The
kernel (loop + tools + provider) only needs an in-memory `Message[]`; everything
in this chapter is the runtime/product layer that gives that array durability, a
resume handle, a model-managed scratchpad (todos), and a way for long-running
shells to feed results back into the loop. All of it is *additive* — you can ship
a working agent with none of it.

## How it works

Four loosely-coupled mechanisms, all hanging off one identifier (the session id):

- **Persistence.** Every message/part is appended to durable storage as it is
  produced. Two shapes dominate: an append-only **JSONL rollout** (codex,
  openclaude, claude-code transcripts) and a **SQLite** table of messages
  (opencode, goose). JSONL is trivial to append and `tail`; SQLite gives you
  indexed queries, monotonic sequence ids, and transactional multi-row updates
  (todos) for free.
- **Resume.** Read the persisted records back into the loop's history. With
  JSONL you parse the file into items; with SQLite you `SELECT ... ORDER BY seq`.
  opencode goes furthest: it never holds a mutable conversation object at all and
  **reloads history from SQLite every turn**, so resume is the normal code path.
- **Fork.** Copy a transcript prefix into a *new* session id so you can branch
  without mutating the original. The only subtlety is identity: remap message
  ids/parent links (openclaude) or record a `forked_from_id` and truncate the
  rollout at a turn boundary (codex).
- **Todos & background tasks.** A `TodoWrite` tool that overwrites a per-session
  list is a steering scratchpad the model maintains for itself. A background task
  is a detached shell/subagent whose completion **enqueues a synthetic message**
  that the loop drains on its next turn — the re-notification is the whole trick.

### Flow

1. Session created with an id; storage opened (defer file creation until first
   write — codex precomputes the path and writes lazily).
2. Each turn appends new messages/parts (and a token/cost rollup) to storage.
3. `TodoWrite` calls replace the session's todo rows; the tool result nudges the
   model to keep using the list.
4. A tool may spawn a background job: the loop continues; the job runs detached.
5. On completion the job enqueues a `task-notification` (or writes a result part)
   keyed to the session; the loop picks it up as an attachment next turn.
6. Resume: reload persisted history (+ todos) into the loop. Fork: copy a prefix
   into a fresh id, rewriting identity.

```text
# Append-as-you-go persistence + resume + fork (storage-agnostic)
on each produced message m:
    storage.append(sessionID, m)           # JSONL line OR SQLite row(seq++)

resume(sessionID):
    history = storage.load(sessionID)      # parse JSONL  /  SELECT ORDER BY seq
    return runLoop(history)                 # same kernel, pre-seeded

fork(srcID, cutPoint) -> newID:
    items = storage.load(srcID)
    prefix = items[.. cutPoint]            # nth user msg / turn id / messageId
    newID = fresh()
    for it in prefix:
        storage.append(newID, remap_identity(it, src=srcID))  # new ids/links
    record(newID).forked_from = srcID
    return newID

# Background task re-notifies the loop instead of blocking it
spawn_bg(cmd): job = detach(cmd); return job.id          # loop keeps going
on job done:  queue.enqueue({sessionID, kind:"task-notification", text})
loop turn:    history += drain(queue).map(as_attachment)  # model sees result
```

## In the wild

| Repo | Storage | Resume / Fork | Todos |
|---|---|---|---|
| codex | JSONL rollout, bg writer | resume reopens; fork = meta ptr + truncate | (plan tool) |
| opencode | SQLite (Drizzle) | reload+rederive each turn | `todo` table, txn replace |
| openclaude | JSONL per session | parentUuid chain; fork remaps uuids | `appState`, rehydrated |
| claude-code | JSONL transcript | restore from log | `appState.todos` in-memory |
| goose | SQLite (sqlx) | `copy_session`; truncate from msg | (per-turn flags) |

- **codex rollout** is an append-only JSONL file written by a dedicated background
  Tokio task behind an `mpsc` channel, so the loop never blocks on disk
  (`codex-rs/rollout/src/recorder.rs:842`, writer `:1718`). It is created lazily
  (path precomputed, file opened on first `persist`, `recorder.rs:744`) and
  carries `forked_from_id`/`parent_thread_id` in its first `SessionMeta` line
  (`recorder.rs:85`). Resume reopens for append (`recorder.rs:813`); load parses
  each line into a `RolloutItem`, taking the first `SessionMeta` as canonical id
  (`recorder.rs:933`, `get_rollout_history` `:998`).
- **codex fork** is rollout truncation at a turn boundary:
  `truncate_rollout_after_turn_id` cuts after a persisted `TurnStarted`
  (`codex-rs/core/src/thread_rollout_truncation.rs:162`) or before the nth user
  message (`:136`); the child spawns with that history and a `forked_from_id`
  (`codex-rs/core/src/codex_delegate.rs:89`).
- **opencode** is the SQLite-source-of-truth design. `message`/`part`/`todo`
  tables (`packages/core/src/session/sql.ts:68,82,100`); history loads via
  `SessionHistory.load` (drop pre-compaction rows by latest compaction seq,
  `core/src/session/history.ts:66`); the loop **reloads every turn** and exits
  off rederived state, not a mutable object (`opencode/src/session/prompt.ts:1088`,
  exit `:1111`). Todos are a transactional delete-all-then-insert keyed by
  `(session_id, position)` (`core/src/session/todo.ts:32`).
- **openclaude** stores one JSONL file per session under `~/.claude/projects/<dir>/
  <id>.jsonl`; messages chain by `parentUuid`. Resume walks the chain from the
  leaf back to root (`src/entrypoints/sdk/sessions.ts:148`). **Fork** copies the
  prefix (optionally `upToMessageId`), generates a new session id, and **remaps
  every uuid + parentUuid**, stamping `forkedFrom` on each line
  (`sessions.ts:325`). Mutations like rename/tag are just appended JSONL entries
  (`:244`).
- **claude-code** persists a transcript too; on resume it rebuilds state from the
  log, including **scanning the transcript for the last `TodoWrite` block** to
  rehydrate the todo list (`src/utils/sessionRestore.ts:77,138`). Todos
  themselves live in `appState.todos` keyed by `agentId ?? sessionId`
  (`src/tools/TodoWriteTool/TodoWriteTool.ts:65`); completing the whole list
  clears it, and the tool result always re-injects "continue to use the todo
  list" (`:104`).
- **Background tasks (claude-code)** are the clearest re-notify pattern. A
  detached shell, on completion, calls `enqueuePendingNotification` with a
  `task-notification` payload at priority `later` (`src/utils/messageQueueManager.ts:142`,
  emitted from `src/tasks/LocalShellTask/LocalShellTask.tsx:166`). The loop drains
  the queue each turn and converts those commands into **attachment messages**
  appended after tool results (`src/query.ts:1570,1580`). `TaskOutputTool` lets the
  model pull a job's buffered stdout from disk on demand
  (`src/tools/TaskOutputTool/TaskOutputTool.tsx:208`).
- **Background tasks (opencode)** are a process-local registry of scoped Effect
  fibers with `start/wait/promote/cancel` and a `promoted` deferred
  (`packages/core/src/background-job.ts:120`); explicitly **not durable** (a
  restart loses live work, `:113`). A background subagent runs as a job and
  injects a synthetic result message when done (`opencode/src/session/prompt.ts:255`).
  Promotion of a queued input is tracked in SQLite via `admitted_seq`/`promoted_seq`
  (`core/src/session/sql.ts:140`, `core/src/session/input.ts:41`).

Divergences worth noting: JSONL (append, greppable, parse-to-resume) vs SQLite
(indexed, monotonic seq, transactional todos); fork-by-uuid-remap (openclaude) vs
fork-by-meta-pointer-and-truncate (codex); todos persisted in their own table
(opencode) vs todos as ephemeral app state rehydrated from the transcript
(claude-code); background jobs durable-via-DB-pointer (opencode inputs) vs purely
process-local (opencode jobs, claude-code shells).

## Scenario

A user runs a long task, backgrounds a test build, then resumes tomorrow
(claude-code-style transcript + queue):

1. Turn 5: model calls `TodoWrite` with 4 items, item 1 `in_progress`. The tool
   writes `appState.todos[sessionID]`, returns "Todos modified... continue to use
   the todo list"; the `tool_use`+`tool_result` pair is appended to the JSONL
   transcript like any other.
2. Turn 6: model runs `npm run build` with `run_in_background: true`. The shell
   detaches; the tool returns a `taskId`; the loop **does not block** and goes on
   to edit files in turns 7-9.
3. The build finishes during turn 9. `LocalShellTask` enqueues a
   `task-notification` (`<task-notification><task-id>…</task-id><status>completed
   </status>…`) at priority `later`.
4. Turn 10 begins: the loop drains the queue, wraps the notification as an
   attachment user message, and appends it after the tool results. The model now
   sees the build succeeded, calls `TaskOutput` to read the log, marks todo item 4
   `completed`, and (all items done) the list clears.
5. The user quits. Next day, `--resume <sessionID>` reads the transcript back into
   `Message[]`; `restoreSessionStateFromLog` scans backward for the last
   `TodoWrite` block and rehydrates `appState.todos`. The loop continues with full
   context and an accurate task list — no live state survived the restart, only the
   transcript did.

## Lean take

- **Persist append-only JSONL, one file per session.** One line per
  message/part, plus a header line with `{id, cwd, createdAt, forkedFrom?}`.
  Resume = read + parse. It is the lowest-effort durable format and you can `tail`
  and `grep` it. Reach for SQLite only when you need indexed listing or
  transactional todo rows.
- **Make resume the normal path, not a special case.** If you can afford it, copy
  opencode: reload history from storage at the top of each turn so cancel/resume/
  compaction are correct by construction. Otherwise, load-once-then-append is fine
  — just append *as you go*, never "save on exit" (crashes lose everything).
- **Fork = copy a prefix into a new id.** Cut at a user-message/turn boundary,
  give the new session a fresh id, and either remap message ids (if they're
  referenced) or just record `forked_from`. Don't deep-copy side state (file undo
  history, snapshots); start the fork clean.
- **Todos are one tool that overwrites a list + a nudge.** Schema is
  `[{content, status, activeForm}]`; the call replaces the whole list; the tool
  result says "keep using it." That single feedback string is what actually steers
  long tasks. Persisting todos is optional — rehydrating from the last `TodoWrite`
  in the transcript works fine.
- **Background tasks: re-notify, don't block.** Spawn detached, return an id
  immediately, and on completion **enqueue a synthetic message** the loop picks up
  next turn; expose a `TaskOutput`-style tool to pull buffered output on demand.
  Keep the registry process-local at first — durable background work (survive
  restart, remote workers) is a large separate effort; do not pretend an in-memory
  map has those semantics.
- **Skip for v1:** session search/pagination, archived/compressed rollouts,
  state-DB-plus-filesystem reconciliation (codex), input admit/promote sequencing,
  worktree/remote background sessions, and per-day transcript rotation.
