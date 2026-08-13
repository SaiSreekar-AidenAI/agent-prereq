// tools.ts — THE TOOL SYSTEM (Ch. 3).
//
// A tool is `{name, description, input_schema, readOnly, checkPermissions?, run}`.
// `description` + `input_schema` are what the model sees; `run` is the
// implementation; `readOnly` drives BOTH the permission gate and parallelism.
// Schema and implementation live in the same object so they cannot drift.
//
// The registry is a flat array (Ch. 3 "Lean take": a registry is a literal
// array, not a framework). Extensions and MCP-style adapters merge onto it.

import { exec } from "node:child_process";
import { readFile, writeFile, mkdir, readdir, stat, glob as fsGlob } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);

// ── the interface ────────────────────────────────────────────────────────────

export type Decision = "allow" | "ask" | "deny";

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

export interface ToolContext {
  cwd: string;
  signal?: AbortSignal;
  /** Session scratchpad the model maintains for itself (Ch. 15). */
  todos: TodoItem[];
  setTodos(todos: TodoItem[]): void;
  /** Ch. 13: recurse the loop with a child context. Injected by the runtime. */
  runSubagent?(prompt: string, opts: { label: string }): Promise<string>;
  /** Ch. 17: rebuild the tool registry from extensions/. Injected by the runtime. */
  reloadExtensions?(): Promise<string>;
  /** Where oversized tool output is spilled (Ch. 6). */
  spillDir: string;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
}

export interface Tool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  /** Fail-closed: a tool is a writer unless it says otherwise. */
  readOnly: boolean;
  /** Per-tool risk logic. The global gate owns cross-tool rules (Ch. 7). */
  checkPermissions?(input: any, ctx: ToolContext): Decision | undefined;
  /** Override the global spill threshold for unusually chatty tools. */
  maxResultChars?: number;
  run(input: any, ctx: ToolContext): Promise<ToolResult>;
}

/**
 * buildTool — fail-closed defaults so a new tool is safe by default and tiny to
 * declare (claude-code Tool.ts:757). `readOnly` defaults to false; omit
 * `checkPermissions` and the global gate decides.
 */
export function buildTool(spec: Partial<Tool> & Pick<Tool, "name" | "description" | "input_schema" | "run">): Tool {
  return { readOnly: false, ...spec } as Tool;
}

// ── path helpers + the bypass-immune safety floor (Ch. 7) ────────────────────

const PROTECTED_DIRS = [".git", ".agent", ".claude", ".ssh", ".config/gh", "node_modules/.bin"];
const PROTECTED_FILES = [
  ".gitconfig",
  ".bashrc",
  ".bash_profile",
  ".zshrc",
  ".profile",
  ".npmrc",
  ".netrc",
  ".env",
];

export function resolvePath(p: string, cwd: string): string {
  const raw = String(p ?? "");
  const expanded = raw.startsWith("~") ? join(homedir(), raw.slice(1)) : raw;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

export function isOutsideWorkspace(abs: string, cwd: string): boolean {
  const rel = relative(resolve(cwd), abs);
  return rel.startsWith("..") || isAbsolute(rel);
}

/**
 * The safety floor. Writes here always prompt, no matter what the permission
 * mode says — this is the single highest-value safety feature in the chapter
 * and it costs a dozen lines (claude-code filesystem.ts:57,74).
 */
export function isProtectedPath(abs: string, cwd: string): boolean {
  if (isOutsideWorkspace(abs, cwd)) return true;
  const parts = abs.split(sep);
  // Any run of path segments matching a protected dir (".git", ".ssh", ".config/gh", …).
  for (const d of PROTECTED_DIRS) {
    const segs = d.split("/");
    for (let i = 0; i + segs.length <= parts.length; i++) {
      if (segs.every((s, j) => parts[i + j] === s)) return true;
    }
  }
  return PROTECTED_FILES.includes(basename(abs));
}

// ── tool-result capping + disk spill (Ch. 6, cheapest tier) ──────────────────

export async function capAndSpill(
  result: ToolResult,
  limit: number,
  ctx: ToolContext,
  toolName: string,
): Promise<ToolResult> {
  if (result.content.length <= limit) return result;
  const head = result.content.slice(0, Math.floor(limit * 0.6));
  const tail = result.content.slice(-Math.floor(limit * 0.2));
  let pointer = "(spill file could not be written)";
  try {
    await mkdir(ctx.spillDir, { recursive: true });
    const file = join(ctx.spillDir, `${toolName}-${Date.now().toString(36)}.txt`);
    await writeFile(file, result.content, "utf8");
    pointer = file;
  } catch {
    /* keep the preview even if the spill fails */
  }
  return {
    ...result,
    content:
      `${head}\n\n…[${result.content.length - head.length - tail.length} characters elided; ` +
      `full output written to ${pointer} — read it with the \`read\` tool if you need the rest]…\n\n${tail}`,
  };
}

// ── bash ─────────────────────────────────────────────────────────────────────

/** Commands whose worst case is "prints something". Auto-allowed. */
const SAFE_COMMANDS = new Set([
  "ls", "cat", "head", "tail", "wc", "pwd", "echo", "date", "whoami", "which", "file",
  "grep", "rg", "find", "sort", "uniq", "cut", "tr", "basename", "dirname", "stat",
  "tree", "du", "df", "env", "printenv", "diff", "sed", "awk", "jq", "node", "python3",
]);

/** Never auto-allow, even inside an otherwise-safe pipeline. */
const DENY_PATTERNS = [/\brm\s+-[rf]/i, /\bmkfs\b/i, /\bdd\s+if=/i, /:\(\)\s*\{.*\}\s*;/, /\bshutdown\b/i, /\breboot\b/i];

/** git subcommands that only read. */
const SAFE_GIT = new Set(["status", "log", "diff", "show", "branch", "remote", "config", "blame", "ls-files", "rev-parse"]);

export function splitSubcommands(command: string): string[] {
  // Lean version of opencode's tree-sitter split: break on the shell operators
  // that sequence commands. Good enough for the 90% case; the gate still asks
  // for anything it does not recognise, so the failure mode is a prompt.
  return command
    .split(/\|\||&&|;|\||\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function bashDecision(command: string): Decision {
  if (DENY_PATTERNS.some((re) => re.test(command))) return "deny";
  const subs = splitSubcommands(command);
  if (subs.length === 0) return "ask";
  for (const sub of subs) {
    const tokens = sub.split(/\s+/).filter(Boolean);
    let head = tokens[0];
    if (!head) return "ask";
    // strip a leading env assignment like FOO=bar cmd
    let i = 0;
    while (head && /^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) head = tokens[++i];
    if (!head) return "ask";
    if (head === "git") {
      if (!SAFE_GIT.has(tokens[i + 1] ?? "")) return "ask";
      continue;
    }
    if (!SAFE_COMMANDS.has(basename(head))) return "ask";
    // A read-only-looking command that redirects into a file is a writer.
    if (/[^<>]>[^>]|>>/.test(sub)) return "ask";
  }
  return "allow";
}

export const bashTool = buildTool({
  name: "bash",
  description:
    "Run a shell command with bash in the working directory and return its combined stdout/stderr and exit code. " +
    "Use it for builds, tests, git, and anything without a dedicated tool. Avoid interactive commands — " +
    "there is no TTY. Prefer the `read`, `glob`, and `grep` tools over `cat`, `find`, and `grep` so results " +
    "come back structured and read-only commands can run in parallel.",
  input_schema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to run" },
      timeout_ms: { type: "integer", description: "Kill the command after this many ms (default 120000)" },
    },
    required: ["command"],
  },
  readOnly: false,
  checkPermissions: (input) => bashDecision(String(input?.command ?? "")),
  async run(input, ctx) {
    const cmd = String(input?.command ?? "").trim();
    if (!cmd) return { content: "No command given.", isError: true };
    const timeout = Number(input?.timeout_ms) || 120_000;
    try {
      const { stdout, stderr } = await execAsync(cmd, {
        cwd: ctx.cwd,
        timeout,
        maxBuffer: 8 * 1024 * 1024,
        signal: ctx.signal,
      });
      const body = [stdout, stderr && `[stderr]\n${stderr}`].filter(Boolean).join("\n").trim();
      return { content: `exit=0\n${body || "(no output)"}` };
    } catch (err) {
      const e = err as any;
      const body = [e.stdout, e.stderr].filter(Boolean).join("\n").trim();
      const code = e.code ?? (e.killed ? "timeout" : "error");
      return { content: `exit=${code}\n${body || e.message}`, isError: true };
    }
  },
});

// ── read ─────────────────────────────────────────────────────────────────────

export const readTool = buildTool({
  name: "read",
  description:
    "Read a UTF-8 text file and return its contents with 1-based line numbers (cat -n style), so you can " +
    "quote exact lines back in an `edit`. Reads up to `limit` lines starting at `offset`.",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file, absolute or relative to the working directory" },
      offset: { type: "integer", description: "1-based first line to return (default 1)" },
      limit: { type: "integer", description: "Maximum number of lines to return (default 2000)" },
    },
    required: ["path"],
  },
  readOnly: true,
  async run(input, ctx) {
    const abs = resolvePath(input?.path, ctx.cwd);
    try {
      const text = await readFile(abs, "utf8");
      const all = text.split("\n");
      const offset = Math.max(1, Number(input?.offset) || 1);
      const limit = Math.max(1, Number(input?.limit) || 2000);
      const slice = all.slice(offset - 1, offset - 1 + limit);
      if (slice.length === 0) return { content: `(${abs} has ${all.length} lines; offset ${offset} is past the end)` };
      const numbered = slice.map((l, i) => `${String(offset + i).padStart(6)}\t${l}`).join("\n");
      const more = offset - 1 + slice.length < all.length ? `\n… ${all.length - (offset - 1 + slice.length)} more lines` : "";
      return { content: numbered + more };
    } catch (err) {
      return { content: `Could not read ${abs}: ${(err as Error).message}`, isError: true };
    }
  },
});

// ── write ────────────────────────────────────────────────────────────────────

export const writeTool = buildTool({
  name: "write",
  description:
    "Write a UTF-8 text file, creating parent directories and overwriting any existing file. " +
    "Prefer `edit` for changing part of an existing file — `write` replaces the whole thing.",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file" },
      content: { type: "string", description: "Full contents to write" },
    },
    required: ["path", "content"],
  },
  readOnly: false,
  // Escalate for protected paths; otherwise return nothing and let the global
  // gate decide. Returning "allow" here would override the default-ask and
  // silently let every in-workspace edit through.
  checkPermissions: (input, ctx) => (isProtectedPath(resolvePath(input?.path, ctx.cwd), ctx.cwd) ? "ask" : undefined),
  async run(input, ctx) {
    const abs = resolvePath(input?.path, ctx.cwd);
    const body = String(input?.content ?? "");
    try {
      await mkdir(dirname(abs), { recursive: true });
      const existed = existsSync(abs);
      await writeFile(abs, body, "utf8");
      return { content: `${existed ? "Overwrote" : "Created"} ${abs} (${body.length} bytes, ${body.split("\n").length} lines)` };
    } catch (err) {
      return { content: `Could not write ${abs}: ${(err as Error).message}`, isError: true };
    }
  },
});

// ── edit ─────────────────────────────────────────────────────────────────────

export const editTool = buildTool({
  name: "edit",
  description:
    "Replace an exact string in a text file. `old_string` must appear EXACTLY ONCE unless `replace_all` is true — " +
    "include surrounding lines to make it unique. Read the file first so the string you match is exact " +
    "(do not include the line-number prefixes `read` adds).",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file" },
      old_string: { type: "string", description: "Exact text to replace" },
      new_string: { type: "string", description: "Replacement text" },
      replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring exactly one" },
    },
    required: ["path", "old_string", "new_string"],
  },
  readOnly: false,
  // Escalate for protected paths; otherwise return nothing and let the global
  // gate decide. Returning "allow" here would override the default-ask and
  // silently let every in-workspace edit through.
  checkPermissions: (input, ctx) => (isProtectedPath(resolvePath(input?.path, ctx.cwd), ctx.cwd) ? "ask" : undefined),
  async run(input, ctx) {
    const abs = resolvePath(input?.path, ctx.cwd);
    const oldS = String(input?.old_string ?? "");
    const newS = String(input?.new_string ?? "");
    if (oldS === "") return { content: "old_string must not be empty; use `write` to create a file.", isError: true };
    if (oldS === newS) return { content: "old_string and new_string are identical; nothing to do.", isError: true };
    try {
      const before = await readFile(abs, "utf8");
      const hits = before.split(oldS).length - 1;
      if (hits === 0) return { content: `old_string not found in ${abs}.`, isError: true };
      if (hits > 1 && !input?.replace_all) {
        return { content: `old_string appears ${hits}× in ${abs}; add surrounding context or pass replace_all:true.`, isError: true };
      }
      const after = input?.replace_all ? before.split(oldS).join(newS) : before.replace(oldS, newS);
      await writeFile(abs, after, "utf8");
      return { content: `Edited ${abs} (${hits} replacement${hits === 1 ? "" : "s"})` };
    } catch (err) {
      return { content: `Could not edit ${abs}: ${(err as Error).message}`, isError: true };
    }
  },
});

// ── glob ─────────────────────────────────────────────────────────────────────

const IGNORED_DIRS = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build", ".next", "target", ".cache"]);

export const globTool = buildTool({
  name: "glob",
  description:
    "Find files by glob pattern (e.g. `src/**/*.ts`), newest first. Skips .git, node_modules and other " +
    "build/vendor directories. Use this instead of `bash find`.",
  input_schema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern, e.g. **/*.ts" },
      path: { type: "string", description: "Directory to search from (default: the working directory)" },
      limit: { type: "integer", description: "Maximum paths to return (default 200)" },
    },
    required: ["pattern"],
  },
  readOnly: true,
  async run(input, ctx) {
    const root = resolvePath(input?.path ?? ".", ctx.cwd);
    const limit = Math.max(1, Number(input?.limit) || 200);
    try {
      const found: string[] = [];
      for await (const entry of fsGlob(String(input?.pattern ?? "**/*"), { cwd: root })) {
        const rel = String(entry);
        if (rel.split("/").some((seg) => IGNORED_DIRS.has(seg))) continue;
        found.push(join(root, rel));
        if (found.length >= limit * 4) break; // bound the walk, then sort+trim
      }
      const withTimes = await Promise.all(
        found.map(async (f) => {
          try {
            return { f, mtime: (await stat(f)).mtimeMs };
          } catch {
            return { f, mtime: 0 };
          }
        }),
      );
      withTimes.sort((a, b) => b.mtime - a.mtime);
      const paths = withTimes.slice(0, limit).map((x) => x.f);
      if (!paths.length) return { content: `No files matched ${input?.pattern} under ${root}` };
      return { content: `${paths.length} match(es):\n${paths.join("\n")}` };
    } catch (err) {
      return { content: `glob failed: ${(err as Error).message}`, isError: true };
    }
  },
});

// ── grep ─────────────────────────────────────────────────────────────────────

async function* walkFiles(dir: string, depth = 0): AsyncGenerator<string> {
  if (depth > 12) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".") && e.name !== ".github") continue;
    if (IGNORED_DIRS.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walkFiles(full, depth + 1);
    else if (e.isFile()) yield full;
  }
}

export const grepTool = buildTool({
  name: "grep",
  description:
    "Search file contents with a JavaScript regular expression and return matching lines with their file and " +
    "line number. Optionally restrict to files whose name matches `include` (a substring or extension). " +
    "Use this instead of `bash grep`.",
  input_schema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression to search for" },
      path: { type: "string", description: "Directory or file to search (default: the working directory)" },
      include: { type: "string", description: "Only search files whose path contains this, e.g. '.ts'" },
      limit: { type: "integer", description: "Maximum matching lines to return (default 100)" },
    },
    required: ["pattern"],
  },
  readOnly: true,
  async run(input, ctx) {
    const root = resolvePath(input?.path ?? ".", ctx.cwd);
    const limit = Math.max(1, Number(input?.limit) || 100);
    const include = input?.include ? String(input.include) : "";
    let re: RegExp;
    try {
      re = new RegExp(String(input?.pattern ?? ""), "m");
    } catch (err) {
      return { content: `Invalid regular expression: ${(err as Error).message}`, isError: true };
    }
    const hits: string[] = [];
    let scanned = 0;
    const files: string[] = [];
    try {
      if ((await stat(root)).isFile()) files.push(root);
      else for await (const f of walkFiles(root)) files.push(f);
    } catch (err) {
      return { content: `grep failed: ${(err as Error).message}`, isError: true };
    }
    for (const file of files) {
      if (include && !file.includes(include)) continue;
      if (hits.length >= limit) break;
      scanned++;
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch {
        continue;
      }
      if (text.includes("\u0000")) continue; // NUL byte => treat as binary, skip
      const lines = text.split("\n");
      for (let i = 0; i < lines.length && hits.length < limit; i++) {
        if (re.test(lines[i])) hits.push(`${file}:${i + 1}: ${lines[i].trim().slice(0, 300)}`);
      }
    }
    if (!hits.length) return { content: `No matches for /${input?.pattern}/ in ${scanned} file(s) under ${root}` };
    const capped = hits.length >= limit ? `\n… stopped at the ${limit}-match limit` : "";
    return { content: `${hits.length} match(es) in ${scanned} file(s):\n${hits.join("\n")}${capped}` };
  },
});

// ── ls ───────────────────────────────────────────────────────────────────────

export const lsTool = buildTool({
  name: "ls",
  description: "List the entries of a directory, marking directories with a trailing slash.",
  input_schema: {
    type: "object",
    properties: { path: { type: "string", description: "Directory to list (default: the working directory)" } },
  },
  readOnly: true,
  async run(input, ctx) {
    const abs = resolvePath(input?.path ?? ".", ctx.cwd);
    try {
      const entries = await readdir(abs, { withFileTypes: true });
      if (!entries.length) return { content: `${abs} is empty` };
      const listed = entries
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
      return { content: `${abs}:\n${listed.join("\n")}` };
    } catch (err) {
      return { content: `Could not list ${abs}: ${(err as Error).message}`, isError: true };
    }
  },
});

// ── todo_write (Ch. 15) ──────────────────────────────────────────────────────

export const todoTool = buildTool({
  name: "todo_write",
  description:
    "Replace your task list for this session. Use it for any task with three or more steps: write the list " +
    "before you start, mark exactly one item in_progress while you work on it, and mark it completed as soon " +
    "as it is done. Skip it for trivial one-step requests.",
  input_schema: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        description: "The complete list, replacing whatever was there before",
        items: {
          type: "object",
          properties: {
            content: { type: "string", description: "Imperative description, e.g. 'Add the retry test'" },
            status: { type: "string", enum: ["pending", "in_progress", "completed"] },
            activeForm: { type: "string", description: "Present-continuous form, e.g. 'Adding the retry test'" },
          },
          required: ["content", "status"],
        },
      },
    },
    required: ["todos"],
  },
  readOnly: true, // touches session state only — no side effects on disk
  async run(input, ctx) {
    const raw = Array.isArray(input?.todos) ? input.todos : [];
    const todos: TodoItem[] = raw.map((t: any) => ({
      content: String(t?.content ?? ""),
      status: ["pending", "in_progress", "completed"].includes(t?.status) ? t.status : "pending",
      activeForm: t?.activeForm ? String(t.activeForm) : undefined,
    }));
    ctx.setTodos(todos);
    const done = todos.filter((t) => t.status === "completed").length;
    if (todos.length && done === todos.length) {
      return { content: `All ${todos.length} todos complete. The list is cleared.` };
    }
    const rendered = todos.map((t) => `  [${t.status === "completed" ? "x" : t.status === "in_progress" ? "~" : " "}] ${t.content}`).join("\n");
    return { content: `Todos updated (${done}/${todos.length} done):\n${rendered}\nContinue using the todo list as you work.` };
  },
});

// ── task: a subagent is the same loop, recursed (Ch. 13) ─────────────────────

export const taskTool = buildTool({
  name: "task",
  description:
    "Delegate a self-contained, read-heavy subtask to a child agent with its own context window and a " +
    "read-only tool set. It cannot edit files or run commands, so use it to search, read, and report — " +
    "not to make changes. Give it a complete brief: it cannot see this conversation. " +
    "Its final message comes back as this tool's result.",
  input_schema: {
    type: "object",
    properties: {
      description: { type: "string", description: "Three to five words naming the subtask, for the transcript" },
      prompt: { type: "string", description: "The full, self-contained brief for the child agent" },
    },
    required: ["description", "prompt"],
  },
  readOnly: true, // the child's own gate governs anything it does
  async run(input, ctx) {
    if (!ctx.runSubagent) return { content: "Subagents are not available in this runtime.", isError: true };
    const prompt = String(input?.prompt ?? "").trim();
    if (!prompt) return { content: "`prompt` is required.", isError: true };
    try {
      const out = await ctx.runSubagent(prompt, { label: String(input?.description ?? "subtask") });
      return { content: out || "(the subagent returned no text)" };
    } catch (err) {
      return { content: `Subagent failed: ${(err as Error).message}`, isError: true };
    }
  },
});

// ── reload_extensions: the self-extension seam (Ch. 17) ──────────────────────

export const reloadExtensionsTool = buildTool({
  name: "reload_extensions",
  description:
    "Re-scan the extensions/ directory and (re)load every tool defined there. Call this immediately after " +
    "writing or editing an extension file to make its tools callable in this same session.",
  input_schema: { type: "object", properties: {} },
  readOnly: true,
  async run(_input, ctx) {
    if (!ctx.reloadExtensions) return { content: "Extensions are not available in this runtime.", isError: true };
    return { content: await ctx.reloadExtensions() };
  },
});

// ── the registry ─────────────────────────────────────────────────────────────

export const BUILTIN_TOOLS: Tool[] = [
  bashTool,
  readTool,
  writeTool,
  editTool,
  globTool,
  grepTool,
  lsTool,
  todoTool,
  taskTool,
  reloadExtensionsTool,
];

/** The tool set a subagent gets: read-only, and no further recursion. */
export const SUBAGENT_TOOLS: Tool[] = [readTool, globTool, grepTool, lsTool, bashTool];

/** Merge extension/MCP tools onto the built-ins. Built-ins win on name conflict. */
export function mergeTools(builtins: Tool[], extra: Tool[]): Tool[] {
  const byName = new Map(builtins.map((t) => [t.name, t]));
  for (const t of extra) if (!byName.has(t.name)) byName.set(t.name, t);
  return [...byName.values()];
}

export function defaultSpillDir(): string {
  return join(tmpdir(), "lean-agent-spill");
}
