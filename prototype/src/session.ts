// session.ts — SESSIONS & PERSISTENCE (Ch. 15).
//
// Append-only JSONL, one file per session, under
// `~/.agent/sessions/<project-slug>/<id>.jsonl`.
//
// The chapter's lean take, implemented literally: one line per record, a header
// line carrying `{id, cwd, createdAt, forkedFrom?}`, resume = read + parse, and
// append AS YOU GO — never "save on exit", because a crash then loses
// everything. Fork copies a prefix into a fresh id.
//
// The kernel does not need any of this; it is the runtime layer that gives the
// in-memory `Message[]` durability and a resume handle.

import { appendFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Message } from "./types.ts";
import type { TodoItem } from "./tools.ts";
import { agentHome } from "./config.ts";

/** Lazy: AGENT_HOME may be set after this module is imported. */
function root(): string {
  return join(agentHome(), "sessions");
}

export interface SessionMeta {
  type: "session";
  id: string;
  cwd: string;
  createdAt: string;
  provider: string;
  model: string;
  title?: string;
  forkedFrom?: string;
}

type Record_ =
  | SessionMeta
  | { type: "message"; message: Message }
  | { type: "todos"; todos: TodoItem[] }
  | { type: "title"; title: string };

function slug(cwd: string): string {
  return resolve(cwd).replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "root";
}

function dirFor(cwd: string): string {
  return join(root(), slug(cwd));
}

export class SessionStore {
  readonly meta: SessionMeta;
  readonly file: string;
  #queue: Promise<void> = Promise.resolve();
  #disabled = false;

  private constructor(meta: SessionMeta, file: string) {
    this.meta = meta;
    this.file = file;
  }

  static async create(opts: { cwd: string; provider: string; model: string; forkedFrom?: string; id?: string }): Promise<SessionStore> {
    const meta: SessionMeta = {
      type: "session",
      id: opts.id ?? randomUUID(),
      cwd: resolve(opts.cwd),
      createdAt: new Date().toISOString(),
      provider: opts.provider,
      model: opts.model,
      forkedFrom: opts.forkedFrom,
    };
    const dir = dirFor(opts.cwd);
    const store = new SessionStore(meta, join(dir, `${meta.id}.jsonl`));
    // Lazily created: the directory and header are written on the first append,
    // so listing sessions never shows empty shells (codex does the same).
    return store;
  }

  #append(record: Record_): void {
    if (this.#disabled) return;
    this.#queue = this.#queue
      .then(async () => {
        if (!existsSync(this.file)) {
          await mkdir(dirFor(this.meta.cwd), { recursive: true });
          await writeFile(this.file, JSON.stringify(this.meta) + "\n", "utf8");
        }
        await appendFile(this.file, JSON.stringify(record) + "\n", "utf8");
      })
      .catch(() => {
        // Persistence is additive: if the disk is unwritable the agent keeps
        // working in memory rather than dying. Report once, then stay quiet.
        if (!this.#disabled) {
          this.#disabled = true;
          process.stderr.write(`\n(warning: session persistence disabled — could not write ${this.file})\n`);
        }
      });
  }

  addMessage(message: Message): void {
    this.#append({ type: "message", message });
    if (!this.meta.title && message.role === "user" && !message.meta) {
      const text = message.content.find((b) => b.type === "text")?.text ?? "";
      const title = text.replace(/\s+/g, " ").trim().slice(0, 72);
      if (title) {
        this.meta.title = title;
        this.#append({ type: "title", title });
      }
    }
  }

  addTodos(todos: TodoItem[]): void {
    this.#append({ type: "todos", todos });
  }

  /** Wait for queued writes — call before exiting so nothing is lost. */
  async flush(): Promise<void> {
    await this.#queue;
  }
}

export interface LoadedSession {
  meta: SessionMeta;
  messages: Message[];
  todos: TodoItem[];
}

async function parseFile(file: string): Promise<LoadedSession | undefined> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return undefined;
  }
  const lines = raw.split("\n").filter(Boolean);
  let meta: SessionMeta | undefined;
  const messages: Message[] = [];
  let todos: TodoItem[] = [];
  for (const line of lines) {
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // a torn final line from a crash — skip it, keep the rest
    }
    if (rec.type === "session" && !meta) meta = rec;
    else if (rec.type === "message" && rec.message) messages.push(rec.message);
    else if (rec.type === "todos") todos = rec.todos ?? [];
    else if (rec.type === "title" && meta) meta.title = rec.title;
  }
  if (!meta) return undefined;
  return { meta, messages, todos };
}

export interface SessionSummary {
  id: string;
  file: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  model: string;
}

/** Newest first. Scoped to `cwd`'s project directory unless `all` is set. */
export async function listSessions(cwd: string, all = false): Promise<SessionSummary[]> {
  const dirs: string[] = [];
  if (all) {
    try {
      for (const d of await readdir(root())) dirs.push(join(root(), d));
    } catch {
      return [];
    }
  } else {
    dirs.push(dirFor(cwd));
  }

  const out: SessionSummary[] = [];
  for (const dir of dirs) {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const file = join(dir, name);
      const loaded = await parseFile(file);
      if (!loaded) continue;
      let updatedAt = loaded.meta.createdAt;
      try {
        updatedAt = (await stat(file)).mtime.toISOString();
      } catch {
        /* keep createdAt */
      }
      out.push({
        id: loaded.meta.id,
        file,
        title: loaded.meta.title ?? "(untitled)",
        createdAt: loaded.meta.createdAt,
        updatedAt,
        messageCount: loaded.messages.filter((m) => !m.meta).length,
        model: loaded.meta.model,
      });
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Resume by full id or unique prefix. */
export async function loadSession(cwd: string, idOrPrefix: string): Promise<LoadedSession | undefined> {
  const candidates = await listSessions(cwd, true);
  const hit =
    candidates.find((s) => s.id === idOrPrefix) ??
    candidates.filter((s) => s.id.startsWith(idOrPrefix))[0];
  if (!hit) return undefined;
  return parseFile(hit.file);
}

/**
 * Fork: copy a prefix into a fresh id. We record `forkedFrom` and give the
 * copy a new id rather than remapping per-message ids, because nothing in this
 * agent references messages by id (Ch. 15 "Lean take": don't deep-copy side
 * state; start the fork clean).
 */
export async function forkSession(
  cwd: string,
  idOrPrefix: string,
  upToUserMessage?: number,
): Promise<{ store: SessionStore; loaded: LoadedSession } | undefined> {
  const loaded = await loadSession(cwd, idOrPrefix);
  if (!loaded) return undefined;
  let messages = loaded.messages;
  if (upToUserMessage && upToUserMessage > 0) {
    let seen = 0;
    const cut: Message[] = [];
    for (const m of messages) {
      if (m.role === "user" && !m.meta) {
        seen++;
        if (seen > upToUserMessage) break;
      }
      cut.push(m);
    }
    messages = cut;
  }
  const store = await SessionStore.create({
    cwd,
    provider: loaded.meta.provider,
    model: loaded.meta.model,
    forkedFrom: loaded.meta.id,
  });
  for (const m of messages) store.addMessage(m);
  if (loaded.todos.length) store.addTodos(loaded.todos);
  await store.flush();
  return { store, loaded: { meta: store.meta, messages, todos: loaded.todos } };
}

export function sessionsRoot(): string {
  return root();
}
