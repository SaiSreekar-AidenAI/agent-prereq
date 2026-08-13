// commands.ts — SLASH & CUSTOM COMMANDS (Ch. 11).
//
// Input starting with `/` is intercepted BEFORE the agent loop. There are
// exactly two kinds, and that single split is the whole feature:
//
//   client  — runs a function in-process, mutates session state, returns.
//             The model is never called. (/clear, /model, /cost, …)
//   prompt  — a markdown file whose body is expanded and injected as a user
//             turn. The model runs as if the user had typed the expansion.
//
// Markdown commands live in `.agent/commands/**/*.md` (project) and
// `~/.agent/commands/**/*.md` (user). The command name is the path relative to
// that root with `/` → `:`, so `commands/git/fixup.md` is `/git:fixup` — free
// namespacing, no registry.
//
// Expansion runs three passes, in order: arguments, literals, then embedded
// shell. Every embedded `` !`cmd` `` is permission-checked before it runs —
// that is the one security-load-bearing rule in the chapter.

import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { Tool } from "./tools.ts";
import { bashTool } from "./tools.ts";
import type { PermissionGate } from "./permissions.ts";
import { agentHome } from "./config.ts";

const execAsync = promisify(exec);

// ── the host interface commands act on ───────────────────────────────────────
// Defined here (not imported from the REPL) so this module stays a leaf.

export interface CommandHost {
  cwd: string;
  print(text: string): void;
  /** Client commands mutate the app through these. */
  clearConversation(): Promise<void>;
  compactConversation(focus?: string): Promise<void>;
  resumeSession(idOrPrefix?: string): Promise<void>;
  switchModel(spec: string): Promise<void>;
  setPermissionMode(mode: string): void;
  addPermissionRule(spec: string): void;
  describePermissions(): string;
  describeStatus(): string;
  describeCost(): string;
  describeContext(): string;
  describeTools(): string;
  describeTodos(): string;
  describeMemory(): Promise<string>;
  reloadExtensions(): Promise<string>;
  initProjectDoc(): Promise<string>;
  gate: PermissionGate;
  listTools(): Tool[];
  sessionId: string;
}

export interface CommandResult {
  /** Non-empty ⇒ inject as a user turn and call the model. */
  prompt?: string;
  exit?: boolean;
}

export interface SlashCommand {
  name: string;
  description: string;
  argumentHint?: string;
  aliases?: string[];
  source?: string;
  run(args: string, host: CommandHost): Promise<CommandResult | void>;
}

// ── built-ins ────────────────────────────────────────────────────────────────

export function builtinCommands(): SlashCommand[] {
  return [
    {
      name: "help",
      description: "List the available commands",
      aliases: ["?"],
      async run(_args, host) {
        host.print(renderHelp(host));
      },
    },
    {
      name: "clear",
      description: "Start a fresh conversation (new session, empty context)",
      async run(_args, host) {
        await host.clearConversation();
      },
    },
    {
      name: "compact",
      description: "Summarize the conversation now and continue with the summary",
      argumentHint: "[what to focus on]",
      async run(args, host) {
        await host.compactConversation(args.trim() || undefined);
      },
    },
    {
      name: "resume",
      description: "List past sessions, or resume one by id prefix",
      argumentHint: "[session-id]",
      async run(args, host) {
        await host.resumeSession(args.trim() || undefined);
      },
    },
    {
      name: "model",
      description: "Show or switch the model (and the provider it implies)",
      argumentHint: "[model | provider/model]",
      async run(args, host) {
        await host.switchModel(args.trim());
      },
    },
    {
      name: "permissions",
      description: "Show the gate, change mode, or add a rule",
      argumentHint: "[default|acceptEdits|plan|bypass | allow:bash(git *)]",
      aliases: ["approvals"],
      async run(args, host) {
        const a = args.trim();
        if (!a) return void host.print(host.describePermissions());
        if (["default", "acceptEdits", "plan", "bypass"].includes(a)) host.setPermissionMode(a);
        else host.addPermissionRule(a);
        host.print(host.describePermissions());
      },
    },
    {
      name: "cost",
      description: "Token usage and estimated cost for this session",
      async run(_args, host) {
        host.print(host.describeCost());
      },
    },
    {
      name: "context",
      description: "Show how the context window is being spent",
      async run(_args, host) {
        host.print(host.describeContext());
      },
    },
    {
      name: "tools",
      description: "List the tools currently registered",
      async run(_args, host) {
        host.print(host.describeTools());
      },
    },
    {
      name: "todos",
      description: "Show the model's current task list",
      async run(_args, host) {
        host.print(host.describeTodos());
      },
    },
    {
      name: "memory",
      description: "Show which AGENTS.md / CLAUDE.md files are loaded",
      async run(_args, host) {
        host.print(await host.describeMemory());
      },
    },
    {
      name: "init",
      description: "Generate an AGENTS.md describing this repo",
      async run(_args, host) {
        return { prompt: await host.initProjectDoc() };
      },
    },
    {
      name: "reload",
      description: "Re-scan extensions/ and reload its tools",
      async run(_args, host) {
        host.print(await host.reloadExtensions());
      },
    },
    {
      name: "status",
      description: "Session id, provider, model, cwd, permission mode",
      async run(_args, host) {
        host.print(host.describeStatus());
      },
    },
    {
      name: "exit",
      description: "Leave the agent",
      aliases: ["quit"],
      async run() {
        return { exit: true };
      },
    },
  ];
}

function renderHelp(host: CommandHost): string {
  const all = host.listTools();
  const rows = (host as any).__commands as SlashCommand[] | undefined;
  const lines = ["Commands:"];
  for (const c of rows ?? builtinCommands()) {
    const alias = c.aliases?.length ? ` (${c.aliases.map((a) => "/" + a).join(", ")})` : "";
    const hint = c.argumentHint ? " " + c.argumentHint : "";
    const src = c.source ? `  ${c.source}` : "";
    lines.push(`  /${c.name}${hint}${alias}`.padEnd(46) + c.description + src);
  }
  lines.push("", `Tools: ${all.map((t) => t.name).join(", ")}`);
  lines.push("", "Ctrl-C interrupts the current turn; Ctrl-D or /exit leaves.");
  return lines.join("\n");
}

// ── markdown (prompt) commands ───────────────────────────────────────────────

interface MarkdownCommand {
  name: string;
  description: string;
  argumentHint?: string;
  argumentNames: string[];
  body: string;
  file: string;
}

function parseFrontmatter(raw: string): { data: Record<string, string>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  if (!m) return { data: {}, body: raw };
  const data: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (kv) data[kv[1]] = kv[2].trim();
  }
  return { data, body: raw.slice(m[0].length) };
}

async function walkMd(dir: string, base: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) await walkMd(full, base, out);
    else if (extname(e.name) === ".md") out.push(full);
  }
}

export async function loadMarkdownCommands(cwd: string): Promise<SlashCommand[]> {
  const roots = [
    { dir: join(resolve(cwd), ".agent", "commands"), label: "project" },
    { dir: join(agentHome(), "commands"), label: "user" },
  ];
  const seen = new Set<string>();
  const commands: SlashCommand[] = [];

  for (const root of roots) {
    const files: string[] = [];
    await walkMd(root.dir, root.dir, files);
    for (const file of files) {
      const raw = await readFile(file, "utf8").catch(() => "");
      if (!raw.trim()) continue;
      const { data, body } = parseFrontmatter(raw);
      // name = path relative to the root, extension dropped, "/" → ":"
      const name = relative(root.dir, file).replace(/\.md$/, "").split(sep).join(":");
      if (!name || seen.has(name)) continue; // project wins over user
      seen.add(name);
      const md: MarkdownCommand = {
        name,
        description: data.description ?? `custom command (${root.label})`,
        argumentHint: data["argument-hint"],
        argumentNames: (data.arguments ?? "").split(/[,\s]+/).filter(Boolean),
        body: body.trim(),
        file,
      };
      commands.push({
        name: md.name,
        description: md.description,
        argumentHint: md.argumentHint,
        source: `  [${root.label}]`,
        async run(args, host) {
          return { prompt: await expandPromptCommand(md, args, host) };
        },
      });
    }
  }
  return commands;
}

/**
 * Argument substitution, in the documented precedence order:
 *   named ($name from frontmatter) → $ARGUMENTS[i] → $1..$9 → $ARGUMENTS
 * and the graceful fallback: if nothing matched but args were given, append
 * `ARGUMENTS: …`. That last line is what makes zero-placeholder commands still
 * receive their arguments.
 */
export function substituteArguments(body: string, rawArgs: string, argumentNames: string[]): string {
  if (rawArgs === "") return body;
  const parts = shellSplit(rawArgs);
  let replaced = false;
  let out = body;

  argumentNames.forEach((name, i) => {
    const re = new RegExp(`\\$${name}\\b`, "g");
    if (re.test(out)) {
      replaced = true;
      out = out.replace(re, parts[i] ?? "");
    }
  });
  out = out.replace(/\$ARGUMENTS\[(\d+)\]/g, (_m, i) => {
    replaced = true;
    return parts[Number(i)] ?? "";
  });
  out = out.replace(/\$([1-9])\b/g, (_m, i) => {
    replaced = true;
    return parts[Number(i) - 1] ?? "";
  });
  if (out.includes("$ARGUMENTS")) {
    replaced = true;
    out = out.split("$ARGUMENTS").join(rawArgs);
  }
  if (!replaced) out = `${out}\n\nARGUMENTS: ${rawArgs}`;
  return out;
}

/** Quote-aware split, so `/cmd "two words" x` gives ["two words", "x"]. */
export function shellSplit(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out;
}

async function expandPromptCommand(md: MarkdownCommand, args: string, host: CommandHost): Promise<string> {
  let body = substituteArguments(md.body, args.trim(), md.argumentNames);

  // pass 2: literals
  body = body
    .split("${AGENT_SESSION_ID}")
    .join(host.sessionId)
    .split("${AGENT_COMMAND_DIR}")
    .join(resolve(md.file, ".."))
    .split("${CWD}")
    .join(host.cwd);

  // pass 3: embedded shell, permission-checked before each run.
  const jobs: { match: string; command: string }[] = [];
  for (const m of body.matchAll(/!`([^`\n]+)`/g)) jobs.push({ match: m[0], command: m[1] });
  for (const m of body.matchAll(/```!\n([\s\S]*?)```/g)) jobs.push({ match: m[0], command: m[1].trim() });

  for (const job of jobs) {
    const ctx = { cwd: host.cwd, todos: [], setTodos: () => {}, spillDir: "" } as any;
    const decision = host.gate.decide(bashTool, { command: job.command }, ctx);
    let allowed = decision.action === "allow";
    if (decision.action === "ask") allowed = await host.gate.prompt(bashTool, { command: job.command }, ctx, decision);
    if (!allowed) {
      body = body.split(job.match).join(`[command not run — permission denied: ${job.command}]`);
      continue;
    }
    try {
      const { stdout, stderr } = await execAsync(job.command, { cwd: host.cwd, timeout: 30_000, maxBuffer: 1024 * 1024 });
      body = body.split(job.match).join((stdout + (stderr ? `\n${stderr}` : "")).trim());
    } catch (err) {
      body = body.split(job.match).join(`[command failed: ${(err as Error).message}]`);
    }
  }
  return body;
}

// ── dispatch ─────────────────────────────────────────────────────────────────

export function parseSlashCommand(input: string): { name: string; args: string } | undefined {
  if (!input.startsWith("/")) return undefined;
  const rest = input.slice(1);
  const sp = rest.search(/\s/);
  return sp === -1 ? { name: rest, args: "" } : { name: rest.slice(0, sp), args: rest.slice(sp + 1) };
}

export class CommandRegistry {
  #byName = new Map<string, SlashCommand>();
  #ordered: SlashCommand[] = [];

  register(commands: SlashCommand[]): void {
    for (const c of commands) {
      if (this.#byName.has(c.name)) continue; // built-ins registered first, they win
      this.#byName.set(c.name, c);
      for (const a of c.aliases ?? []) if (!this.#byName.has(a)) this.#byName.set(a, c);
      this.#ordered.push(c);
    }
  }

  get(name: string): SlashCommand | undefined {
    return this.#byName.get(name);
  }

  list(): SlashCommand[] {
    return this.#ordered;
  }

  names(): string[] {
    return [...this.#byName.keys()].sort();
  }

  /** Suggest a command when the user typos one. */
  closest(name: string): string | undefined {
    const cands = this.names().filter((n) => n.startsWith(name.slice(0, 2)) || n.includes(name));
    return cands[0];
  }
}
