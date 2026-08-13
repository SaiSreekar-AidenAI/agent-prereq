// e2e.ts — the test suite.  Run with:  node test/e2e.ts
//
// Two layers:
//
//   UNIT        the pieces the chapters say are load-bearing — the pairing
//               invariant, the exit test, schema validation, the permission
//               gate and its safety floor, compaction's rebuild, the session
//               round-trip, argument substitution.
//
//   END-TO-END  the real binary, spawned as a child process, talking real HTTP
//               and real SSE to test/fake-provider.ts — once in the Anthropic
//               wire format and once in the OpenAI one, from the same agent
//               build with nothing but env vars changed. That is the claim
//               "provider-agnostic above one seam", checked rather than
//               asserted.
//
// No API keys, no network beyond loopback.

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { startFakeProvider } from "./fake-provider.ts";
import type { FakeProvider, ScriptedTurn } from "./fake-provider.ts";

import { backfillMissingToolResults, toolUsesIn, userText } from "../src/types.ts";
import type { Message } from "../src/types.ts";
import { partitionBySafety, validateInput, estimateCost, emptyUsage } from "../src/loop.ts";
import { PermissionGate, parseRule } from "../src/permissions.ts";
import { BUILTIN_TOOLS, bashTool, readTool, writeTool, capAndSpill, isProtectedPath, splitSubcommands } from "../src/tools.ts";
import type { Tool, ToolContext } from "../src/tools.ts";
import { approxTokens, compact, shouldCompact } from "../src/context.ts";
import { substituteArguments, shellSplit, parseSlashCommand } from "../src/commands.ts";
import { SessionStore, listSessions, loadSession, forkSession } from "../src/session.ts";
import { providerForModel, resolveProvider } from "../src/config.ts";
import { buildSystemPrompt, buildMemoryReminder } from "../src/prompt.ts";
import { createMockProvider } from "../src/mock.ts";

const AGENT = fileURLToPath(new URL("../agent.ts", import.meta.url));

// ── the world's smallest test runner ─────────────────────────────────────────

let passed = 0;
const failures: string[] = [];
let currentSuite = "";

function suite(name: string): void {
  currentSuite = name;
  process.stdout.write(`\n${name}\n`);
}

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (err) {
    failures.push(`${currentSuite} › ${name}\n      ${(err as Error).message}`);
    process.stdout.write(`  ✗ ${name}\n      ${(err as Error).message}\n`);
  }
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

function assertEqual(actual: unknown, expected: unknown, message = ""): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message}\n      expected ${b}\n      actual   ${a}`);
}

function assertIncludes(haystack: string, needle: string, message = ""): void {
  if (!haystack.includes(needle)) {
    throw new Error(`${message || "missing substring"}: ${JSON.stringify(needle)}\n      in: ${haystack.slice(0, 900)}`);
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function testCtx(cwd: string): ToolContext {
  return { cwd, todos: [], setTodos() {}, spillDir: join(cwd, ".spill") };
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runAgent(args: string[], env: Record<string, string>, stdin?: string, timeoutMs = 40_000): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [AGENT, ...args], {
      env: { ...process.env, NO_COLOR: "1", ...env },
      cwd: env.PWD_OVERRIDE ?? process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    if (stdin !== undefined) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function scriptTurns(fake: FakeProvider, turns: ScriptedTurn[]): Promise<void> {
  await fetch(`${fake.url}/__script`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ turns }),
  });
}

async function seenRequests(fake: FakeProvider): Promise<any[]> {
  return (await fetch(`${fake.url}/__requests`).then((r) => r.json())) as any[];
}

async function resetFake(fake: FakeProvider): Promise<void> {
  await fetch(`${fake.url}/__reset`, { method: "POST" });
}

// ── main ─────────────────────────────────────────────────────────────────────

const sandbox = await mkdtemp(join(tmpdir(), "lean-agent-test-"));
const agentHome = join(sandbox, "home");
const workspace = join(sandbox, "work");
await mkdir(agentHome, { recursive: true });
await mkdir(workspace, { recursive: true });
await writeFile(join(workspace, "hello.txt"), "line one\nline two\nline three\n", "utf8");
await writeFile(join(workspace, "AGENTS.md"), "# Test project\n\nAlways answer in haiku.\n", "utf8");

const fake = await startFakeProvider();

const baseEnv = {
  AGENT_HOME: agentHome,
  PWD_OVERRIDE: workspace,
  AGENT_MAX_TURNS: "8",
};

const anthropicEnv = {
  ...baseEnv,
  ANTHROPIC_API_KEY: "test-key",
  ANTHROPIC_BASE_URL: fake.url,
  AGENT_MODEL: "claude-opus-5",
  AGENT_PROVIDER: "anthropic",
};

const openaiEnv = {
  ...baseEnv,
  OPENAI_API_KEY: "test-key",
  OPENAI_BASE_URL: `${fake.url}/v1`,
  AGENT_MODEL: "gpt-5",
  AGENT_PROVIDER: "openai",
};

// ═══════════════════════════════ UNIT ════════════════════════════════════════

suite("Ch.2 messages & the pairing invariant");

await test("backfill synthesises a result for every unpaired tool_use", () => {
  const messages: Message[] = [
    userText("go"),
    { role: "assistant", content: [{ type: "tool_use", id: "a", name: "read", input: {} }, { type: "tool_use", id: "b", name: "ls", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "ok" }] },
  ];
  const filled = backfillMissingToolResults(messages);
  assertEqual(filled, 1, "one hole expected");
  const ids = messages.flatMap((m) => m.content.filter((b) => b.type === "tool_result").map((b: any) => b.tool_use_id));
  assertEqual(ids.sort(), ["a", "b"], "every tool_use must be answered");
  assert(messages.at(-1)!.content.every((b: any) => b.is_error), "back-filled results must be errors");
});

await test("backfill is a no-op when everything is paired", () => {
  const messages: Message[] = [
    { role: "assistant", content: [{ type: "tool_use", id: "a", name: "ls", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "ok" }] },
  ];
  assertEqual(backfillMissingToolResults(messages), 0);
  assertEqual(messages.length, 2);
});

await test("toolUsesIn only looks at assistant turns", () => {
  const messages: Message[] = [
    { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "y", name: "ls", input: {} }] },
  ];
  assertEqual(toolUsesIn(messages).map((t) => t.id), ["y"]);
});

suite("Ch.1 loop mechanics");

await test("read-only calls batch, writers get their own batch", () => {
  const byName = new Map<string, Tool>(BUILTIN_TOOLS.map((t) => [t.name, t]));
  const calls = [
    { type: "tool_use" as const, id: "1", name: "read", input: {} },
    { type: "tool_use" as const, id: "2", name: "grep", input: {} },
    { type: "tool_use" as const, id: "3", name: "write", input: {} },
    { type: "tool_use" as const, id: "4", name: "ls", input: {} },
  ];
  const batches = partitionBySafety(calls, byName, 8);
  assertEqual(batches.map((b) => b.map((c) => c.id)), [["1", "2"], ["3"], ["4"]]);
});

await test("concurrency cap splits a long read-only run", () => {
  const byName = new Map<string, Tool>(BUILTIN_TOOLS.map((t) => [t.name, t]));
  const calls = Array.from({ length: 5 }, (_, i) => ({ type: "tool_use" as const, id: String(i), name: "read", input: {} }));
  assertEqual(partitionBySafety(calls, byName, 2).map((b) => b.length), [2, 2, 1]);
});

await test("schema validation catches the mistakes models actually make", () => {
  const schema = { type: "object", properties: { path: { type: "string" }, limit: { type: "integer" } }, required: ["path"] };
  assertEqual(validateInput({ path: "a.ts" }, schema), undefined);
  assertIncludes(validateInput({}, schema) ?? "", 'missing required property "path"');
  assertIncludes(validateInput({ path: 3 }, schema) ?? "", '"path" must be a string');
  assertIncludes(validateInput({ path: "a", limit: 1.5 }, schema) ?? "", '"limit" must be an integer');
  assertIncludes(validateInput("nope", schema) ?? "", "expected an object");
});

await test("enum violations are reported", () => {
  const schema = { type: "object", properties: { status: { type: "string", enum: ["a", "b"] } } };
  assertIncludes(validateInput({ status: "c" }, schema) ?? "", "must be one of: a, b");
});

suite("Ch.7 the permission gate");

await test("read-only tools are auto-allowed", () => {
  const gate = new PermissionGate();
  assertEqual(gate.decide(readTool, { path: "x" }, testCtx(workspace)).action, "allow");
});

await test("a known-safe shell command is allowed; an unknown one asks", () => {
  const gate = new PermissionGate();
  assertEqual(gate.decide(bashTool, { command: "ls -la" }, testCtx(workspace)).action, "allow");
  assertEqual(gate.decide(bashTool, { command: "git status" }, testCtx(workspace)).action, "allow");
  assertEqual(gate.decide(bashTool, { command: "npm publish" }, testCtx(workspace)).action, "ask");
  assertEqual(gate.decide(bashTool, { command: "git push origin main" }, testCtx(workspace)).action, "ask");
});

await test("destructive commands are denied outright", () => {
  const gate = new PermissionGate({ mode: "bypass" });
  assertEqual(gate.decide(bashTool, { command: "rm -rf /" }, testCtx(workspace)).action, "deny");
});

await test("a safe head with a redirect is treated as a writer", () => {
  const gate = new PermissionGate();
  assertEqual(gate.decide(bashTool, { command: "echo hi > out.txt" }, testCtx(workspace)).action, "ask");
});

await test("sub-commands are split on shell sequencing operators", () => {
  assertEqual(splitSubcommands("cat a && rm -rf b | tee c"), ["cat a", "rm -rf b", "tee c"]);
});

await test("the safety floor survives bypass mode", () => {
  const gate = new PermissionGate({ mode: "bypass" });
  const d = gate.decide(writeTool, { path: join(workspace, ".git", "config") }, testCtx(workspace));
  assertEqual(d.action, "ask", "writes into .git must always prompt");
  assert(d.floor, "the decision should be flagged as the safety floor");
});

await test("writing outside the workspace hits the floor", () => {
  const gate = new PermissionGate({ mode: "bypass" });
  const d = gate.decide(writeTool, { path: "/etc/passwd" }, testCtx(workspace));
  assertEqual(d.action, "ask");
  assert(isProtectedPath("/etc/passwd", workspace), "outside-workspace paths are protected");
});

await test("plan mode denies every writer but keeps reads", () => {
  const gate = new PermissionGate({ mode: "plan" });
  assertEqual(gate.decide(writeTool, { path: join(workspace, "a.txt") }, testCtx(workspace)).action, "deny");
  assertEqual(gate.decide(readTool, { path: "a.txt" }, testCtx(workspace)).action, "allow");
});

await test("an ordinary in-workspace write asks in default mode", () => {
  // A tool-level checkPermissions must only escalate; if it returned "allow"
  // here, every edit would silently bypass the default-ask.
  const gate = new PermissionGate();
  assertEqual(gate.decide(writeTool, { path: join(workspace, "a.txt") }, testCtx(workspace)).action, "ask");
});

await test("acceptEdits allows edits but not shell", () => {
  const gate = new PermissionGate({ mode: "acceptEdits" });
  assertEqual(gate.decide(writeTool, { path: join(workspace, "a.txt") }, testCtx(workspace)).action, "allow");
  assertEqual(gate.decide(bashTool, { command: "npm publish" }, testCtx(workspace)).action, "ask");
});

await test("last matching rule wins", () => {
  const gate = new PermissionGate({
    rules: [
      { tool: "bash", action: "allow" },
      { tool: "bash", pattern: "npm publish*", action: "deny" },
    ],
  });
  assertEqual(gate.decide(bashTool, { command: "npm test" }, testCtx(workspace)).action, "allow");
  assertEqual(gate.decide(bashTool, { command: "npm publish --tag x" }, testCtx(workspace)).action, "deny");
});

await test("rule syntax parses", () => {
  assertEqual(parseRule("bash(git *)"), { action: "allow", tool: "bash", pattern: "git *" });
  assertEqual(parseRule("deny:write"), { action: "deny", tool: "write", pattern: undefined });
  assertEqual(parseRule("!!!"), undefined);
});

await test('"always allow" appends an exact rule and stops asking', async () => {
  const gate = new PermissionGate({ ask: async () => "a" });
  const ctx = testCtx(workspace);
  const first = gate.decide(bashTool, { command: "npm publish" }, ctx);
  assertEqual(first.action, "ask");
  assert(await gate.prompt(bashTool, { command: "npm publish" }, ctx, first), "should be allowed");
  assertEqual(gate.decide(bashTool, { command: "npm publish" }, ctx).action, "allow");
  assertEqual(gate.decide(bashTool, { command: "npm publish --other" }, ctx).action, "ask", "the rule is exact, not a prefix");
});

suite("Ch.3 tools");

await test("read numbers lines and honours offset/limit", async () => {
  const r = await readTool.run({ path: join(workspace, "hello.txt"), offset: 2, limit: 1 }, testCtx(workspace));
  assertIncludes(r.content, "2\tline two");
  assert(!r.content.includes("line one"), "offset should skip line one");
});

await test("edit refuses an ambiguous match and accepts replace_all", async () => {
  const file = join(workspace, "dup.txt");
  await writeFile(file, "x\nx\n", "utf8");
  const { editTool } = await import("../src/tools.ts");
  const bad = await editTool.run({ path: file, old_string: "x", new_string: "y" }, testCtx(workspace));
  assert(bad.isError, "ambiguous edit must fail");
  assertIncludes(bad.content, "appears 2");
  const ok = await editTool.run({ path: file, old_string: "x", new_string: "y", replace_all: true }, testCtx(workspace));
  assert(!ok.isError, ok.content);
  assertEqual(await readFile(file, "utf8"), "y\ny\n");
});

await test("oversized tool output spills to disk and leaves a pointer", async () => {
  const ctx = testCtx(workspace);
  const big = "A".repeat(5000);
  const capped = await capAndSpill({ content: big }, 500, ctx, "bash");
  assert(capped.content.length < big.length, "should be shorter");
  assertIncludes(capped.content, "characters elided");
  const m = /written to (\S+)/.exec(capped.content);
  assert(m, "should name the spill file");
  assertEqual((await readFile(m![1], "utf8")).length, 5000, "the full output is on disk");
});

await test("tool errors are results, not throws", async () => {
  const r = await readTool.run({ path: join(workspace, "nope.txt") }, testCtx(workspace));
  assert(r.isError, "missing file should be an error result");
  assertIncludes(r.content, "Could not read");
});

suite("Ch.6 context & compaction");

await test("the byte heuristic and the threshold agree with the chapter", () => {
  assertEqual(approxTokens("abcd"), 1);
  assertEqual(approxTokens("abcde"), 2);
  assert(shouldCompact(81, 100, 0.8), "81/100 at ratio 0.8 should compact");
  assert(!shouldCompact(79, 100, 0.8), "79/100 should not");
});

await test("compaction rebuilds history and hides — does not delete", async () => {
  const provider = {
    id: "stub",
    label: "stub",
    model: "stub",
    contextWindow: 1000,
    async *stream() {
      yield { type: "text-delta" as const, text: "<summary>the work so far</summary>" };
    },
  };
  const messages: Message[] = [
    userText("first request"),
    { role: "assistant", content: [{ type: "tool_use", id: "t", name: "ls", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "a b c" }] },
    userText("second request"),
  ];
  const before = messages.length;
  const r = await compact(messages, provider as any, buildSystemPrompt({ cwd: workspace, platform: "test", today: "2026-01-01", model: "stub", permissionMode: "default" }), {
    ratio: 0.8,
    recentBudget: 20_000,
  });
  assertIncludes(r.summary, "the work so far");
  assertEqual(r.messages.slice(0, before).every((m) => m.agentVisible === false), true, "old turns hidden, not removed");
  const visible = r.messages.filter((m) => m.agentVisible !== false);
  assertIncludes(JSON.stringify(visible), "the work so far");
  assertIncludes(JSON.stringify(visible), "second request");
  assert(!JSON.stringify(visible).includes("tool_result"), "no orphan tool_result may survive compaction");
  assertEqual(visible.length, 3, "rebuilt history is [summary] + the preserved user turns");
  assertEqual((visible.at(-1)!.content[0] as any).text, "second request", "the latest user turn is preserved verbatim and last");
});

suite("Ch.9 memory & Ch.5 prompt layout");

await test("the system prompt splits into a cacheable prefix and a dynamic suffix", () => {
  const sp = buildSystemPrompt({ cwd: "/w", platform: "linux", today: "2026-01-01", model: "m", permissionMode: "default" });
  assertIncludes(sp.cacheablePrefix, "coding agent running in a terminal");
  assert(!sp.cacheablePrefix.includes("/w"), "cwd must not be in the cached prefix");
  assertIncludes(sp.dynamicSuffix, "Working directory: /w");
});

await test("plan mode is stated in the prompt, not just enforced in code", () => {
  const sp = buildSystemPrompt({ cwd: "/w", platform: "linux", today: "d", model: "m", permissionMode: "plan" });
  assertIncludes(sp.dynamicSuffix, "PLAN MODE IS ON");
});

await test("memory rides in a user message with the hedge", () => {
  const m = buildMemoryReminder("project rules here");
  assert(m, "should build a message");
  assertEqual(m!.role, "user");
  assertIncludes((m!.content[0] as any).text, "<system-reminder>");
  assertIncludes((m!.content[0] as any).text, "may or may not be relevant");
  assertEqual(buildMemoryReminder(""), undefined);
});

suite("Ch.11 slash & custom commands");

await test("slash parsing splits name from args", () => {
  assertEqual(parseSlashCommand("/compact focus on the parser"), { name: "compact", args: "focus on the parser" });
  assertEqual(parseSlashCommand("/help"), { name: "help", args: "" });
  assertEqual(parseSlashCommand("not a command"), undefined);
});

await test("argument substitution follows the documented precedence", () => {
  assertEqual(substituteArguments("scope=$1 all=$ARGUMENTS", "auth login", []), "scope=auth all=auth login");
  assertEqual(substituteArguments("named $topic", "caching", ["topic"]), "named caching");
  assertEqual(substituteArguments("index $ARGUMENTS[1]", "a b", []), "index b");
});

await test("a command with no placeholder still receives its arguments", () => {
  assertEqual(substituteArguments("do the thing", "with this", []), "do the thing\n\nARGUMENTS: with this");
  assertEqual(substituteArguments("do the thing", "", []), "do the thing");
});

await test("the splitter is quote-aware", () => {
  assertEqual(shellSplit(`a "two words" 'three'`), ["a", "two words", "three"]);
});

suite("Ch.15 sessions");

await test("append, list, load round-trips", async () => {
  process.env.AGENT_HOME = agentHome;
  const store = await SessionStore.create({ cwd: workspace, provider: "anthropic", model: "claude-opus-5" });
  store.addMessage(userText("remember this"));
  store.addMessage({ role: "assistant", content: [{ type: "text", text: "ok" }] });
  store.addTodos([{ content: "step one", status: "in_progress" }]);
  await store.flush();

  const sessions = await listSessions(workspace);
  assert(sessions.length >= 1, "session should be listed");
  const found = sessions.find((s) => s.id === store.meta.id);
  assert(found, "our session should be in the list");
  assertEqual(found!.title, "remember this", "title derives from the first user message");

  const loaded = await loadSession(workspace, store.meta.id.slice(0, 8));
  assert(loaded, "prefix resume should work");
  assertEqual(loaded!.messages.length, 2);
  assertEqual(loaded!.todos.length, 1);
});

await test("fork copies a prefix into a fresh id", async () => {
  const store = await SessionStore.create({ cwd: workspace, provider: "anthropic", model: "claude-opus-5" });
  store.addMessage(userText("one"));
  store.addMessage({ role: "assistant", content: [{ type: "text", text: "a" }] });
  store.addMessage(userText("two"));
  await store.flush();

  const forked = await forkSession(workspace, store.meta.id, 1);
  assert(forked, "fork should succeed");
  assert(forked!.store.meta.id !== store.meta.id, "fork gets a new id");
  assertEqual(forked!.store.meta.forkedFrom, store.meta.id);
  assertEqual(forked!.loaded.messages.length, 2, "cut before the second user message");
});

await test("a torn final line does not lose the session", async () => {
  const store = await SessionStore.create({ cwd: workspace, provider: "anthropic", model: "m" });
  store.addMessage(userText("intact"));
  await store.flush();
  await writeFile(store.file, (await readFile(store.file, "utf8")) + '{"type":"mess', "utf8");
  const loaded = await loadSession(workspace, store.meta.id);
  assert(loaded, "should still parse");
  assertEqual(loaded!.messages.length, 1);
});

suite("Ch.4 provider selection");

await test("the provider is inferred from the model name", () => {
  assertEqual(providerForModel("claude-opus-5"), "anthropic");
  assertEqual(providerForModel("gpt-5"), "openai");
  assertEqual(providerForModel("o3-mini"), "openai");
  assertEqual(providerForModel("anthropic/claude-opus-5"), "openrouter");
  assertEqual(providerForModel("llama3"), undefined);
});

await test("a base URL as the provider means OpenAI-compatible", () => {
  const p = resolveProvider({ provider: "http://localhost:1234/v1/", model: "local-llama" });
  assertEqual(p.id, "openai-compatible");
  assertEqual(p.baseUrl, "http://localhost:1234/v1");
});

await test("newer OpenAI models get max_completion_tokens", () => {
  assertEqual(resolveProvider({ model: "gpt-5" }).usesMaxCompletionTokens, true);
  assertEqual(resolveProvider({ model: "claude-opus-5" }).usesMaxCompletionTokens, false);
});

await test("cost is estimated only where a price is known", () => {
  const u = { ...emptyUsage(), input: 1_000_000, output: 1_000_000 };
  assertEqual(estimateCost(u, { input: 5, output: 25 }), 30);
  assertEqual(estimateCost(u, undefined), undefined);
});

await test("the mock provider emits the canonical event union", async () => {
  const provider = createMockProvider();
  const events: string[] = [];
  for await (const ev of provider.stream({
    system: { cacheablePrefix: "x", dynamicSuffix: "" },
    messages: [userText("list the files here")],
    tools: [{ name: "ls", description: "", input_schema: {} }],
    maxTokens: 100,
  })) {
    events.push(ev.type);
  }
  assert(events.includes("text-delta"), "should stream text");
  assert(events.includes("block-end"), "should close blocks");
  assert(events.includes("finish"), "should finish");
});

// ═══════════════════════════ END-TO-END ══════════════════════════════════════

suite("end-to-end: Anthropic wire format");

await test("tool call → result → final answer, over real SSE", async () => {
  await resetFake(fake);
  await scriptTurns(fake, [
    { text: "Reading the file.", tools: [{ name: "read", input: { path: "hello.txt" } }] },
    { text: "The file has three lines." },
  ]);
  const r = await runAgent(["-p", "how many lines in hello.txt?"], anthropicEnv);
  assertEqual(r.code, 0, `exit code; stderr: ${r.stderr}`);
  assertIncludes(r.stdout, "The file has three lines.");
  assertIncludes(r.stdout, "line two", "the tool actually ran and its output was shown");
});

await test("the request carries a cached system prefix, sorted tools, and paired results", async () => {
  const reqs = await seenRequests(fake);
  assert(reqs.length >= 2, `expected two model calls, saw ${reqs.length}`);
  const first = reqs[0].body;
  assertEqual(first.system[0].cache_control, { type: "ephemeral" }, "the static prefix carries the breakpoint");
  assert(first.system[1].cache_control === undefined, "the dynamic suffix must NOT be cached");
  assertIncludes(first.system[1].text, "Working directory:");
  const names = first.tools.map((t: any) => t.name);
  assertEqual(names, [...names].sort(), "tool schemas must be sorted for cache stability");
  assert(first.tools.every((t: any) => t.input_schema), "tools carry input_schema");
  assert(first.temperature === undefined, "no sampling params for current Claude models");

  const second = reqs[1].body;
  const results = second.messages.flatMap((m: any) => (Array.isArray(m.content) ? m.content : [])).filter((b: any) => b.type === "tool_result");
  assertEqual(results.length, 1, "the tool result was fed back");
  assertIncludes(JSON.stringify(second.messages), "line two");
  assertEqual(reqs[0].headers["anthropic-version"], "2023-06-01");
  assertEqual(reqs[0].headers["x-api-key"], "test-key");
});

await test("memory from AGENTS.md is injected as a leading system-reminder", async () => {
  const reqs = await seenRequests(fake);
  const first = reqs[0].body;
  assertEqual(first.messages[0].role, "user");
  assertIncludes(first.messages[0].content[0].text, "<system-reminder>");
  assertIncludes(first.messages[0].content[0].text, "Always answer in haiku");
  assert(!first.system[0].text.includes("Always answer in haiku"), "memory must not sit in the cached system prefix");
});

await test("thinking blocks survive the round trip with their signature", async () => {
  await resetFake(fake);
  await scriptTurns(fake, [
    { thinking: "considering", text: "step one", tools: [{ name: "ls", input: { path: "." } }] },
    { text: "done" },
  ]);
  const r = await runAgent(["-p", "look around"], anthropicEnv);
  assertEqual(r.code, 0, r.stderr);
  const reqs = await seenRequests(fake);
  const echoed = reqs[1].body.messages.flatMap((m: any) => (Array.isArray(m.content) ? m.content : [])).find((b: any) => b.type === "thinking");
  assert(echoed, "the thinking block must be echoed back");
  assertEqual(echoed.signature, "sig_fake", "…with its signature intact");
});

suite("end-to-end: OpenAI wire format");

await test("the same agent runs unchanged against the OpenAI shape", async () => {
  await resetFake(fake);
  await scriptTurns(fake, [
    { text: "Reading it.", tools: [{ name: "read", input: { path: "hello.txt" } }] },
    { text: "Three lines, as before." },
  ]);
  const r = await runAgent(["-p", "how many lines in hello.txt?"], openaiEnv);
  assertEqual(r.code, 0, `exit code; stderr: ${r.stderr}`);
  assertIncludes(r.stdout, "Three lines, as before.");
  assertIncludes(r.stdout, "line two");
});

await test("canonical blocks are translated into tool_calls and role:tool turns", async () => {
  const reqs = await seenRequests(fake);
  assert(reqs.length >= 2, `expected two model calls, saw ${reqs.length}`);
  const first = reqs[0].body;
  assertEqual(first.messages[0].role, "system", "the system prompt becomes a system message");
  assertIncludes(first.messages[0].content, "coding agent running in a terminal");
  assert(first.tools[0].type === "function", "tools use the function envelope");
  assertEqual(first.max_completion_tokens !== undefined, true, "gpt-5 wants max_completion_tokens");
  assertEqual(first.max_tokens, undefined);

  const second = reqs[1].body;
  const assistant = second.messages.find((m: any) => m.role === "assistant" && m.tool_calls);
  assert(assistant, "the assistant turn must carry tool_calls");
  assertEqual(typeof assistant.tool_calls[0].function.arguments, "string", "arguments are re-serialized to a string");
  const toolTurn = second.messages.find((m: any) => m.role === "tool");
  assert(toolTurn, "results become role:tool messages");
  assertEqual(toolTurn.tool_call_id, assistant.tool_calls[0].id, "ids must line up");
  assertIncludes(reqs[0].headers.authorization, "Bearer test-key");
});

suite("end-to-end: OpenRouter");

await test("an OpenRouter model slug routes through the OpenAI shape with attribution headers", async () => {
  await resetFake(fake);
  await scriptTurns(fake, [{ text: "routed via openrouter" }]);
  const r = await runAgent(["-p", "hello"], {
    ...baseEnv,
    OPENROUTER_API_KEY: "or-key",
    OPENROUTER_BASE_URL: `${fake.url}/v1`,
    AGENT_MODEL: "anthropic/claude-opus-5",
    AGENT_PROVIDER: "",
  });
  assertEqual(r.code, 0, r.stderr);
  assertIncludes(r.stdout, "routed via openrouter");
  const reqs = await seenRequests(fake);
  assertEqual(reqs[0].body.model, "anthropic/claude-opus-5", "the slug is passed through verbatim");
  assertIncludes(reqs[0].headers.authorization, "Bearer or-key");
  assert(reqs[0].headers["x-title"], "OpenRouter attribution headers are sent");
  assertEqual(reqs[0].body.max_tokens !== undefined, true, "OpenRouter takes max_tokens, not max_completion_tokens");
});

await test("any OpenAI-compatible base URL works with no key", async () => {
  await resetFake(fake);
  await scriptTurns(fake, [{ text: "local model replied" }]);
  const r = await runAgent(["-p", "hello", "--provider", `${fake.url}/v1`, "--model", "llama-3.3-70b"], baseEnv);
  assertEqual(r.code, 0, r.stderr);
  assertIncludes(r.stdout, "local model replied");
  assertEqual((await seenRequests(fake))[0].body.model, "llama-3.3-70b");
});

suite("end-to-end: the gate, compaction, and recovery");

await test("a denied tool becomes an error result and the loop continues", async () => {
  await resetFake(fake);
  await scriptTurns(fake, [
    { text: "Writing it.", tools: [{ name: "write", input: { path: "out.txt", content: "hi" } }] },
    { text: "Understood — I won't write files." },
  ]);
  const r = await runAgent(["-p", "write out.txt", "--allow", "deny:write"], anthropicEnv);
  assertEqual(r.code, 0, r.stderr);
  assertIncludes(r.stdout, "Understood");
  const reqs = await seenRequests(fake);
  assertIncludes(JSON.stringify(reqs[1].body.messages), "Permission denied", "the denial is fed back to the model");
});

await test("plan mode refuses side effects", async () => {
  await resetFake(fake);
  await scriptTurns(fake, [
    { text: "Trying an edit.", tools: [{ name: "write", input: { path: "plan.txt", content: "x" } }] },
    { text: "Here is the plan instead." },
  ]);
  const r = await runAgent(["-p", "change something", "--mode", "plan"], anthropicEnv);
  assertEqual(r.code, 0, r.stderr);
  assertIncludes(r.stdout, "Here is the plan instead.");
  const reqs = await seenRequests(fake);
  assertIncludes(JSON.stringify(reqs[1].body.messages), "plan mode");
  assertIncludes(reqs[0].body.system[1].text, "PLAN MODE IS ON");
});

await test("an unknown tool name comes back as a correctable error", async () => {
  await resetFake(fake);
  await scriptTurns(fake, [{ text: "trying", tools: [{ name: "no_such_tool", input: {} }] }, { text: "recovered" }]);
  const r = await runAgent(["-p", "do something"], anthropicEnv);
  assertEqual(r.code, 0, r.stderr);
  const reqs = await seenRequests(fake);
  assertIncludes(JSON.stringify(reqs[1].body.messages), "Unknown tool");
  assertIncludes(r.stdout, "recovered");
});

await test("bad tool input is reported back, not thrown", async () => {
  await resetFake(fake);
  await scriptTurns(fake, [{ text: "reading", tools: [{ name: "read", input: {} }] }, { text: "ok, needed a path" }]);
  const r = await runAgent(["-p", "read something"], anthropicEnv);
  assertEqual(r.code, 0, r.stderr);
  const reqs = await seenRequests(fake);
  assertIncludes(JSON.stringify(reqs[1].body.messages), "missing required property");
});

await test("proactive compaction fires once the transcript is worth compacting", async () => {
  await resetFake(fake);
  await scriptTurns(fake, [
    // turn 1: a tool call, so the transcript grows past the "nothing to
    // summarize" guard (user + assistant + tool_result = 3 visible turns)
    { text: "one", tools: [{ name: "read", input: { path: "hello.txt" } }] },
    // turn 2 is consumed by the summarizer at the top of the next iteration
    { text: "<summary>compacted transcript</summary>" },
    { text: "carrying on after compaction" },
  ]);
  const r = await runAgent(["-p", "go"], { ...anthropicEnv, AGENT_CONTEXT_WINDOW: "3000", AGENT_COMPACT_RATIO: "0.5" });
  assertEqual(r.code, 0, r.stderr);
  assertIncludes(r.stdout, "compacted context");
  assertIncludes(r.stdout, "carrying on after compaction");
});

await test("compaction does not fire on a transcript with nothing to summarize", async () => {
  await resetFake(fake);
  await scriptTurns(fake, [{ text: "short answer" }]);
  const r = await runAgent(["-p", "hi"], { ...anthropicEnv, AGENT_CONTEXT_WINDOW: "500", AGENT_COMPACT_RATIO: "0.5" });
  assertEqual(r.code, 0, r.stderr);
  assert(!r.stdout.includes("compacted context"), "must not compact an empty transcript");
  assertIncludes(r.stdout, "short answer");
  assertEqual((await seenRequests(fake)).length, 1, "exactly one model call");
});

await test("a 400 context-length error triggers reactive compaction and a retry", async () => {
  await resetFake(fake);
  await scriptTurns(fake, [
    { error: { status: 400, body: JSON.stringify({ error: { message: "prompt is too long: 200000 tokens" } }) } },
    { text: "<summary>rebuilt</summary>" },
    { text: "recovered after compacting" },
  ]);
  const r = await runAgent(["-p", "go"], anthropicEnv);
  assertEqual(r.code, 0, r.stderr);
  assertIncludes(r.stdout, "context limit hit");
  assertIncludes(r.stdout, "recovered after compacting");
});

await test("a 429 is retried with backoff", async () => {
  await resetFake(fake);
  await scriptTurns(fake, [
    { error: { status: 429, body: '{"error":{"message":"slow down"}}' } },
    { text: "made it through" },
  ]);
  const r = await runAgent(["-p", "go"], anthropicEnv);
  assertEqual(r.code, 0, r.stderr);
  assertIncludes(r.stdout, "made it through");
  assertIncludes(r.stdout + r.stderr, "retry 1");
});

await test("MAX_TURNS stops a runaway loop", async () => {
  await resetFake(fake);
  await scriptTurns(fake, Array.from({ length: 10 }, () => ({ text: "again", tools: [{ name: "ls", input: { path: "." } }] })));
  const r = await runAgent(["-p", "loop forever"], { ...anthropicEnv, AGENT_MAX_TURNS: "3" });
  assertEqual(r.code, 0, r.stderr);
  assertIncludes(r.stdout, "stopped after 3 model calls");
});

suite("end-to-end: subagents and self-extension");

await test("the task tool recurses the loop with a read-only child", async () => {
  await resetFake(fake);
  await scriptTurns(fake, [
    { text: "Delegating.", tools: [{ name: "task", input: { description: "find lines", prompt: "count the lines in hello.txt" } }] },
    { text: "The child says three." }, // ← the child's turn
    { text: "Three lines, per the subagent." },
  ]);
  const r = await runAgent(["-p", "use a subagent"], anthropicEnv);
  assertEqual(r.code, 0, r.stderr);
  assertIncludes(r.stdout, "subagent: find lines");
  assertIncludes(r.stdout, "Three lines, per the subagent.");
  const reqs = await seenRequests(fake);
  const childReq = reqs[1].body;
  assertIncludes(childReq.system[0].text, "research subagent");
  const childTools = childReq.tools.map((t: any) => t.name).sort();
  assert(!childTools.includes("write"), "the child must not get writers");
  assert(!childTools.includes("task"), "no infinite recursion");
});

await test("the agent can write a tool and load it in the same session", async () => {
  // Run from the agent's own directory: extensions/ is then inside the
  // workspace, so --yes covers the write. From an unrelated project it sits
  // outside the workspace and the safety floor refuses it — see the next test.
  const home = fileURLToPath(new URL("..", import.meta.url));
  const r = await runAgent(["-p", "build a shout extension and use it", "--mock", "--yes"], {
    ...baseEnv,
    PWD_OVERRIDE: home,
  });
  assertEqual(r.code, 0, r.stderr);
  assertIncludes(r.stdout, "Loaded 2 extension tool(s)");
  assertIncludes(r.stdout, "HELLO FROM A TOOL I JUST WROTE");
});

await test("a non-interactive run refuses rather than hangs when the floor fires", async () => {
  // Same demo from an unrelated cwd: the write lands outside the workspace, the
  // safety floor asks, and with nobody to answer the call must be refused —
  // not block forever on a prompt.
  const r = await runAgent(["-p", "build a shout extension and use it", "--mock", "--yes"], baseEnv, undefined, 30_000);
  assertEqual(r.code, 0, `should exit cleanly, not hang; stderr: ${r.stderr}`);
  assertIncludes(r.stdout, "needs approval");
});

suite("end-to-end: slash commands and the REPL");

await test("the client commands all run without calling the model", async () => {
  await resetFake(fake);
  const input = ["/help", "/status", "/tools", "/context", "/cost", "/permissions", "/todos", "/model", "/memory", "/exit"].join("\n") + "\n";
  const r = await runAgent([], anthropicEnv, input);
  assertEqual(r.code, 0, r.stderr);
  assertIncludes(r.stdout, "/compact");
  assertIncludes(r.stdout, "provider  anthropic");
  assertIncludes(r.stdout, "reload_extensions");
  assertIncludes(r.stdout, "compaction at");
  assertIncludes(r.stdout, "requests       0");
  assertIncludes(r.stdout, "read-only tools auto-allow");
  assertIncludes(r.stdout, "AGENTS.md", "/memory lists the discovered context files");
  assertIncludes(r.stdout, "Loaded (later files win on conflict)");
  assertEqual((await seenRequests(fake)).length, 0, "no model call should have happened");
});

await test("/permissions changes the mode and adds rules", async () => {
  await resetFake(fake);
  const r = await runAgent([], anthropicEnv, "/permissions plan\n/permissions allow:bash(git *)\n/exit\n");
  assertEqual(r.code, 0, r.stderr);
  assertIncludes(r.stdout, "mode: plan");
  assertIncludes(r.stdout, "allow bash(git *)");
});

await test("/clear starts a new session and empties the context", async () => {
  await resetFake(fake);
  await scriptTurns(fake, [{ text: "noted" }]);
  const r = await runAgent([], anthropicEnv, "remember the number 7\n/clear\n/context\n/exit\n");
  assertEqual(r.code, 0, r.stderr);
  assertIncludes(r.stdout, "context cleared — new session");
  assertIncludes(r.stdout, "0 visible messages");
});

await test("/compact summarizes and shrinks the live conversation", async () => {
  await resetFake(fake);
  await scriptTurns(fake, [{ text: "acknowledged" }, { text: "<summary>the user said hello</summary>" }]);
  const r = await runAgent([], anthropicEnv, "hello there\n/compact\n/exit\n");
  assertEqual(r.code, 0, r.stderr);
  assertIncludes(r.stdout, "compacted:");
  assertIncludes(r.stdout, "the user said hello");
});

await test("an unknown command is a hint, not a crash", async () => {
  await resetFake(fake);
  const r = await runAgent([], anthropicEnv, "/helpp\n/exit\n");
  assertEqual(r.code, 0, r.stderr);
  assertIncludes(r.stdout, "unknown command /helpp");
});

await test("/resume lists sessions and resumes one by prefix", async () => {
  await resetFake(fake);
  await scriptTurns(fake, [{ text: "stored" }]);
  const first = await runAgent(["-p", "the secret is 4242"], anthropicEnv);
  assertEqual(first.code, 0, first.stderr);

  const sessions = await listSessions(workspace);
  assert(sessions.length > 0, "a session file should exist");

  await resetFake(fake);
  const r = await runAgent([], anthropicEnv, "/resume\n/exit\n");
  assertIncludes(r.stdout, "Sessions (newest first)");

  await resetFake(fake);
  const r2 = await runAgent([], anthropicEnv, `/resume ${sessions[0].id.slice(0, 8)}\n/context\n/exit\n`);
  assertIncludes(r2.stdout, `resumed ${sessions[0].id.slice(0, 8)}`);
  assertIncludes(r2.stdout, "last: the secret is 4242");
});

await test("--continue picks up the most recent session for this directory", async () => {
  await resetFake(fake);
  await scriptTurns(fake, [{ text: "and now I remember" }]);
  const r = await runAgent(["--continue", "-p", "what was the secret?"], anthropicEnv);
  assertEqual(r.code, 0, r.stderr);
  assertIncludes(r.stdout, "resumed ");
  const reqs = await seenRequests(fake);
  assertIncludes(JSON.stringify(reqs[0].body.messages), "4242", "the resumed transcript is resent");
});

await test("a markdown command expands, substitutes, and runs embedded shell", async () => {
  await mkdir(join(workspace, ".agent", "commands", "demo"), { recursive: true });
  await writeFile(
    join(workspace, ".agent", "commands", "demo", "greet.md"),
    ["---", "description: Greet a name", "argument-hint: [name]", "---", "Say hello to $1.", "Directory listing: !`echo scripted-output`"].join("\n"),
    "utf8",
  );
  await resetFake(fake);
  await scriptTurns(fake, [{ text: "hello indeed" }]);
  const r = await runAgent([], anthropicEnv, "/help\n/demo:greet World\n/exit\n");
  assertEqual(r.code, 0, r.stderr);
  assertIncludes(r.stdout, "/demo:greet");
  const reqs = await seenRequests(fake);
  const sent = JSON.stringify(reqs[0].body.messages);
  assertIncludes(sent, "Say hello to World.");
  assertIncludes(sent, "scripted-output", "embedded shell was executed and spliced in");
});

// ── report ───────────────────────────────────────────────────────────────────

await fake.close();
await rm(sandbox, { recursive: true, force: true });
await rm(fileURLToPath(new URL("../extensions/shout.ts", import.meta.url)), { force: true });

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  process.stdout.write("\nFailures:\n" + failures.map((f) => "  ✗ " + f).join("\n") + "\n");
  process.exit(1);
}
