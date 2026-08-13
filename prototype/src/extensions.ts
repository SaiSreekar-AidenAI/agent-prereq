// extensions.ts — SELF-EXTENSION (Ch. 17, the pi.dev idea).
//
// Omitting features is only safe if they are cheap to add back. So the tool
// registry — which is just an array (Ch. 3) — is rebuilt every turn from the
// built-ins plus whatever `extensions/*.ts` defines, and the agent gets a
// `reload_extensions` tool. Because it already has `write` and `edit`, it can
// author a new tool on demand and load it mid-session. That is the whole of
// "self-building": code-writing plus hot reload, no plugin marketplace.
//
// An extension module exports either:
//   export function register(pi) { pi.addTool({ ... }) }     // preferred
//   export const tools = [ { ... } ]                          // shorthand
//
// The caveat pi makes explicit and this agent does NOT follow: pi ships no
// permission system and trusts a sandbox instead. Here every extension tool
// goes through the same gate as a built-in, and `buildTool`'s fail-closed
// default means a tool that forgets to declare `readOnly` is treated as a
// writer.

import { readdir } from "node:fs/promises";
import type { Tool } from "./tools.ts";
import { buildTool } from "./tools.ts";

export interface ExtensionApi {
  addTool(tool: Partial<Tool> & Pick<Tool, "name" | "description" | "input_schema" | "run">): void;
}

export interface LoadResult {
  tools: Tool[];
  loaded: string[];
  errors: string[];
}

function looksLikeTool(t: any): boolean {
  return t && typeof t.name === "string" && typeof t.description === "string" && typeof t.run === "function";
}

export async function loadExtensions(dir: URL): Promise<LoadResult> {
  const tools: Tool[] = [];
  const loaded: string[] = [];
  const errors: string[] = [];

  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => /\.(ts|mjs|js)$/.test(f) && !f.startsWith("_")).sort();
  } catch {
    return { tools, loaded, errors }; // no extensions/ dir yet — fine
  }

  for (const f of files) {
    // Cache-bust the import URL. ESM keys the module cache on the full URL
    // including the query string, so a fresh `?t=` forces re-evaluation — that
    // is the entire hot-reload mechanism.
    const url = new URL(f, dir).href + "?t=" + Date.now() + "-" + Math.random().toString(36).slice(2);
    try {
      const mod: any = await import(url);
      const collected: any[] = [];
      const api: ExtensionApi = { addTool: (t) => collected.push(t) };
      if (typeof mod.register === "function") await mod.register(api);
      else if (Array.isArray(mod.tools)) collected.push(...mod.tools);
      else {
        errors.push(`${f}: no register() or tools[] export`);
        continue;
      }
      let added = 0;
      for (const t of collected) {
        if (!looksLikeTool(t)) {
          errors.push(`${f}: skipped a tool missing name/description/run`);
          continue;
        }
        tools.push(buildTool({ input_schema: { type: "object", properties: {} }, ...t }));
        added++;
      }
      if (added) loaded.push(f);
    } catch (err) {
      errors.push(`${f}: ${(err as Error).message}`);
    }
  }
  return { tools, loaded, errors };
}

export function describeLoad(result: LoadResult): string {
  const names = result.tools.map((t) => t.name).join(", ") || "(none)";
  const errs = result.errors.length ? ` | errors: ${result.errors.join("; ")}` : "";
  return `Loaded ${result.tools.length} extension tool(s) from ${result.loaded.length} file(s): ${names}${errs}`;
}
