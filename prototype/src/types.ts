// types.ts — THE CANONICAL WIRE FORMAT (Ch. 2 "Messages & State", Ch. 4 "Provider Layer")
//
// One shape for the whole agent. Every provider translates INTO these types and
// nothing above the provider layer ever sees a provider-specific field. That is
// openclaude's "canonical-format-as-interface" idea (docs/openclaude.md): pick a
// block shape, make it the interface, write translators — don't branch the loop.
//
// The shape chosen is Anthropic's content-block model, for two reasons:
//   1. It is strictly the richer of the two mainstream formats (OpenAI's
//      chat-completions shape is a lossy projection of it, not vice-versa), so
//      Anthropic → OpenAI is a total function while the reverse is not.
//   2. Indexed blocks make streaming assembly trivial (Ch. 4).

// ── content blocks ───────────────────────────────────────────────────────────

export interface TextBlock {
  type: "text";
  text: string;
}

/**
 * Extended-thinking output. We keep it verbatim (including `signature`) because
 * Anthropic REQUIRES thinking blocks to be echoed back unmodified on the next
 * turn of the same conversation; editing or dropping them is a 400. Providers
 * that have no equivalent simply drop these on the way out.
 */
export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock;

// ── messages ─────────────────────────────────────────────────────────────────

export type Role = "user" | "assistant";

/**
 * A message in the transcript.
 *
 * `agentVisible` / `userVisible` are goose's dual-visibility flags (Ch. 6): they
 * let compaction HIDE history from the model without destroying the user's
 * transcript. The model sees `agentVisible !== false`; the UI shows
 * `userVisible !== false`. Both default to true so callers can ignore them.
 *
 * `meta` marks injected context (memory files, <system-reminder> blocks) so the
 * UI can hide it and compaction can rebuild it rather than summarize it.
 */
export interface Message {
  role: Role;
  content: ContentBlock[];
  agentVisible?: boolean;
  userVisible?: boolean;
  meta?: boolean;
}

export function userText(text: string, extra: Partial<Message> = {}): Message {
  return { role: "user", content: [{ type: "text", text }], ...extra };
}

export function assistantText(text: string, extra: Partial<Message> = {}): Message {
  return { role: "assistant", content: [{ type: "text", text }], ...extra };
}

export function isAgentVisible(m: Message): boolean {
  return m.agentVisible !== false;
}

export function isUserVisible(m: Message): boolean {
  return m.userVisible !== false;
}

/** Every tool_use block the assistant emitted across the whole transcript. */
export function toolUsesIn(messages: Message[]): ToolUseBlock[] {
  const out: ToolUseBlock[] = [];
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const b of m.content) if (b.type === "tool_use") out.push(b);
  }
  return out;
}

/**
 * THE PAIRING INVARIANT (Ch. 1, Ch. 2).
 *
 * Every `tool_use` must have a matching `tool_result` before the next model
 * call, or the API 400s on unpaired blocks. Any abort/crash/ctrl-C path can
 * leave a hole, so we back-fill a synthetic error result rather than trying to
 * prove no such path exists. claude-code calls this `yieldMissingToolResultBlocks`.
 *
 * Mutates `messages` in place and returns how many holes were filled.
 */
export function backfillMissingToolResults(messages: Message[], reason = "Interrupted before this tool produced a result."): number {
  const answered = new Set<string>();
  for (const m of messages) {
    for (const b of m.content) if (b.type === "tool_result") answered.add(b.tool_use_id);
  }
  const missing = toolUsesIn(messages).filter((tu) => !answered.has(tu.id));
  if (missing.length === 0) return 0;
  messages.push({
    role: "user",
    content: missing.map((tu) => ({
      type: "tool_result" as const,
      tool_use_id: tu.id,
      content: reason,
      is_error: true,
    })),
    meta: true,
  });
  return missing.length;
}

// ── provider stream events ───────────────────────────────────────────────────
//
// The internal event union. The loop switches on THESE, never on raw SSE. codex
// makes the same choice with its typed `ResponseEvent` enum (docs/codex.md).

export interface UsageDelta {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export type StreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "thinking-delta"; text: string }
  | { type: "block-end"; block: ContentBlock }
  | { type: "usage"; usage: UsageDelta }
  | { type: "finish"; stopReason: string | null };

// ── provider interface ───────────────────────────────────────────────────────

export interface ToolSchema {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface SystemPrompt {
  /** Byte-stable for the whole session — carries the cache breakpoint. */
  cacheablePrefix: string;
  /** Volatile: env, cwd, date, model. Sits behind the breakpoint. */
  dynamicSuffix: string;
}

export interface ProviderRequest {
  system: SystemPrompt;
  messages: Message[];
  tools: ToolSchema[];
  maxTokens: number;
  signal?: AbortSignal;
}

export interface Provider {
  /** Stable id: "anthropic" | "openai" | "openrouter" | "openai-compatible". */
  readonly id: string;
  /** Human-facing label, e.g. "anthropic/claude-opus-5". */
  readonly label: string;
  readonly model: string;
  /** Total context window in tokens; drives the compaction threshold (Ch. 6). */
  readonly contextWindow: number;
  stream(req: ProviderRequest): AsyncGenerator<StreamEvent>;
}

/** Thrown when the provider says the request exceeded the context window. */
export class ContextLengthExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextLengthExceededError";
  }
}

/** Thrown for a non-retryable provider error, with the HTTP status attached. */
export class ProviderError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
  }
}
