// permissions.ts — THE APPROVAL GATE (Ch. 7).
//
// `decide(tool, input) -> allow | ask | deny`, called before every side effect.
// Three invariants the chapter says every studied repo shares:
//   1. the gate runs BEFORE the side effect;
//   2. a denial becomes an `is_error` tool_result fed back to the model —
//      never an exception that kills the turn;
//   3. a safety floor (writes to .git/, agent config, shell rc files, anything
//      outside the workspace) prompts even when prompting is otherwise off.
//
// The rule model is opencode's, chosen in the Lean take for being ~10 lines and
// composable: ONE ordered list of {tool, pattern, action}, LAST match wins,
// default `ask`. "Always allow" is literally `rules.push({action:"allow"})`.

import * as readline from "node:readline/promises";
import type { Decision, Tool, ToolContext } from "./tools.ts";
import { isProtectedPath, resolvePath } from "./tools.ts";

export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypass";

export const PERMISSION_MODES: PermissionMode[] = ["default", "acceptEdits", "plan", "bypass"];

export interface Rule {
  /** Tool-name glob: "bash", "write", "*" */
  tool: string;
  /** Subject glob matched against the tool's permission subject; omit for "any". */
  pattern?: string;
  /** Compare `pattern` literally instead of as a glob (used by "always allow"). */
  exact?: boolean;
  action: Decision;
}

export interface GateDecision {
  action: Decision;
  /** Why — shown in the prompt and the transcript, so denials are debuggable. */
  reason: string;
  /** True when the safety floor fired; those are immune to `bypass`. */
  floor?: boolean;
}

/** Turn `a*b`-style globs into anchored regexes. `**` spans separators. */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const body = escaped.replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${body}$`);
}

function globMatch(glob: string, value: string): boolean {
  if (glob === "*" || glob === "**") return true;
  try {
    return globToRegExp(glob).test(value);
  } catch {
    return false;
  }
}

/**
 * The string a rule's `pattern` is matched against. Making this per-tool is what
 * lets one rule list cover both `bash(git push:*)` and `write(src/**)`.
 */
export function permissionSubject(tool: Tool, input: any, ctx: ToolContext): string {
  if (tool.name === "bash") return String(input?.command ?? "");
  if (typeof input?.path === "string") return resolvePath(input.path, ctx.cwd);
  return "";
}

export class PermissionGate {
  mode: PermissionMode;
  rules: Rule[];
  /** Set true by a test harness or `--yes`; the safety floor still applies. */
  autoApprove: boolean;
  /**
   * False in `--print` mode and any other run with nobody at the keyboard.
   * An `ask` then resolves to "no" immediately instead of blocking forever on
   * a prompt no one can answer — the failure mode is a clear denial the model
   * can react to, not a hung process.
   */
  interactive: boolean;

  #ask: (prompt: string) => Promise<string>;

  constructor(opts: {
    mode?: PermissionMode;
    rules?: Rule[];
    autoApprove?: boolean;
    interactive?: boolean;
    ask?: (prompt: string) => Promise<string>;
  } = {}) {
    this.mode = opts.mode ?? "default";
    this.rules = opts.rules ?? [];
    this.autoApprove = opts.autoApprove ?? false;
    this.interactive = opts.interactive ?? true;
    this.#ask = opts.ask ?? defaultAsk;
  }

  /** Ordered, last-match-wins. Returns undefined when nothing matched. */
  #matchRule(tool: Tool, subject: string): Rule | undefined {
    let hit: Rule | undefined;
    for (const r of this.rules) {
      if (!globMatch(r.tool, tool.name)) continue;
      if (r.pattern && !(r.exact ? r.pattern === subject : globMatch(r.pattern, subject))) continue;
      hit = r;
    }
    return hit;
  }

  decide(tool: Tool, input: any, ctx: ToolContext): GateDecision {
    const subject = permissionSubject(tool, input, ctx);

    // 1. Explicit deny rules win over everything, including bypass.
    const rule = this.#matchRule(tool, subject);
    if (rule?.action === "deny") {
      return { action: "deny", reason: `denied by rule ${rule.tool}(${rule.pattern ?? "*"})` };
    }

    // 2. The tool owns its own risk logic (bash sub-command analysis, protected
    //    paths). A tool-level deny is final.
    const own = tool.checkPermissions?.(input, ctx);
    if (own === "deny") return { action: "deny", reason: `${tool.name} refused this input` };

    // 3. THE SAFETY FLOOR — checked before the mode that would wave it through.
    if (!tool.readOnly && typeof input?.path === "string") {
      const abs = resolvePath(input.path, ctx.cwd);
      if (isProtectedPath(abs, ctx.cwd)) {
        return { action: "ask", reason: `protected path (${abs})`, floor: true };
      }
    }

    // 4. Read-only tools never prompt (goose SmartApprove).
    if (tool.readOnly) return { action: "allow", reason: "read-only" };

    // 5. Plan mode is a hard read-only lease over the whole session.
    if (this.mode === "plan") {
      return { action: "deny", reason: "plan mode: no side effects until you exit plan mode" };
    }

    // 6. Modes may only relax what the floor did not catch.
    if (this.mode === "bypass" || this.autoApprove) return { action: "allow", reason: `${this.mode === "bypass" ? "bypass mode" : "--yes"}` };
    if (this.mode === "acceptEdits" && (tool.name === "write" || tool.name === "edit")) {
      return { action: "allow", reason: "acceptEdits mode" };
    }
    if (rule?.action === "allow") return { action: "allow", reason: `allowed by rule ${rule.tool}(${rule.pattern ?? "*"})` };
    if (own === "allow") return { action: "allow", reason: `${tool.name} considers this safe` };

    return {
      action: "ask",
      reason: rule?.action === "ask" ? "matched an ask rule" : "no rule matched; writers ask by default",
    };
  }

  /**
   * Prompt the human. `a` appends a runtime allow rule scoped to this tool +
   * subject so the same action is not asked twice (opencode's "always").
   */
  async prompt(tool: Tool, input: any, ctx: ToolContext, decision: GateDecision): Promise<boolean> {
    const subject = permissionSubject(tool, input, ctx);
    const shown = subject || JSON.stringify(input ?? {}).slice(0, 200);
    if (!this.interactive) return false;
    const floorNote = decision.floor ? "  ⚠ safety floor: " + decision.reason : `  (${decision.reason})`;
    const answer = (
      await this.#ask(`\n  ⏵ ${tool.name}: ${shown}\n${floorNote}\n    allow? [y]es / [n]o / [a]lways / [d]eny-forever: `)
    )
      .trim()
      .toLowerCase();

    if (answer === "a" || answer === "always") {
      this.rules.push({ tool: tool.name, pattern: subject || undefined, exact: true, action: "allow" });
      return true;
    }
    if (answer === "d" || answer === "deny") {
      this.rules.push({ tool: tool.name, pattern: subject || undefined, exact: true, action: "deny" });
      return false;
    }
    return answer === "y" || answer === "yes";
  }

  describe(): string {
    const lines = [`mode: ${this.mode}${this.autoApprove ? " (auto-approve on)" : ""}`];
    if (!this.rules.length) lines.push("rules: (none — read-only tools auto-allow, writers ask)");
    else
      lines.push(
        "rules (last match wins):",
        ...this.rules.map((r, i) => `  ${i + 1}. ${r.action} ${r.tool}(${r.pattern ?? "*"})${r.exact ? " [exact]" : ""}`),
      );
    return lines.join("\n");
  }
}

async function defaultAsk(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

/** Parse `bash(git push:*)` / `write` / `deny:bash(rm*)` into a Rule. */
export function parseRule(text: string, defaultAction: Decision = "allow"): Rule | undefined {
  const m = /^(?:(allow|ask|deny):)?([A-Za-z0-9_*?]+)(?:\((.*)\))?$/.exec(text.trim());
  if (!m) return undefined;
  return { action: (m[1] as Decision) ?? defaultAction, tool: m[2], pattern: m[3] || undefined };
}
