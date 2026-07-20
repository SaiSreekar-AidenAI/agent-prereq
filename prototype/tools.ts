// tools.ts — the TOOL SYSTEM for the lean agent.
//
// A "tool" is the universal shape every agent framework converges on:
//   - a name + description + JSON-Schema for inputs (this is what the model sees)
//   - a run() that executes the side effect and returns text (this is what the
//     model gets back)
//   - a flag for whether the action needs human approval (the permission gate)
//
// claude-code calls this `Tool.ts`, opencode `Tool.define`, codex a Rust trait,
// goose an MCP tool. Same idea everywhere. Keep it this small.

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import * as readline from "node:readline/promises";

const execAsync = promisify(exec);

export interface ToolResult {
  content: string;
  isError?: boolean;
}

export interface Tool {
  name: string;
  description: string;
  // JSON Schema describing the tool's input. This object is sent verbatim to the
  // model as `input_schema`, so the schema IS the documentation the model reads.
  input_schema: Record<string, unknown>;
  // Side-effecting tools (bash, write) are gated behind human approval.
  needsApproval: boolean;
  run(input: any): Promise<ToolResult>;
}

// ── bash ───────────────────────────────────────────────────────────────────
export const bashTool: Tool = {
  name: "bash",
  description:
    "Run a shell command with bash and return its combined stdout/stderr. " +
    "Use for listing files, searching, and running programs.",
  input_schema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to run" },
    },
    required: ["command"],
  },
  needsApproval: true,
  async run(input) {
    const cmd = String(input?.command ?? "");
    try {
      const { stdout, stderr } = await execAsync(cmd, {
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
      });
      const out = (stdout + (stderr ? `\n[stderr]\n${stderr}` : "")).trim();
      return { content: out || "(command produced no output)" };
    } catch (err) {
      const e = err as any;
      return {
        content: `Command failed: ${e.message}\n${e.stdout ?? ""}${e.stderr ?? ""}`.trim(),
        isError: true,
      };
    }
  },
};

// ── read_file ────────────────────────────────────────────────────────────────
export const readFileTool: Tool = {
  name: "read_file",
  description: "Read a UTF-8 text file and return its full contents.",
  input_schema: {
    type: "object",
    properties: { path: { type: "string", description: "Path to the file" } },
    required: ["path"],
  },
  needsApproval: false, // reading is safe → no gate
  async run(input) {
    try {
      const text = await readFile(resolve(String(input?.path ?? "")), "utf8");
      return { content: text };
    } catch (err) {
      return { content: `Could not read file: ${(err as any).message}`, isError: true };
    }
  },
};

// ── write_file ───────────────────────────────────────────────────────────────
export const writeFileTool: Tool = {
  name: "write_file",
  description: "Write (create or overwrite) a UTF-8 text file.",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file" },
      content: { type: "string", description: "Full contents to write" },
    },
    required: ["path", "content"],
  },
  needsApproval: true,
  async run(input) {
    try {
      const body = String(input?.content ?? "");
      await writeFile(resolve(String(input?.path ?? "")), body, "utf8");
      return { content: `Wrote ${body.length} bytes to ${input?.path}` };
    } catch (err) {
      return { content: `Could not write file: ${(err as any).message}`, isError: true };
    }
  },
};

// ── edit ─────────────────────────────────────────────────────────────────────
// Targeted string replacement. The 4th of pi.dev's "four tools" (read/write/
// edit/bash) — cheaper than rewriting a whole file and how real agents edit code.
export const editTool: Tool = {
  name: "edit",
  description:
    "Edit a text file by replacing an exact string. `old_string` must appear " +
    "EXACTLY ONCE in the file; include surrounding context to make it unique.",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file" },
      old_string: { type: "string", description: "Exact text to replace (must be unique)" },
      new_string: { type: "string", description: "Replacement text" },
    },
    required: ["path", "old_string", "new_string"],
  },
  needsApproval: true,
  async run(input) {
    try {
      const p = resolve(String(input?.path ?? ""));
      const oldS = String(input?.old_string ?? "");
      const before = await readFile(p, "utf8");
      const hits = oldS === "" ? 0 : before.split(oldS).length - 1;
      if (hits === 0) return { content: `old_string not found in ${input?.path}`, isError: true };
      if (hits > 1)
        return { content: `old_string appears ${hits}x in ${input?.path}; add context to disambiguate`, isError: true };
      await writeFile(p, before.replace(oldS, String(input?.new_string ?? "")), "utf8");
      return { content: `Edited ${input?.path} (1 replacement)` };
    } catch (err) {
      return { content: `Could not edit file: ${(err as any).message}`, isError: true };
    }
  },
};

// ── the registry ─────────────────────────────────────────────────────────────
// The built-in tools. The whole "tool registry" is a list; the agent merges
// extension-provided tools onto it at runtime (see extensions.ts + agent.ts).
export const BUILTIN_TOOLS: Tool[] = [bashTool, readFileTool, writeFileTool, editTool];

// ── the approval gate ────────────────────────────────────────────────────────
// Ask the human on stdin before a side-effecting tool runs. Real agents add an
// allowlist / "always allow this" memory here — that is the only elaboration.
export async function approve(toolName: string, input: unknown): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`\n  ↳ allow ${toolName}(${JSON.stringify(input)})? [y/N] `);
  rl.close();
  return answer.trim().toLowerCase().startsWith("y");
}
