#!/usr/bin/env node
// agent.ts — the entry point: CLI parsing, the REPL, and the wiring that turns
// the modules in src/ into a working agent.
//
// Read src/loop.ts first — that is the part that matters. This file is the
// runtime shell around it: argument parsing, terminal I/O, session lifecycle,
// and the slash-command dispatch that runs BEFORE the loop (Ch. 11).
//
//   node agent.ts                          interactive
//   node agent.ts "fix the failing test"   interactive, seeded with a task
//   node agent.ts -p "summarize README.md" one-shot, prints and exits
//
// Provider selection (Ch. 4): --provider / --model, else inferred from the
// model name, else from whichever API key is in the environment, else the
// offline mock.

import * as readline from "node:readline/promises";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { platform } from "node:os";
import { basename, resolve } from "node:path";

import type { Message } from "./src/types.ts";
import { loadSettings, resolveProvider, keyVarFor, DEFAULT_MODELS } from "./src/config.ts";
import type { ProviderProfile } from "./src/config.ts";
import { createProvider } from "./src/providers.ts";
import { createMockProvider } from "./src/mock.ts";
import type { Tool, TodoItem, ToolContext } from "./src/tools.ts";
import { BUILTIN_TOOLS, SUBAGENT_TOOLS, defaultSpillDir, mergeTools } from "./src/tools.ts";
import { PermissionGate, parseRule } from "./src/permissions.ts";
import type { PermissionMode } from "./src/permissions.ts";
import { Agent, estimateCost, runSubagent } from "./src/loop.ts";
import { buildSubagentSystemPrompt } from "./src/prompt.ts";
import type { EnvSnapshot } from "./src/prompt.ts";
import { loadMemory, invalidateMemoryCache, memoryCandidates, repoSnapshot } from "./src/memory.ts";
import { SessionStore, listSessions, loadSession } from "./src/session.ts";
import { describeLoad, loadExtensions } from "./src/extensions.ts";
import { CommandRegistry, builtinCommands, loadMarkdownCommands, parseSlashCommand } from "./src/commands.ts";
import type { CommandHost } from "./src/commands.ts";
import * as ui from "./src/ui.ts";

const execAsync = promisify(exec);
const VERSION = "0.2.0";
const EXT_DIR = new URL("./extensions/", import.meta.url);

// ── CLI parsing ──────────────────────────────────────────────────────────────

interface Cli {
  task: string;
  print: boolean;
  provider?: string;
  model?: string;
  mode?: PermissionMode;
  yes: boolean;
  mock: boolean;
  resume?: string;
  continueLast: boolean;
  allow: string[];
  help: boolean;
  version: boolean;
}

function parseArgv(argv: string[]): Cli {
  const cli: Cli = {
    task: "",
    print: false,
    yes: false,
    mock: false,
    continueLast: false,
    allow: [],
    help: false,
    version: false,
  };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "-p":
      case "--print":
        cli.print = true;
        break;
      case "--provider":
        cli.provider = next();
        break;
      case "--model":
      case "-m":
        cli.model = next();
        break;
      case "--mode":
        cli.mode = next() as PermissionMode;
        break;
      case "--yes":
      case "-y":
        cli.yes = true;
        break;
      case "--mock":
        cli.mock = true;
        break;
      case "--resume":
      case "-r":
        cli.resume = argv[i + 1]?.startsWith("-") ? "" : next() ?? "";
        break;
      case "--continue":
      case "-c":
        cli.continueLast = true;
        break;
      case "--allow":
        cli.allow.push(next() ?? "");
        break;
      case "--help":
      case "-h":
        cli.help = true;
        break;
      case "--version":
      case "-v":
        cli.version = true;
        break;
      default:
        if (a.startsWith("-")) throw new Error(`Unknown flag ${a} (try --help)`);
        rest.push(a);
    }
  }
  cli.task = rest.join(" ").trim();
  return cli;
}

const HELP = `lean-agent ${VERSION} — the runnable core from docs/Agent-Architecture-Handbook.pdf

Usage
  node agent.ts [options] ["task"]

Options
  -p, --print              run one turn, print the final answer, exit
  -m, --model <name>       e.g. claude-opus-5, gpt-5, anthropic/claude-opus-5
      --provider <id|url>  anthropic | openai | openrouter | mock | http://host/v1
      --mode <mode>        default | acceptEdits | plan | bypass
  -y, --yes                auto-approve tool calls (the safety floor still asks)
      --allow <rule>       add a permission rule, e.g. 'bash(git *)' or 'deny:write'
  -c, --continue           resume the most recent session for this directory
  -r, --resume [id]        resume a session by id prefix (no id ⇒ list them)
      --mock               force the offline scripted provider
  -h, --help / -v, --version

Environment
  ANTHROPIC_API_KEY | OPENAI_API_KEY | OPENROUTER_API_KEY   picks the provider
  AGENT_MODEL, AGENT_PROVIDER, AGENT_BASE_URL, AGENT_API_KEY
  AGENT_MAX_TOKENS, AGENT_MAX_TURNS, AGENT_CONTEXT_WINDOW,
  AGENT_COMPACT_RATIO, AGENT_MAX_TOOL_RESULT_CHARS

With no API key set, the agent runs a scripted offline demo of the loop.
Type /help once inside for the command list.`;

// ── one shared line queue ────────────────────────────────────────────────────
//
// readline emits every buffered line in one tick when stdin is a pipe, so a
// loop of `rl.question()` silently drops all but the first. Buffering the lines
// ourselves fixes that and lets the REPL loop and the permission prompt draw
// from the same source without racing.

class LineReader {
  #queue: string[] = [];
  #waiters: ((line: string | null) => void)[] = [];
  #closed = false;

  constructor(rl: readline.Interface) {
    rl.on("line", (line: string) => {
      const waiter = this.#waiters.shift();
      if (waiter) waiter(line);
      else this.#queue.push(line);
    });
    rl.on("close", () => {
      this.#closed = true;
      while (this.#waiters.length) this.#waiters.shift()!(null);
    });
  }

  /** Resolves to the next line, or null once input has ended. */
  next(): Promise<string | null> {
    if (this.#queue.length) return Promise.resolve(this.#queue.shift()!);
    if (this.#closed) return Promise.resolve(null);
    return new Promise((resolve) => this.#waiters.push(resolve));
  }
}

// ── the app ──────────────────────────────────────────────────────────────────

class App implements CommandHost {
  cwd = process.cwd();
  settings = loadSettings();
  profile!: ProviderProfile;
  gate!: PermissionGate;
  agent!: Agent;
  session?: SessionStore;
  todos: TodoItem[] = [];
  extensionTools: Tool[] = [];
  registry = new CommandRegistry();
  rl?: readline.Interface;
  lines?: LineReader;
  env!: EnvSnapshot;
  #abort?: AbortController;
  #streaming = false;

  get sessionId(): string {
    return this.session?.meta.id ?? "(unsaved)";
  }

  print(text: string): void {
    ui.line(text);
  }

  // ── setup ──────────────────────────────────────────────────────────────────

  async init(cli: Cli): Promise<void> {
    this.profile = resolveProvider({ provider: cli.provider, model: cli.model, mock: cli.mock });
    this.gate = new PermissionGate({
      mode: cli.mode ?? "default",
      autoApprove: cli.yes,
      ask: (q) => this.ask(q),
    });
    for (const spec of cli.allow) {
      const rule = parseRule(spec);
      if (rule) this.gate.rules.push(rule);
      else ui.warn(`ignored unparseable rule: ${spec}`);
    }

    this.env = await snapshotEnv(this.cwd, this.profile.model, this.gate.mode);
    await this.#loadExtensions();

    const memory = await loadMemory(this.cwd);
    this.agent = new Agent({
      provider: this.#makeProvider(),
      gate: this.gate,
      settings: this.settings,
      env: this.env,
      listTools: () => this.listTools(),
      toolContext: this.#toolContext(),
      memoryText: memory.text,
      hooks: this.#hooks(),
      onMessage: (m) => this.session?.addMessage(m),
    });

    this.session = await SessionStore.create({
      cwd: this.cwd,
      provider: this.profile.id,
      model: this.profile.model,
    });

    this.registry.register(builtinCommands());
    this.registry.register(await loadMarkdownCommands(this.cwd));
    (this as any).__commands = this.registry.list();
  }

  #makeProvider() {
    return this.profile.id === "mock"
      ? createMockProvider(this.profile.model, this.profile.contextWindow)
      : createProvider(this.profile, (attempt, waitMs, why) =>
          ui.warn(`  retry ${attempt}: ${why} — waiting ${Math.round(waitMs / 100) / 10}s`),
        );
  }

  #toolContext(): ToolContext {
    return {
      cwd: this.cwd,
      todos: this.todos,
      setTodos: (t) => {
        this.todos = t;
        // keep the live array identity the loop reads
        this.agent.toolContext.todos = t;
        this.session?.addTodos(t);
      },
      spillDir: defaultSpillDir(),
      reloadExtensions: () => this.#loadExtensions(),
      runSubagent: (prompt, opts) => {
        ui.line(ui.magenta(`  ↳ subagent: ${opts.label}`));
        return runSubagent(
          prompt,
          {
            provider: this.agent.provider,
            gate: this.gate,
            settings: this.settings,
            env: this.env,
            tools: SUBAGENT_TOOLS,
            system: buildSubagentSystemPrompt(this.env),
            toolContext: this.agent.toolContext,
            hooks: {
              onToolCall: (tool, _input, subject) => ui.line(ui.dim(`    ↳ ${tool.name} ${ui.truncate(subject, 80)}`)),
            },
          },
          this.#abort?.signal,
        );
      },
    };
  }

  async #loadExtensions(): Promise<string> {
    const result = await loadExtensions(EXT_DIR);
    this.extensionTools = result.tools;
    return describeLoad(result);
  }

  listTools(): Tool[] {
    // Rebuilt on every call — that is what makes a tool the agent just wrote
    // usable on the very next model call (Ch. 17).
    return mergeTools(BUILTIN_TOOLS, this.extensionTools);
  }

  // ── terminal I/O ───────────────────────────────────────────────────────────

  async ask(question: string): Promise<string> {
    // Inside the REPL, read from the shared queue so a permission prompt and
    // the prompt loop never race for the same line.
    if (this.lines) {
      ui.write(question);
      const answer = (await this.lines.next()) ?? "";
      // A pipe does not echo, so without this the answer and whatever prints
      // next end up on the same line.
      if (process.stdin.isTTY !== true) ui.line(answer);
      return answer;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  }

  #hooks() {
    let wroteText = false;
    return {
      onTextDelta: (t: string) => {
        if (!this.#streaming) {
          ui.write("\n");
          this.#streaming = true;
        }
        wroteText = true;
        ui.write(t);
      },
      onThinkingDelta: () => {
        if (!this.#streaming) {
          ui.write(ui.dim("\n(thinking…)"));
          this.#streaming = true;
        }
      },
      onAssistantEnd: () => {
        if (wroteText) ui.write("\n");
        wroteText = false;
        this.#streaming = false;
      },
      onToolCall: (tool: Tool, _input: any, subject: string) => {
        this.#streaming = false;
        ui.toolCall(tool.name, subject);
      },
      onToolResult: (tool: Tool, result: { content: string; isError?: boolean }) =>
        ui.toolResult(tool.name, result.content, result.isError === true),
      onDenied: (name: string, reason: string) => ui.warn(`  ✗ ${name}: ${reason}`),
      onCompaction: (r: { before: number; after: number }) =>
        ui.info(`  ⟳ compacted context: ${ui.formatTokens(r.before)} → ${ui.formatTokens(r.after)} tokens`),
      onNotice: (t: string) => ui.info(`  ${t}`),
    };
  }

  // ── running a turn ─────────────────────────────────────────────────────────

  async runTurn(input: string | Message): Promise<void> {
    this.#abort = new AbortController();
    this.#streaming = false;
    try {
      const result = await this.agent.runTurn(input, this.#abort.signal);
      if (result.stop === "error") {
        ui.error(`\n✗ ${result.error?.message ?? "unknown error"}`);
        if ((result.error as any)?.status === 401) {
          ui.info(`  set ${keyVarFor(this.profile.id as any)} — or run with --mock`);
        }
      } else if (result.stop === "aborted") {
        ui.warn("\n⏹ interrupted");
      }
    } finally {
      this.#abort = undefined;
      await this.session?.flush();
    }
  }

  interrupt(): boolean {
    if (!this.#abort) return false;
    this.#abort.abort();
    return true;
  }

  // ── CommandHost implementation ─────────────────────────────────────────────

  async clearConversation(): Promise<void> {
    await this.session?.flush();
    this.agent.messages = [];
    this.agent.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 };
    this.todos = [];
    this.agent.toolContext.todos = this.todos;
    invalidateMemoryCache();
    this.agent.memoryText = (await loadMemory(this.cwd)).text;
    this.session = await SessionStore.create({
      cwd: this.cwd,
      provider: this.profile.id,
      model: this.profile.model,
    });
    ui.info(`context cleared — new session ${this.session.meta.id.slice(0, 8)}`);
  }

  async compactConversation(focus?: string): Promise<void> {
    if (!this.agent.messages.length) return ui.info("nothing to compact yet");
    const before = this.agent.estimateTokens();
    const r = await this.agent.compactNow(focus);
    ui.info(`compacted: ${ui.formatTokens(before)} → ${ui.formatTokens(this.agent.estimateTokens())} tokens`);
    ui.line(ui.dim(ui.truncate(r.summary.split("\n").slice(0, 4).join("\n"), 400)));
  }

  async resumeSession(idOrPrefix?: string): Promise<void> {
    if (!idOrPrefix) {
      const sessions = await listSessions(this.cwd);
      if (!sessions.length) return ui.info("no saved sessions for this directory");
      ui.heading("Sessions (newest first):");
      for (const s of sessions.slice(0, 20)) {
        ui.line(
          `  ${ui.bold(s.id.slice(0, 8))}  ${s.updatedAt.slice(0, 16).replace("T", " ")}  ` +
            `${String(s.messageCount).padStart(3)} msgs  ${ui.truncate(s.title, 60)}`,
        );
      }
      ui.info("resume one with /resume <id-prefix>");
      return;
    }
    const loaded = await loadSession(this.cwd, idOrPrefix);
    if (!loaded) return ui.warn(`no session matching "${idOrPrefix}"`);
    await this.#adoptSession(loaded);
  }

  async #adoptSession(loaded: { meta: any; messages: Message[]; todos: TodoItem[] }): Promise<void> {
    await this.session?.flush();
    this.agent.messages = loaded.messages;
    this.todos = loaded.todos;
    this.agent.toolContext.todos = this.todos;
    // Append to the SAME file so the transcript stays one thread.
    this.session = await SessionStore.create({
      cwd: this.cwd,
      provider: loaded.meta.provider,
      model: loaded.meta.model,
      id: loaded.meta.id,
    });
    ui.info(
      `resumed ${loaded.meta.id.slice(0, 8)} — ${loaded.messages.filter((m) => !m.meta).length} messages, ` +
        `${ui.formatTokens(this.agent.estimateTokens())} tokens`,
    );
    const lastUser = [...loaded.messages].reverse().find((m) => m.role === "user" && !m.meta);
    const text = lastUser?.content.find((b) => b.type === "text")?.text;
    if (text) ui.line(ui.dim(`  last: ${ui.truncate(text.replace(/\s+/g, " "), 100)}`));
  }

  async switchModel(spec: string): Promise<void> {
    if (!spec) {
      ui.line(`model: ${ui.bold(this.profile.model)}   provider: ${this.profile.id}`);
      ui.info(`  window ${ui.formatTokens(this.profile.contextWindow)} tokens; defaults: ${Object.entries(DEFAULT_MODELS).map(([k, v]) => `${k}→${v}`).join(", ")}`);
      return;
    }
    try {
      const next = resolveProvider({ model: spec });
      if (!next.apiKey && next.id !== "mock") {
        ui.warn(`no key for ${next.id}; set ${keyVarFor(next.id)} first`);
        return;
      }
      this.profile = next;
      this.agent.provider = this.#makeProvider();
      this.env = { ...this.env, model: next.model };
      this.agent.env = this.env;
      ui.info(`switched to ${next.id}/${next.model} (window ${ui.formatTokens(next.contextWindow)})`);
      ui.info("note: switching models invalidates the provider-side prompt cache");
    } catch (err) {
      ui.warn((err as Error).message);
    }
  }

  setPermissionMode(mode: string): void {
    this.gate.mode = mode as PermissionMode;
    this.env = { ...this.env, permissionMode: mode };
    this.agent.env = this.env;
  }

  addPermissionRule(spec: string): void {
    const rule = parseRule(spec);
    if (!rule) return ui.warn(`could not parse rule "${spec}" (try 'allow:bash(git *)')`);
    this.gate.rules.push(rule);
  }

  describePermissions(): string {
    return this.gate.describe();
  }

  describeStatus(): string {
    const t = this.agent.estimateTokens();
    return [
      `session   ${this.sessionId}`,
      `provider  ${this.profile.id}${this.profile.baseUrl ? ` (${this.profile.baseUrl})` : ""}`,
      `model     ${this.profile.model}`,
      `context   ${ui.formatTokens(t)} / ${ui.formatTokens(this.profile.contextWindow)} tokens`,
      `cwd       ${this.cwd}`,
      `mode      ${this.gate.mode}${this.gate.autoApprove ? " + auto-approve" : ""}`,
      `tools     ${this.listTools().length} (${this.extensionTools.length} from extensions/)`,
    ].join("\n");
  }

  describeCost(): string {
    const u = this.agent.usage;
    const cost = estimateCost(u, this.profile.price);
    const lines = [
      `requests       ${u.requests}`,
      `input tokens   ${ui.formatTokens(u.input)}`,
      `output tokens  ${ui.formatTokens(u.output)}`,
      `cache read     ${ui.formatTokens(u.cacheRead)}`,
      `cache write    ${ui.formatTokens(u.cacheWrite)}`,
    ];
    lines.push(
      cost === undefined
        ? `cost           unknown (no published price for ${this.profile.model} in this build)`
        : `cost           ~$${cost.toFixed(4)} (estimate; cache read 0.1×, write 1.25×)`,
    );
    return lines.join("\n");
  }

  describeContext(): string {
    const system = this.agent.systemPrompt();
    const tools = this.agent.toolSchemas();
    const approx = (s: string) => Math.ceil(Buffer.byteLength(s, "utf8") / 4);
    const sys = approx(system.cacheablePrefix) + approx(system.dynamicSuffix);
    const toolTokens = tools.reduce((n, t) => n + approx(t.name + t.description + JSON.stringify(t.input_schema)), 0);
    const total = this.agent.estimateTokens();
    const convo = Math.max(0, total - sys - toolTokens);
    const frac = total / this.profile.contextWindow;
    const hidden = this.agent.messages.filter((m) => m.agentVisible === false).length;
    return [
      `${ui.bar(frac)}  ${ui.formatTokens(total)} / ${ui.formatTokens(this.profile.contextWindow)} (${(frac * 100).toFixed(1)}%)`,
      `  system prompt   ${ui.formatTokens(sys)}`,
      `  tool schemas    ${ui.formatTokens(toolTokens)}  (${tools.length} tools)`,
      `  conversation    ${ui.formatTokens(convo)}  (${this.agent.messages.filter((m) => m.agentVisible !== false).length} visible messages${hidden ? `, ${hidden} compacted away` : ""})`,
      `  compaction at   ${ui.formatTokens(this.profile.contextWindow * this.settings.compactionRatio)} (${this.settings.compactionRatio * 100}%)`,
    ].join("\n");
  }

  describeTools(): string {
    const tools = this.listTools();
    return tools
      .map((t) => `  ${t.readOnly ? ui.green("read ") : ui.yellow("write")} ${t.name.padEnd(20)} ${ui.truncate(t.description.split(". ")[0], 90)}`)
      .join("\n");
  }

  describeTodos(): string {
    if (!this.todos.length) return "no todos yet";
    return this.todos
      .map((t) => `  [${t.status === "completed" ? "x" : t.status === "in_progress" ? "~" : " "}] ${t.content}`)
      .join("\n");
  }

  async describeMemory(): Promise<string> {
    invalidateMemoryCache();
    const mem = await loadMemory(this.cwd);
    this.agent.memoryText = mem.text;
    const lines: string[] = [];
    if (mem.files.length) {
      lines.push("Loaded (later files win on conflict):");
      for (const f of mem.files) lines.push(`  ${f.kind.padEnd(8)} ${f.path}  (${f.body.length} bytes)`);
    } else {
      lines.push("No memory files found.");
    }
    lines.push("", "Candidates:");
    for (const c of await memoryCandidates(this.cwd)) {
      lines.push(`  ${c.exists ? "✓" : " "} ${c.kind.padEnd(8)} ${c.path}`);
    }
    lines.push("", "Edit one of these by hand, then run /memory again to reload.");
    return lines.join("\n");
  }

  async reloadExtensions(): Promise<string> {
    return this.#loadExtensions();
  }

  async initProjectDoc(): Promise<string> {
    const snapshot = await repoSnapshot(this.cwd);
    return (
      `Create an AGENTS.md at the project root that will be loaded into your context in every future session here.\n\n` +
      `${snapshot}\n\n` +
      `First explore the repo: read the build/package manifests, the README, and enough source to see the real ` +
      `conventions. Then write AGENTS.md covering, briefly and only where non-obvious:\n` +
      `  - what this project is, in two sentences\n` +
      `  - the commands to build, test, lint, and run it\n` +
      `  - the layout: which directory holds what\n` +
      `  - conventions a newcomer would otherwise get wrong\n\n` +
      `Keep it under ~60 lines. Do not restate what is already obvious from the file tree, and do not invent ` +
      `commands you have not verified exist. If an AGENTS.md already exists, improve it in place rather than ` +
      `replacing it.`
    );
  }

  // ── the REPL ───────────────────────────────────────────────────────────────

  async repl(seed?: string): Promise<void> {
    const isTty = process.stdin.isTTY === true;
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      // A pipe is not a terminal. Emulating one mangles piped input.
      terminal: isTty,
      completer: (input: string) => {
        if (!input.startsWith("/")) return [[], input];
        const hits = this.registry.names().filter((n) => ("/" + n).startsWith(input)).map((n) => "/" + n);
        return [hits.length ? hits : [], input];
      },
    });
    // ONE persistent line reader for both the prompt loop and the permission
    // gate. Calling rl.question() in a loop drops input: with piped stdin every
    // line arrives in the same tick, and question() only listens for one.
    this.lines = new LineReader(this.rl);

    let interruptedOnce = false;
    this.rl.on("SIGINT", () => {
      if (this.interrupt()) {
        interruptedOnce = false;
        return;
      }
      if (interruptedOnce) {
        ui.line("");
        this.rl?.close();
        return;
      }
      interruptedOnce = true;
      ui.line(ui.dim("\n(press Ctrl-C again to exit, or Ctrl-D)"));
      if (isTty) ui.write(`${ui.green("›")} `);
    });

    if (seed) {
      ui.line(`${ui.green("›")} ${seed}`);
      await this.#handleInput(seed);
    }

    for (;;) {
      if (isTty) ui.write(`${ui.green("›")} `);
      const input = await this.lines.next();
      if (input === null) break; // Ctrl-D / end of piped input
      interruptedOnce = false;
      const trimmed = input.trim();
      if (!trimmed) continue;
      if (!isTty) ui.line(`${ui.green("›")} ${trimmed}`); // echo, so logs read as a session
      const done = await this.#handleInput(trimmed);
      if (done) break;
    }
    this.rl.close();
    await this.session?.flush();
    ui.info("bye");
  }

  /** Returns true when the app should exit. */
  async #handleInput(input: string): Promise<boolean> {
    const parsed = parseSlashCommand(input);
    if (!parsed) {
      await this.runTurn(input);
      return false;
    }
    const command = this.registry.get(parsed.name);
    if (!command) {
      const near = this.registry.closest(parsed.name);
      ui.warn(`unknown command /${parsed.name}${near ? ` — did you mean /${near}?` : ""}  (/help lists them)`);
      return false;
    }
    try {
      const result = (await command.run(parsed.args, this)) ?? {};
      if (result.exit) return true;
      if (result.prompt) await this.runTurn(result.prompt);
    } catch (err) {
      ui.error(`/${parsed.name} failed: ${(err as Error).message}`);
    }
    return false;
  }

  banner(): void {
    const where = this.profile.id === "mock" ? ui.yellow("mock (offline)") : `${this.profile.id}/${this.profile.model}`;
    ui.line(`${ui.bold("lean-agent")} ${ui.dim(VERSION)}  ${where}  ${ui.dim(basename(this.cwd))}`);
    if (this.profile.id === "mock") {
      ui.info("no API key found — running the scripted offline demo. /help for commands.");
    } else {
      ui.info(`${this.gate.mode} permissions · ${this.listTools().length} tools · /help for commands`);
    }
  }
}

// ── environment snapshot (session-stable; Ch. 5) ─────────────────────────────

async function snapshotEnv(cwd: string, model: string, mode: string): Promise<EnvSnapshot> {
  const env: EnvSnapshot = {
    cwd: resolve(cwd),
    platform: `${platform()} ${process.version}`,
    today: new Date().toISOString().slice(0, 10),
    model,
    permissionMode: mode,
  };
  try {
    const { stdout } = await execAsync("git rev-parse --abbrev-ref HEAD", { cwd, timeout: 3000 });
    env.gitBranch = stdout.trim();
    const { stdout: status } = await execAsync("git status --porcelain", { cwd, timeout: 5000 });
    env.gitDirty = status.trim().length > 0;
  } catch {
    /* not a git repo — fine */
  }
  return env;
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let cli: Cli;
  try {
    cli = parseArgv(process.argv.slice(2));
  } catch (err) {
    ui.error((err as Error).message);
    process.exit(2);
  }
  if (cli.help) return ui.line(HELP);
  if (cli.version) return ui.line(VERSION);

  const app = new App();
  await app.init(cli);

  if (cli.continueLast || cli.resume !== undefined) {
    const id = cli.resume || (await listSessions(app.cwd))[0]?.id;
    if (id) await app.resumeSession(id);
    else if (cli.resume === "") await app.resumeSession();
    else ui.info("no previous session for this directory");
  }

  if (cli.print) {
    if (!cli.task) {
      ui.error("--print needs a task: node agent.ts -p \"your task\"");
      process.exit(2);
    }
    // Nobody is at the keyboard: auto-approve what the rules would have asked
    // about, and refuse (rather than hang on) anything the safety floor catches.
    app.gate.autoApprove = true;
    app.gate.interactive = false;
    await app.runTurn(cli.task);
    await app.session?.flush();
    return;
  }

  app.banner();
  await app.repl(cli.task || undefined);
}

main().catch((err) => {
  ui.error(`fatal: ${err?.stack ?? err}`);
  process.exit(1);
});
