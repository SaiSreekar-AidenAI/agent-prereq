// memory.ts — CONTEXT FILES (Ch. 9).
//
// Persistent project/user instructions the agent loads from disk: `AGENTS.md`,
// `CLAUDE.md`, `.agent/AGENTS.md`. Three independent decisions, per the chapter:
//
//   discovery  — user (~/.agent) < project root … < cwd. Nearer files load
//                LATER because the model weights later text more heavily.
//   embeds     — `@path` pulls another file in, spliced BEFORE the including
//                file so the parent's own text wins on conflict. Depth-capped,
//                cycle-guarded.
//   injection  — as a leading `<system-reminder>` USER message, not as part of
//                the system prompt, so editing memory mid-session never
//                invalidates the cached system prefix (Ch. 5).
//
// The walk is memoized; `/memory` and `/clear` bust the cache.

import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { agentHome } from "./config.ts";

const FILENAMES = ["AGENTS.md", "CLAUDE.md", ".agent/AGENTS.md", ".claude/CLAUDE.md"];
const USER_DIR = () => agentHome();
const MAX_INCLUDE_DEPTH = 5;
const MAX_TOTAL_BYTES = 64 * 1024;

export type MemoryKind = "user" | "project" | "local";

export interface MemoryFile {
  path: string;
  kind: MemoryKind;
  body: string;
}

const LABELS: Record<MemoryKind, string> = {
  user: "user's private global instructions for all projects",
  project: "project instructions, checked into the codebase",
  local: "local instructions, not checked in",
};

function findProjectRoot(cwd: string): string {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(cwd);
    dir = parent;
  }
}

function stripFrontmatterAndComments(raw: string): string {
  return raw.replace(/^---\n[\s\S]*?\n---\n/, "").replace(/<!--[\s\S]*?-->/g, "");
}

/** `@path` tokens in ordinary text — not inside fenced blocks or code spans. */
function extractIncludes(body: string): string[] {
  const withoutCode = body.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  const out: string[] = [];
  for (const m of withoutCode.matchAll(/(^|\s)@([^\s`]+\.(?:md|markdown|txt))\b/g)) out.push(m[2]);
  return out;
}

async function loadOne(path: string, kind: MemoryKind, seen: Set<string>, depth: number): Promise<MemoryFile[]> {
  const abs = resolve(path);
  if (seen.has(abs) || depth > MAX_INCLUDE_DEPTH) return [];
  seen.add(abs);
  let raw: string;
  try {
    raw = await readFile(abs, "utf8");
  } catch {
    return [];
  }
  const body = stripFrontmatterAndComments(raw).trim();
  if (!body) return [];

  const children: MemoryFile[] = [];
  for (const inc of extractIncludes(body)) {
    const target = inc.startsWith("~")
      ? join(homedir(), inc.slice(1))
      : isAbsolute(inc)
        ? inc
        : resolve(dirname(abs), inc);
    children.push(...(await loadOne(target, kind, seen, depth + 1)));
  }
  // children BEFORE parent so the including file's own text is later = wins.
  return [...children, { path: abs, kind, body }];
}

export interface MemoryContext {
  files: MemoryFile[];
  /** The rendered blob, or "" when no memory files exist. */
  text: string;
}

let cache: { cwd: string; value: MemoryContext } | undefined;

export function invalidateMemoryCache(): void {
  cache = undefined;
}

export async function loadMemory(cwd: string): Promise<MemoryContext> {
  if (cache && cache.cwd === cwd) return cache.value;

  const seen = new Set<string>();
  const files: MemoryFile[] = [];

  // 1. user tier
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    files.push(...(await loadOne(join(USER_DIR(), name), "user", seen, 0)));
  }

  // 2. project tier: root → cwd, so the nearest file lands last.
  const root = findProjectRoot(cwd);
  const chain: string[] = [];
  let dir = resolve(cwd);
  for (;;) {
    chain.unshift(dir);
    if (dir === root || dirname(dir) === dir) break;
    dir = dirname(dir);
  }
  for (const d of chain) {
    for (const name of FILENAMES) files.push(...(await loadOne(join(d, name), "project", seen, 0)));
    for (const name of ["AGENTS.local.md", "CLAUDE.local.md"]) {
      files.push(...(await loadOne(join(d, name), "local", seen, 0)));
    }
  }

  let total = 0;
  const kept: MemoryFile[] = [];
  for (const f of files) {
    if (total + f.body.length > MAX_TOTAL_BYTES) break;
    total += f.body.length;
    kept.push(f);
  }

  const value: MemoryContext = { files: kept, text: renderMemory(kept) };
  cache = { cwd, value };
  return value;
}

function renderMemory(files: MemoryFile[]): string {
  if (!files.length) return "";
  const parts = files.map((f) => `Contents of ${f.path} (${LABELS[f.kind]}):\n\n${f.body}`);
  return (
    "Codebase and user instructions are shown below. Follow them; they OVERRIDE your default behaviour " +
    "where they conflict.\n\n" +
    parts.join("\n\n")
  );
}

/** The paths `/memory` offers to edit, whether or not they exist yet. */
export async function memoryCandidates(cwd: string): Promise<{ path: string; kind: MemoryKind; exists: boolean }[]> {
  const root = findProjectRoot(cwd);
  const paths: { path: string; kind: MemoryKind }[] = [
    { path: join(USER_DIR(), "AGENTS.md"), kind: "user" },
    { path: join(root, "AGENTS.md"), kind: "project" },
    { path: join(root, "AGENTS.local.md"), kind: "local" },
  ];
  if (resolve(cwd) !== root) paths.splice(2, 0, { path: join(resolve(cwd), "AGENTS.md"), kind: "project" });
  return paths.map((p) => ({ ...p, exists: existsSync(p.path) }));
}

/** Used by `/init` to describe the repo it is documenting. */
export async function repoSnapshot(cwd: string): Promise<string> {
  const root = findProjectRoot(cwd);
  let entries: string[] = [];
  try {
    entries = (await readdir(root, { withFileTypes: true }))
      .filter((e) => !e.name.startsWith(".") || e.name === ".github")
      .slice(0, 60)
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
  } catch {
    /* ignore */
  }
  return `project root: ${root}\ntop level: ${entries.join(" ")}`;
}
