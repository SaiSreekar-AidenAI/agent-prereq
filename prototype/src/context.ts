// context.ts — CONTEXT MANAGEMENT & COMPACTION (Ch. 6).
//
// Four separable concerns, kept separate:
//   1. a cheap token estimate      — ceil(bytes/4), codex's heuristic
//   2. when to compact             — proactive threshold + reactive on a real
//                                    context-length error, both calling the
//                                    same compact()
//   3. how to compact              — one summarization pass, then REBUILD the
//                                    history as [summary] + [recent user turns]
//   4. don't delete — hide         — goose's dual visibility: compacted-away
//                                    messages stay in the transcript for the
//                                    user, they just stop being agent-visible
//
// Below summarization sits the cheaper tier that costs no model call at all:
// capping each tool result and spilling the overflow to disk. That lives in
// tools.ts (`capAndSpill`) because it belongs to the tool, and it removes the
// most common cause of blowups before this file is ever reached.

import type { Message, Provider, SystemPrompt, ToolSchema } from "./types.ts";
import { isAgentVisible, userText } from "./types.ts";
import { COMPACTION_PROMPT } from "./prompt.ts";

/** codex's `approx_token_count`: ceiling division of UTF-8 bytes by 4. */
export function approxTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

export function messageTokens(m: Message): number {
  let n = 4; // per-message envelope overhead
  for (const b of m.content) {
    if (b.type === "text") n += approxTokens(b.text);
    else if (b.type === "thinking") n += approxTokens(b.thinking);
    else if (b.type === "tool_use") n += approxTokens(b.name) + approxTokens(JSON.stringify(b.input ?? {}));
    else n += approxTokens(b.content);
  }
  return n;
}

export function estimateRequestTokens(
  messages: Message[],
  system: SystemPrompt,
  tools: ToolSchema[],
): number {
  let n = approxTokens(system.cacheablePrefix) + approxTokens(system.dynamicSuffix);
  for (const t of tools) n += approxTokens(t.name + t.description + JSON.stringify(t.input_schema));
  for (const m of messages) if (isAgentVisible(m)) n += messageTokens(m);
  return n;
}

export interface CompactionOptions {
  /** Fraction of the window at which to compact proactively (goose: 0.8). */
  ratio: number;
  /** Tokens of trailing user turns preserved verbatim (codex: ~20k). */
  recentBudget: number;
  /** Extra instruction from `/compact <focus>`. */
  focus?: string;
}

export function shouldCompact(estimate: number, contextWindow: number, ratio: number): boolean {
  return estimate > contextWindow * ratio;
}

export interface CompactionResult {
  messages: Message[];
  summary: string;
  before: number;
  after: number;
}

/**
 * One summarize-and-rebuild pass.
 *
 * The rebuilt history is `[summary] + [recent text-only user turns]`. Only
 * TEXT-only user turns are preserved because a user turn carrying tool_result
 * blocks would reference tool_use blocks we just hid — and an unpaired
 * tool_result is a 400. goose makes the same simplification.
 */
export async function compact(
  messages: Message[],
  provider: Provider,
  system: SystemPrompt,
  opts: CompactionOptions,
  onDelta?: (text: string) => void,
): Promise<CompactionResult> {
  const visible = messages.filter(isAgentVisible);
  const before = visible.reduce((n, m) => n + messageTokens(m), 0);
  if (!visible.length) return { messages, summary: "", before, after: before };

  const instruction = opts.focus
    ? `${COMPACTION_PROMPT}\n\nThe user asked you to pay particular attention to: ${opts.focus}`
    : COMPACTION_PROMPT;

  // The summarizer is the same provider with no tools — it must not act, only
  // describe. Reusing the same system prompt keeps the cached prefix warm.
  let summary = "";
  for await (const ev of provider.stream({
    system,
    messages: [...visible, userText(instruction)],
    tools: [],
    maxTokens: 4096,
  })) {
    if (ev.type === "text-delta") {
      summary += ev.text;
      onDelta?.(ev.text);
    }
  }
  summary = summary.trim();
  const inner = /<summary>([\s\S]*?)<\/summary>/i.exec(summary);
  if (inner) summary = inner[1].trim();
  if (!summary) summary = "(the summarizer returned nothing; the transcript was truncated instead)";

  // Preserve the trailing text-only user turns, newest-first up to the budget,
  // always keeping at least the most recent one.
  const recent: Message[] = [];
  let budget = opts.recentBudget;
  for (let i = visible.length - 1; i >= 0; i--) {
    const m = visible[i];
    if (m.role !== "user" || m.meta) continue;
    if (m.content.some((b) => b.type !== "text")) continue;
    const cost = messageTokens(m);
    if (recent.length && cost > budget) break;
    budget -= cost;
    recent.unshift({ ...m });
  }

  // Hide, don't delete: the user's transcript stays whole.
  for (const m of messages) m.agentVisible = false;

  const rebuilt: Message[] = [
    ...messages,
    userText(
      `<system-reminder>\nThe conversation so far was compacted to fit the context window. ` +
        `This summary replaces it; treat it as fact and continue the work.\n\n<summary>\n${summary}\n</summary>\n</system-reminder>`,
      { meta: true, userVisible: false },
    ),
    ...recent,
  ];

  const after = rebuilt.filter(isAgentVisible).reduce((n, m) => n + messageTokens(m), 0);
  return { messages: rebuilt, summary, before, after };
}
