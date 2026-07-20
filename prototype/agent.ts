// agent.ts — THE LOOP. This is the whole idea behind every coding agent.
//
// while not done:
//   response = model(system, tools, messages)   # ask the model
//   messages += assistant(response)             # remember what it said
//   if no tool calls: break                     # it's finished
//   for each tool call: run it                  # do the work
//   messages += user(tool results)              # feed results back
//
// Everything else in claude-code / opencode / codex / goose — streaming,
// context compaction, sub-agents, MCP, sandboxes, TUIs — is an elaboration of
// these ~15 lines. Read `docs/BLUEPRINT.md` for which elaborations are worth it.
//
// This version is also SELF-EXTENSIBLE (the pi.dev idea, Ch. 17): the tool list
// is rebuilt every turn from BUILTIN_TOOLS + whatever extensions/ defines, and a
// `reload_extensions` tool lets the agent load tools it just wrote itself.
//
// Run:  node agent.ts "list the files here, then read package.json"
//   real mode : export ANTHROPIC_API_KEY=sk-...   (optional: ANTHROPIC_MODEL)
//   mock mode : (no key)  → scripted demo of the loop; say "extension" to see
//               the agent write a tool and hot-load it
//   flags     : --yes / AUTO_APPROVE=1  → skip the approval prompt

import { fileURLToPath } from "node:url";
import { BUILTIN_TOOLS, approve } from "./tools.ts";
import type { Tool } from "./tools.ts";
import { loadExtensions } from "./extensions.ts";

// ── message types (the Anthropic Messages API shape) ─────────────────────────
interface TextBlock { type: "text"; text: string; }
interface ToolUseBlock { type: "tool_use"; id: string; name: string; input: any; }
interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}
type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;
interface Message { role: "user" | "assistant"; content: string | ContentBlock[]; }
interface ModelResponse { content: ContentBlock[]; stop_reason: string; }

// ── DYNAMIC TOOL REGISTRY ────────────────────────────────────────────────────
// The registry is rebuilt from three sources: the built-ins, the reload tool,
// and the extension-provided tools (which change when reload runs). Because the
// tool array is recomputed every turn, a tool the agent writes and loads becomes
// usable on the very next model call — that is the whole self-extension trick.
const EXT_DIR = new URL("./extensions/", import.meta.url);
let extTools: Tool[] = [];

async function reload(): Promise<string> {
  const { tools, loaded, errors } = await loadExtensions(EXT_DIR);
  extTools = tools;
  const names = tools.map((t) => t.name).join(", ") || "(none)";
  const errNote = errors.length ? ` | errors: ${errors.join("; ")}` : "";
  return `Loaded ${tools.length} extension tool(s) from ${loaded.length} file(s): ${names}${errNote}`;
}

const reloadTool: Tool = {
  name: "reload_extensions",
  description:
    "Re-scan the extensions/ directory and (re)load every tool defined there. " +
    "Call this right after writing or editing an extension file to make its tools usable.",
  input_schema: { type: "object", properties: {} },
  needsApproval: false,
  run: async () => ({ content: await reload() }),
};

function allTools(): Tool[] { return [...BUILTIN_TOOLS, reloadTool, ...extTools]; }
function toolByName(name: string): Tool | undefined {
  return allTools().find((t) => t.name === name);
}

// ── PROMPT CONSTRUCTION ──────────────────────────────────────────────────────
// Tool *descriptions* travel in the `tools` field, not here. Real agents also
// inject CLAUDE.md/AGENTS.md and the environment (Ch. 5, 9).
const SYSTEM =
  "You are a minimal, self-extensible coding agent in a terminal. Core tools: " +
  "bash, read_file, write_file, edit. You can also EXTEND YOURSELF: write a " +
  "TypeScript file into ./extensions/ that exports `register(pi){ pi.addTool(...) }`, " +
  "then call reload_extensions to load its tools and use them in the same session. " +
  "Work step by step; when the task is done, reply with a short summary and STOP " +
  "calling tools.\n" +
  `Working directory: ${process.cwd()}`;

// ── MODEL / PROVIDER I/O ─────────────────────────────────────────────────────
// One non-streaming POST. Swapping this for an OpenAI/Gemini/Ollama adapter
// (translating to/from this same block shape) is how openclaude and goose go
// multi-provider. Streaming is a v1 concern (see BLUEPRINT).
async function callAnthropic(system: string, messages: Message[], tools: Tool[]): Promise<ModelResponse> {
  const model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system,
      // The registry, rendered into what the model sees (rebuilt every turn):
      tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
      messages,
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as any;
  return { content: data.content, stop_reason: data.stop_reason };
}

// The extension the mock "writes" to demonstrate self-building.
const SHOUT_EXT = `export function register(pi) {
  pi.addTool({
    name: "shout",
    description: "Return the given text in UPPERCASE.",
    input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    needsApproval: false,
    async run(input) { return { content: String(input?.text ?? "").toUpperCase() }; },
  });
}
`;
const SHOUT_PATH = fileURLToPath(new URL("shout.ts", EXT_DIR));

// Mock model: scripted so you can watch the loop with no API key. If the task
// mentions extensions/self-build, it demonstrates the agent WRITING a tool and
// hot-loading it; otherwise it does a one-tool `ls` demo. Steps advance by
// counting how many tool-result turns have come back.
function toolResultTurns(messages: Message[]): number {
  return messages.filter(
    (m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result"),
  ).length;
}

async function callMock(_system: string, messages: Message[], _tools: Tool[]): Promise<ModelResponse> {
  const first = typeof messages[0]?.content === "string" ? (messages[0].content as string) : "";
  const selfBuild = /extension|self.?build|shout|write .*tool|build .*tool/i.test(first);
  const step = toolResultTurns(messages);
  const mk = (text: string, tu?: ToolUseBlock): ModelResponse => ({
    stop_reason: tu ? "tool_use" : "end_turn",
    content: tu ? [{ type: "text", text }, tu] : [{ type: "text", text }],
  });

  if (selfBuild) {
    if (step === 0)
      return mk("[mock] I'll build a `shout` tool, then load it.",
        { type: "tool_use", id: "m1", name: "write_file", input: { path: SHOUT_PATH, content: SHOUT_EXT } });
    if (step === 1)
      return mk("[mock] Loading the tool I just wrote.",
        { type: "tool_use", id: "m2", name: "reload_extensions", input: {} });
    if (step === 2)
      return mk("[mock] Using my new tool.",
        { type: "tool_use", id: "m3", name: "shout", input: { text: "hello from a tool I just wrote" } });
    return mk("[mock] Self-extension demo complete: wrote extensions/shout.ts, hot-loaded it, and used it.");
  }

  if (step === 0)
    return mk("[mock] Demonstrating the loop: I'll list the directory.",
      { type: "tool_use", id: "m1", name: "bash", input: { command: "ls -la" } });
  return mk("[mock] Saw the tool result and stopped. Set ANTHROPIC_API_KEY to use a real model.");
}

// ── THE AGENT LOOP ───────────────────────────────────────────────────────────
async function run(task: string): Promise<void> {
  const useMock = !process.env.ANTHROPIC_API_KEY;
  const callModel = useMock ? callMock : callAnthropic;
  const skipApproval =
    useMock || process.env.AUTO_APPROVE === "1" || process.argv.includes("--yes");

  if (useMock) console.log("⚠️  No ANTHROPIC_API_KEY — MOCK mode (scripted demo).\n");
  console.log("🧩 " + (await reload()));          // load extensions at startup
  console.log(`👤 ${task}`);

  const messages: Message[] = [{ role: "user", content: task }];
  const MAX_TURNS = 20; // a guard rail; real agents stop on token budget instead

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await callModel(SYSTEM, messages, allTools());
    messages.push({ role: "assistant", content: response.content });

    for (const block of response.content) {
      if (block.type === "text" && block.text.trim()) console.log(`\n🤖 ${block.text}`);
    }

    // EXIT TEST — the most load-bearing lesson from the study (see
    // docs/comparison.md): the reliable stop signal is "the assistant made NO
    // tool calls", not the provider's `stop_reason`. Four of five studied repos
    // distrust stop_reason (it can be max_tokens / pause_turn mid-work).
    const toolUses = response.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
    if (toolUses.length === 0) {
      console.log("\n✅ Done.");
      return;
    }

    // Execute every tool call the model made this turn, gather the results.
    const results: ToolResultBlock[] = [];
    for (const block of toolUses) {
      console.log(`\n🔧 ${block.name}(${JSON.stringify(block.input)})`);

      const tool = toolByName(block.name);
      if (!tool) {
        results.push({ type: "tool_result", tool_use_id: block.id, content: `Unknown tool: ${block.name}`, is_error: true });
        continue;
      }
      // PERMISSION GATE — the only thing standing between the model and your shell.
      if (tool.needsApproval && !skipApproval && !(await approve(block.name, block.input))) {
        results.push({ type: "tool_result", tool_use_id: block.id, content: "User denied this action.", is_error: true });
        continue;
      }
      const out = await tool.run(block.input);
      console.log("   " + (out.content.length > 600 ? out.content.slice(0, 600) + "\n   …(truncated)" : out.content.replace(/\n/g, "\n   ")));
      results.push({ type: "tool_result", tool_use_id: block.id, content: out.content, is_error: out.isError });
    }

    // Feed the tool results back as the next user turn, then loop.
    messages.push({ role: "user", content: results });
  }
  console.log(`\n⏹️  Hit max turns (${MAX_TURNS}).`);
}

// ── CLI entry ────────────────────────────────────────────────────────────────
const task = process.argv.slice(2).filter((a) => !a.startsWith("--")).join(" ").trim();
if (!task) {
  console.error('Usage: node agent.ts "<your task>" [--yes]');
  console.error("  env: ANTHROPIC_API_KEY (real mode), ANTHROPIC_MODEL, AUTO_APPROVE=1");
  console.error('  try: node agent.ts "build a shout extension and use it"   (mock self-build demo)');
  process.exit(1);
}
run(task).catch((e) => { console.error("Fatal:", e.message); process.exit(1); });
