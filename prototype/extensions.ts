// extensions.ts — the self-extension loader. This is what lets the harness
// "build itself" (the pi.dev idea): drop a .ts file in extensions/ and its tools
// become the agent's tools. Because the agent already has write_file + edit, it
// can author those files itself, then call reload_extensions to hot-load them
// mid-session — no restart, no plugin marketplace.
//
// An extension is a .ts module exporting EITHER:
//   export function register(pi) { pi.addTool({ ... }) }   // preferred
//   export const tools = [ { ... }, { ... } ]              // shorthand
// where each tool is the same {name, description, input_schema, needsApproval,
// run} shape as a built-in (see tools.ts).

import { readdir } from "node:fs/promises";
import type { Tool } from "./tools.ts";

export interface PiApi {
  addTool(tool: Tool): void;
}

export interface LoadResult {
  tools: Tool[];
  loaded: string[];
  errors: string[];
}

export async function loadExtensions(dir: URL): Promise<LoadResult> {
  const tools: Tool[] = [];
  const loaded: string[] = [];
  const errors: string[] = [];

  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".ts")).sort();
  } catch {
    return { tools, loaded, errors }; // no extensions/ dir yet — that's fine
  }

  for (const f of files) {
    // Cache-bust the import URL so re-running the loader picks up files created
    // or edited during THIS session. ESM caches modules by full URL including the
    // query string, so a fresh `?t=` forces re-evaluation — this is the hot-reload.
    const url = new URL(f, dir).href + "?t=" + Date.now();
    try {
      const mod: any = await import(url);
      const api: PiApi = { addTool: (t) => tools.push(t) };
      if (typeof mod.register === "function") mod.register(api);
      else if (Array.isArray(mod.tools)) for (const t of mod.tools) tools.push(t);
      else {
        errors.push(`${f}: no register() or tools[] export`);
        continue;
      }
      loaded.push(f);
    } catch (err) {
      errors.push(`${f}: ${(err as any).message}`);
    }
  }
  return { tools, loaded, errors };
}
