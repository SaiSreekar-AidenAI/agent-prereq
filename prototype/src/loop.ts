// loop.ts — THE AGENT LOOP (Ch. 1).
//
//   while true:
//     compact if over threshold
//     assistant = stream(system, messages, tools)     ← tools rebuilt each turn
//     messages += assistant
//     if assistant made NO tool calls: return         ← THE exit test
//     results = run(each call)  (gate → execute → cap)
//     messages += user(results)
//
// Three invariants carry the whole design:
//   * the exit signal is the ABSENCE of a tool_use block, never `stop_reason`;
//   * every tool_use gets exactly one tool_result before the next call;
//   * validation failures, permission denials and tool exceptions are all
//     `is_error` results — the loop has one happy path and never throws to
//     control flow.
//
// Everything else here (compaction retry, abort, parallel batching) is another
// `continue` branch on that same flat loop, which is exactly why the shape was
// chosen over a state machine.

import type {
  ContentBlock,
  Message,
  Provider,
  SystemPrompt,
  ToolResultBlock,
  ToolSchema,
  ToolUseBlock,
  UsageDelta,
} from "./types.ts";
import { ContextLengthExceededError, backfillMissingToolResults, isAgentVisible } from "./types.ts";
import type { Tool, ToolContext, ToolResult, TodoItem } from "./tools.ts";
import { capAndSpill } from "./tools.ts";
import type { PermissionGate } from "./permissions.ts";
import { permissionSubject } from "./permissions.ts";
import type { AgentSettings } from "./config.ts";
import type { EnvSnapshot } from "./prompt.ts";
import { buildMemoryReminder, buildTodoReminder, buildSystemPrompt } from "./prompt.ts";
import { compact, estimateRequestTokens, shouldCompact } from "./context.ts";
import type { CompactionResult } from "./context.ts";

// ── usage accounting ─────────────────────────────────────────────────────────

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  requests: number;
}

export function emptyUsage(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 };
}

export function addUsage(total: UsageTotals, delta: UsageDelta): void {
  total.input += delta.input;
  total.output += delta.output;
  total.cacheRead += delta.cacheRead;
  total.cacheWrite += delta.cacheWrite;
}

/** Standard cache multipliers: reads ~0.1×, 5-minute writes ~1.25× base input. */
export function estimateCost(u: UsageTotals, price?: { input: number; output: number }): number | undefined {
  if (!price) return undefined;
  return (
    (u.input * price.input + u.cacheRead * price.input * 0.1 + u.cacheWrite * price.input * 1.25 + u.output * price.output) /
    1_000_000
  );
}

// ── hooks: the loop emits, the UI renders (goose's AgentEvent seam) ──────────

export interface TurnHooks {
  onTextDelta?(text: string): void;
  onThinkingDelta?(text: string): void;
  onAssistantEnd?(text: string): void;
  onToolCall?(tool: Tool, input: any, subject: string): void;
  onToolResult?(tool: Tool, result: ToolResult): void;
  onDenied?(toolName: string, reason: string): void;
  onCompaction?(result: CompactionResult): void;
  onRetry?(attempt: number, waitMs: number, why: string): void;
  onUsage?(totals: UsageTotals): void;
  onNotice?(text: string): void;
}

export type StopReason = "done" | "max_turns" | "aborted" | "error";

export interface TurnResult {
  stop: StopReason;
  /** The assistant's final text — what a subagent hands back to its parent. */
  text: string;
  turns: number;
  error?: Error;
}

// ── the agent ────────────────────────────────────────────────────────────────

export interface AgentOptions {
  provider: Provider;
  gate: PermissionGate;
  settings: AgentSettings;
  env: EnvSnapshot;
  /** Rebuilt every turn — that is what makes reload_extensions work (Ch. 17). */
  listTools(): Tool[];
  toolContext: ToolContext;
  /** Rendered AGENTS.md/CLAUDE.md blob, injected as a leading reminder. */
  memoryText?: string;
  hooks?: TurnHooks;
  /** Extra system-prompt sections appended behind the cache breakpoint. */
  systemExtras?: string[];
  onMessage?(m: Message): void;
}

export class Agent {
  messages: Message[] = [];
  usage: UsageTotals = emptyUsage();
  memoryText: string;
  hooks: TurnHooks;
  readonly gate: PermissionGate;
  readonly settings: AgentSettings;
  provider: Provider;
  env: EnvSnapshot;
  systemExtras: string[];

  #listTools: () => Tool[];
  #toolCtx: ToolContext;
  #onMessage?: (m: Message) => void;
  #compactionAttempts = 0;

  constructor(opts: AgentOptions) {
    this.provider = opts.provider;
    this.gate = opts.gate;
    this.settings = opts.settings;
    this.env = opts.env;
    this.#listTools = opts.listTools;
    this.#toolCtx = opts.toolContext;
    this.memoryText = opts.memoryText ?? "";
    this.hooks = opts.hooks ?? {};
    this.systemExtras = opts.systemExtras ?? [];
    this.#onMessage = opts.onMessage;
  }

  get toolContext(): ToolContext {
    return this.#toolCtx;
  }

  #push(m: Message): void {
    this.messages.push(m);
    this.#onMessage?.(m);
  }

  systemPrompt(): SystemPrompt {
    return buildSystemPrompt(this.env, this.systemExtras);
  }

  /** What actually goes on the wire: reminders + the agent-visible transcript. */
  requestMessages(): Message[] {
    const out: Message[] = [];
    const memory = buildMemoryReminder(this.memoryText);
    if (memory) out.push(memory);
    out.push(...this.messages.filter(isAgentVisible));
    const todos = buildTodoReminder(this.#toolCtx.todos);
    if (todos && out.length && out[out.length - 1].role === "user") out.push(todos);
    return out;
  }

  toolSchemas(): ToolSchema[] {
    return this.#listTools().map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }));
  }

  estimateTokens(): number {
    return estimateRequestTokens(this.requestMessages(), this.systemPrompt(), this.toolSchemas());
  }

  /** Force a compaction pass now (`/compact`). */
  async compactNow(focus?: string): Promise<CompactionResult> {
    backfillMissingToolResults(this.messages);
    const result = await compact(this.messages, this.provider, this.systemPrompt(), {
      ratio: this.settings.compactionRatio,
      recentBudget: this.settings.compactionRecentBudget,
      focus,
    });
    this.messages = result.messages;
    this.hooks.onCompaction?.(result);
    return result;
  }

  // ── THE LOOP ───────────────────────────────────────────────────────────────

  async runTurn(input: Message | string, signal?: AbortSignal): Promise<TurnResult> {
    const userMessage: Message =
      typeof input === "string" ? { role: "user", content: [{ type: "text", text: input }] } : input;
    this.#push(userMessage);
    this.#compactionAttempts = 0;

    let lastText = "";
    let turn = 0;

    while (turn < this.settings.maxTurns) {
      if (signal?.aborted) {
        backfillMissingToolResults(this.messages, "Interrupted by the user.");
        return { stop: "aborted", text: lastText, turns: turn };
      }

      // 1. CONTEXT — proactive check at the top of the iteration.
      //    Guarded by "is there anything to summarize": the system prompt and
      //    tool schemas alone can exceed a small window, and compacting an
      //    almost-empty transcript would burn a model call to make the request
      //    bigger, then do it again next iteration.
      const estimate = this.estimateTokens();
      const visibleTurns = this.messages.filter(isAgentVisible).length;
      if (visibleTurns >= 3 && shouldCompact(estimate, this.provider.contextWindow, this.settings.compactionRatio)) {
        await this.compactNow();
      }

      // 2 + 3. PROMPT and MODEL CALL.
      let assistant: Message;
      try {
        assistant = await this.#streamAssistant(signal);
      } catch (err) {
        if (err instanceof ContextLengthExceededError && this.#compactionAttempts < 2) {
          // Reactive recovery: the estimate was wrong or one tool result was
          // enormous. Compact and retry, bounded so it cannot spin.
          this.#compactionAttempts++;
          this.hooks.onNotice?.("context limit hit — compacting and retrying");
          await this.compactNow();
          continue;
        }
        if ((err as Error).name === "AbortError" || signal?.aborted) {
          backfillMissingToolResults(this.messages, "Interrupted by the user.");
          return { stop: "aborted", text: lastText, turns: turn };
        }
        return { stop: "error", text: lastText, turns: turn, error: err as Error };
      }

      turn++;
      this.#push(assistant);
      const text = assistant.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      if (text) {
        lastText = text;
        this.hooks.onAssistantEnd?.(text);
      }

      // 4. THE EXIT TEST. Read the content, not the metadata.
      const calls = assistant.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
      if (calls.length === 0) return { stop: "done", text: lastText, turns: turn };

      // 5. EXECUTE.
      const results = await this.#executeCalls(calls, signal);

      // 6. Append results as one user turn — one result per call, in order.
      this.#push({ role: "user", content: results });
    }

    this.hooks.onNotice?.(`stopped after ${this.settings.maxTurns} model calls (AGENT_MAX_TURNS)`);
    return { stop: "max_turns", text: lastText, turns: turn };
  }

  // ── one streamed model call ────────────────────────────────────────────────

  async #streamAssistant(signal?: AbortSignal): Promise<Message> {
    const blocks: ContentBlock[] = [];
    let sawUsage = false;

    for await (const ev of this.provider.stream({
      system: this.systemPrompt(),
      messages: this.requestMessages(),
      tools: this.toolSchemas(),
      maxTokens: this.settings.maxTokens,
      signal,
    })) {
      switch (ev.type) {
        case "text-delta":
          this.hooks.onTextDelta?.(ev.text);
          break;
        case "thinking-delta":
          this.hooks.onThinkingDelta?.(ev.text);
          break;
        case "block-end":
          blocks.push(ev.block);
          break;
        case "usage":
          if (!sawUsage) {
            // The provider may emit usage more than once; count the request once
            // and take the last (complete) numbers.
            this.usage.requests++;
            sawUsage = true;
          }
          addUsage(this.usage, ev.usage);
          this.hooks.onUsage?.(this.usage);
          break;
        case "finish":
          // stop_reason is advisory metadata. The exit test lives in runTurn().
          break;
      }
    }
    if (!sawUsage) this.usage.requests++;
    return { role: "assistant", content: blocks };
  }

  // ── tool execution: validate → gate → run → cap ───────────────────────────

  async #executeCalls(calls: ToolUseBlock[], signal?: AbortSignal): Promise<ToolResultBlock[]> {
    const byId = new Map<string, ToolResultBlock>();
    const tools = this.#listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));

    for (const batch of partitionBySafety(calls, byName, this.settings.maxToolConcurrency)) {
      if (signal?.aborted) break;
      const settled = await Promise.all(batch.map((c) => this.#runOne(c, byName, signal)));
      for (const r of settled) byId.set(r.tool_use_id, r);
    }

    // The pairing invariant, enforced at the point it matters: exactly one
    // result per call, in the order the model asked for them.
    return calls.map(
      (c) =>
        byId.get(c.id) ?? {
          type: "tool_result",
          tool_use_id: c.id,
          content: "Interrupted before this tool ran.",
          is_error: true,
        },
    );
  }

  async #runOne(
    call: ToolUseBlock,
    byName: Map<string, Tool>,
    signal?: AbortSignal,
  ): Promise<ToolResultBlock> {
    const fail = (content: string): ToolResultBlock => ({
      type: "tool_result",
      tool_use_id: call.id,
      content,
      is_error: true,
    });

    const tool = byName.get(call.name);
    if (!tool) {
      return fail(`Unknown tool "${call.name}". Available tools: ${[...byName.keys()].join(", ")}.`);
    }

    // 5a. VALIDATE. A schema failure is a RESULT, not a crash — the model reads
    //     the message and corrects itself on the next turn.
    const invalid = validateInput(call.input, tool.input_schema);
    if (invalid) return fail(`Invalid input for ${tool.name}: ${invalid}`);

    const ctx: ToolContext = { ...this.#toolCtx, signal };
    const subject = permissionSubject(tool, call.input, ctx);

    // 5b. GATE, before any side effect. The call is announced after the gate so
    //     an approval prompt is not immediately duplicated by the tool line.
    const decision = this.gate.decide(tool, call.input, ctx);
    if (decision.action === "deny") {
      this.hooks.onDenied?.(tool.name, decision.reason);
      return fail(`Permission denied: ${decision.reason}. Do not retry this call; take a different approach or ask the user.`);
    }
    if (decision.action === "ask") {
      const ok = await this.gate.prompt(tool, call.input, ctx, decision);
      if (!ok) {
        const why = this.gate.interactive
          ? "The user declined this action."
          : `This action needed approval (${decision.reason}) and the agent is running non-interactively, so it was refused.`;
        this.hooks.onDenied?.(tool.name, this.gate.interactive ? "the user declined" : `needs approval: ${decision.reason}`);
        return fail(`${why} Do not retry it; take a different approach or report what you would need.`);
      }
    }

    // 5c. RUN. Tool exceptions are results too.
    this.hooks.onToolCall?.(tool, call.input, subject);
    let result: ToolResult;
    try {
      result = await tool.run(call.input, ctx);
    } catch (err) {
      result = { content: `${tool.name} threw: ${(err as Error).message}`, isError: true };
    }
    result = await capAndSpill(result, tool.maxResultChars ?? this.settings.maxToolResultChars, ctx, tool.name);
    this.hooks.onToolResult?.(tool, result);

    return {
      type: "tool_result",
      tool_use_id: call.id,
      content: result.content || "(no output)",
      is_error: result.isError,
    };
  }
}

// ── batching: consecutive read-only calls run together, writers run alone ────

export function partitionBySafety(
  calls: ToolUseBlock[],
  byName: Map<string, Tool>,
  cap: number,
): ToolUseBlock[][] {
  const batches: ToolUseBlock[][] = [];
  let current: ToolUseBlock[] = [];
  for (const c of calls) {
    const readOnly = byName.get(c.name)?.readOnly === true;
    if (readOnly && current.length < cap) {
      current.push(c);
      continue;
    }
    if (current.length) batches.push(current);
    current = [];
    if (readOnly) current.push(c);
    else batches.push([c]); // a writer is its own serial batch
  }
  if (current.length) batches.push(current);
  return batches;
}

// ── minimal JSON-Schema validation ───────────────────────────────────────────
//
// Enough to catch the failures models actually make — a missing required field
// or a string where an array belongs — without a schema library. Returns an
// error string, or undefined when the input is acceptable.

export function validateInput(input: unknown, schema: Record<string, any>): string | undefined {
  if (schema?.type !== "object") return undefined;
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return `expected an object, got ${Array.isArray(input) ? "an array" : typeof input}`;
  }
  const obj = input as Record<string, unknown>;
  const props = (schema.properties ?? {}) as Record<string, any>;

  for (const req of (schema.required ?? []) as string[]) {
    if (obj[req] === undefined || obj[req] === null) return `missing required property "${req}"`;
  }
  for (const [key, value] of Object.entries(obj)) {
    const spec = props[key];
    if (!spec?.type || value === undefined || value === null) continue;
    const actual = Array.isArray(value) ? "array" : typeof value;
    const expected = spec.type === "integer" ? "number" : spec.type;
    if (expected === "number" && actual === "number") {
      if (spec.type === "integer" && !Number.isInteger(value)) return `"${key}" must be an integer`;
      continue;
    }
    if (actual !== expected) return `"${key}" must be a ${spec.type}, got ${actual}`;
    if (spec.enum && !spec.enum.includes(value)) return `"${key}" must be one of: ${spec.enum.join(", ")}`;
  }
  return undefined;
}

// ── subagents: recurse the loop with a child context (Ch. 13) ────────────────

export interface SubagentOptions {
  provider: Provider;
  gate: PermissionGate;
  settings: AgentSettings;
  env: EnvSnapshot;
  tools: Tool[];
  system: SystemPrompt;
  toolContext: ToolContext;
  hooks?: TurnHooks;
  maxTurns?: number;
}

/**
 * A subagent is not a new runtime — it is this same Agent with its own message
 * list, a filtered tool set, and a lower step limit. Its final text becomes the
 * parent's tool result.
 */
export async function runSubagent(prompt: string, opts: SubagentOptions, signal?: AbortSignal): Promise<string> {
  const child = new Agent({
    provider: opts.provider,
    gate: opts.gate,
    settings: { ...opts.settings, maxTurns: opts.maxTurns ?? Math.min(20, opts.settings.maxTurns) },
    env: opts.env,
    listTools: () => opts.tools,
    toolContext: { ...opts.toolContext, runSubagent: undefined, reloadExtensions: undefined },
    hooks: opts.hooks,
  });
  // Override the system prompt with the subagent's own.
  child.systemPrompt = () => opts.system;

  const result = await child.runTurn(prompt, signal);
  const suffix =
    result.stop === "max_turns"
      ? "\n\n(the subagent hit its step limit; this result may be incomplete)"
      : result.stop === "error"
        ? `\n\n(the subagent errored: ${result.error?.message})`
        : "";
  return (result.text || "(the subagent produced no final text)") + suffix;
}

export type { CompactionResult, TodoItem };
