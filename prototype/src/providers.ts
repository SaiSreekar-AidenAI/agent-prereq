// providers.ts — THE PROVIDER LAYER (Ch. 4).
//
// One job: `stream(request) -> AsyncGenerator<StreamEvent>`. Two wire formats
// are implemented — Anthropic Messages and OpenAI Chat Completions — and both
// translate INWARD to the same canonical event union, so the loop above never
// learns which one it is talking to.
//
//   anthropic          → api.anthropic.com/v1/messages
//   openai             → api.openai.com/v1/chat/completions
//   openrouter         → openrouter.ai/api/v1/chat/completions   (OpenAI shape)
//   openai-compatible  → any base URL speaking the OpenAI shape
//                        (Ollama, vLLM, LM Studio, Groq, Together, LiteLLM, …)
//
// The two rules that make this layer correct, both from Ch. 4:
//   1. Accumulate tool-call arguments as a STRING and JSON.parse exactly once at
//      block close, with a `{}` fallback. Never parse a partial.
//   2. `stop_reason` is metadata. The loop's exit test reads the content.

import type {
  ContentBlock,
  Message,
  Provider,
  ProviderRequest,
  StreamEvent,
  ToolSchema,
  UsageDelta,
} from "./types.ts";
import { ContextLengthExceededError, ProviderError, isAgentVisible } from "./types.ts";
import type { ProviderProfile } from "./config.ts";
import { keyVarFor } from "./config.ts";

// ── shared: SSE reader ───────────────────────────────────────────────────────
// Server-Sent Events framing: records separated by a blank line; each record has
// one or more `field: value` lines. We only care about `data:`.

async function* sseRecords(res: Response, signal?: AbortSignal): AsyncGenerator<string> {
  if (!res.body) throw new ProviderError(res.status, "Response had no body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Records end at a blank line. Tolerate both LF and CRLF framing.
      let sep: number;
      while ((sep = findRecordEnd(buffer)) !== -1) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep).replace(/^(\r?\n){2}/, "");
        const data = raw
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("\n");
        if (data) yield data;
      }
    }
    const tail = buffer
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .join("\n");
    if (tail) yield tail;
  } finally {
    reader.releaseLock?.();
  }
}

function findRecordEnd(buffer: string): number {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf === -1) return crlf;
  if (crlf === -1) return lf;
  return Math.min(lf, crlf);
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// ── shared: retry ────────────────────────────────────────────────────────────
// Exponential backoff with jitter, honouring `retry-after`. Retry the transport
// errors and the "come back later" statuses; never retry a 400 — that is a bug
// in our request, and retrying it just burns time (Ch. 4 "Lean take").

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
const MAX_ATTEMPTS = 4;
const BASE_DELAY_MS = 800;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}

function backoffMs(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 60_000);
  }
  const base = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), 32_000);
  return base * (0.75 + Math.random() * 0.5); // ±25% jitter
}

/** Detect the one provider error the loop can actually recover from (Ch. 6). */
function looksLikeContextOverflow(status: number, body: string): boolean {
  if (status !== 400 && status !== 413) return false;
  const s = body.toLowerCase();
  return (
    s.includes("context_length_exceeded") ||
    s.includes("context length") ||
    s.includes("context window") ||
    s.includes("prompt is too long") ||
    s.includes("too many tokens") ||
    s.includes("maximum context")
  );
}

async function postWithRetry(
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
  onRetry?: (attempt: number, waitMs: number, why: string) => void,
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal });
    } catch (err) {
      if (signal?.aborted) throw err;
      lastErr = err;
      if (attempt === MAX_ATTEMPTS) break;
      const wait = backoffMs(attempt, null);
      onRetry?.(attempt, wait, (err as Error).message);
      await sleep(wait, signal);
      continue;
    }
    if (res.ok) return res;

    const body = await res.text();
    if (looksLikeContextOverflow(res.status, body)) {
      throw new ContextLengthExceededError(body.slice(0, 500));
    }
    if (!RETRYABLE.has(res.status) || attempt === MAX_ATTEMPTS) {
      throw new ProviderError(res.status, `HTTP ${res.status}: ${body.slice(0, 800)}`);
    }
    const wait = backoffMs(attempt, res.headers.get("retry-after"));
    onRetry?.(attempt, wait, `HTTP ${res.status}`);
    await sleep(wait, signal);
  }
  throw new ProviderError(0, `Network error after ${MAX_ATTEMPTS} attempts: ${(lastErr as Error)?.message}`);
}

const ZERO_USAGE: UsageDelta = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

// ── Anthropic Messages API ───────────────────────────────────────────────────

/**
 * Convert a canonical message to Anthropic's shape.
 *
 * Almost the identity function — that is the point of picking this as the
 * canonical format. The only real work is dropping thinking blocks that have no
 * signature (the API rejects those) and dropping messages that end up empty.
 */
function toAnthropicMessages(messages: Message[]): any[] {
  const out: any[] = [];
  for (const m of messages) {
    if (!isAgentVisible(m)) continue;
    const content: any[] = [];
    for (const b of m.content) {
      if (b.type === "thinking") {
        if (b.signature) content.push({ type: "thinking", thinking: b.thinking, signature: b.signature });
        continue;
      }
      if (b.type === "text") {
        if (b.text.length > 0) content.push({ type: "text", text: b.text });
        continue;
      }
      if (b.type === "tool_use") {
        content.push({ type: "tool_use", id: b.id, name: b.name, input: b.input ?? {} });
        continue;
      }
      content.push({
        type: "tool_result",
        tool_use_id: b.tool_use_id,
        content: b.content,
        ...(b.is_error ? { is_error: true } : {}),
      });
    }
    if (content.length > 0) out.push({ role: m.role, content });
  }
  return out;
}

/**
 * The system prompt as two blocks with ONE cache breakpoint (Ch. 5).
 * Prefix is byte-stable for the session and carries `cache_control`; the
 * dynamic suffix sits behind it so editing cwd/date/model never invalidates
 * the cached prefix or the tool schemas that render before it.
 */
function toAnthropicSystem(req: ProviderRequest): any[] {
  const blocks: any[] = [
    { type: "text", text: req.system.cacheablePrefix, cache_control: { type: "ephemeral" } },
  ];
  if (req.system.dynamicSuffix.trim()) blocks.push({ type: "text", text: req.system.dynamicSuffix });
  return blocks;
}

class AnthropicProvider implements Provider {
  readonly id = "anthropic";
  readonly label: string;
  readonly model: string;
  readonly contextWindow: number;
  #profile: ProviderProfile;
  #onRetry?: (attempt: number, waitMs: number, why: string) => void;

  constructor(profile: ProviderProfile, onRetry?: (a: number, w: number, why: string) => void) {
    this.#profile = profile;
    this.model = profile.model;
    this.contextWindow = profile.contextWindow;
    this.label = `anthropic/${profile.model}`;
    this.#onRetry = onRetry;
  }

  async *stream(req: ProviderRequest): AsyncGenerator<StreamEvent> {
    if (!this.#profile.apiKey) {
      throw new ProviderError(401, `Missing ${keyVarFor("anthropic")}`);
    }
    const body = {
      model: this.model,
      max_tokens: req.maxTokens,
      system: toAnthropicSystem(req),
      messages: toAnthropicMessages(req.messages),
      // Tool descriptions travel here, never in the prose (Ch. 5). Sorted by
      // name so the bytes are stable across turns and the cache actually hits.
      tools: [...req.tools]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
      stream: true,
      // NOTE: no `temperature`/`top_p`. Current Claude models reject sampling
      // parameters outright (400), and defaults are what you want anyway.
    };

    const res = await postWithRetry(
      `${this.#profile.baseUrl}/v1/messages`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.#profile.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
      },
      req.signal,
      this.#onRetry,
    );

    // Indexed block accumulation. `input` starts as an empty STRING for
    // tool_use blocks — that is the accumulator, not an object.
    const blocks = new Map<number, any>();
    const usage: UsageDelta = { ...ZERO_USAGE };

    for await (const data of sseRecords(res, req.signal)) {
      const ev = safeJson(data);
      if (!ev) continue;

      switch (ev.type) {
        case "message_start": {
          const u = ev.message?.usage ?? {};
          usage.input += u.input_tokens ?? 0;
          usage.output += u.output_tokens ?? 0;
          usage.cacheRead += u.cache_read_input_tokens ?? 0;
          usage.cacheWrite += u.cache_creation_input_tokens ?? 0;
          break;
        }
        case "content_block_start": {
          const cb = ev.content_block ?? {};
          if (cb.type === "tool_use") {
            blocks.set(ev.index, { type: "tool_use", id: cb.id, name: cb.name, input: "" });
          } else if (cb.type === "thinking") {
            blocks.set(ev.index, { type: "thinking", thinking: cb.thinking ?? "", signature: cb.signature });
          } else if (cb.type === "text") {
            blocks.set(ev.index, { type: "text", text: cb.text ?? "" });
          } else {
            // Unknown block type (server tool result, etc.) — keep it out of the
            // canonical transcript rather than guessing at its shape.
            blocks.set(ev.index, { type: "__ignored__" });
          }
          break;
        }
        case "content_block_delta": {
          const b = blocks.get(ev.index);
          if (!b) break;
          const d = ev.delta ?? {};
          if (d.type === "text_delta" && b.type === "text") {
            b.text += d.text ?? "";
            yield { type: "text-delta", text: d.text ?? "" };
          } else if (d.type === "thinking_delta" && b.type === "thinking") {
            b.thinking += d.thinking ?? "";
            yield { type: "thinking-delta", text: d.thinking ?? "" };
          } else if (d.type === "signature_delta" && b.type === "thinking") {
            b.signature = (b.signature ?? "") + (d.signature ?? "");
          } else if (d.type === "input_json_delta" && b.type === "tool_use") {
            b.input += d.partial_json ?? ""; // raw characters; NOT parsed here
          }
          break;
        }
        case "content_block_stop": {
          const b = blocks.get(ev.index);
          blocks.delete(ev.index);
          if (!b || b.type === "__ignored__") break;
          if (b.type === "tool_use") {
            // THE parse. Exactly once, at close, with an empty-object fallback so
            // a truncated stream degrades into a validation error the model can
            // fix instead of a crash.
            b.input = safeJson(b.input) ?? {};
          }
          yield { type: "block-end", block: b as ContentBlock };
          break;
        }
        case "message_delta": {
          const u = ev.usage ?? {};
          usage.output = u.output_tokens ?? usage.output;
          if (u.input_tokens) usage.input = u.input_tokens;
          yield { type: "usage", usage: { ...usage } };
          yield { type: "finish", stopReason: ev.delta?.stop_reason ?? null };
          break;
        }
        case "error": {
          const msg = ev.error?.message ?? "unknown streaming error";
          if (looksLikeContextOverflow(400, msg)) throw new ContextLengthExceededError(msg);
          throw new ProviderError(0, `Anthropic stream error: ${msg}`);
        }
        default:
          break; // ping, message_stop
      }
    }
    yield { type: "usage", usage: { ...usage } };
  }
}

// ── OpenAI Chat Completions (also OpenRouter and every compatible server) ────

/**
 * Canonical → OpenAI. This is where the format is genuinely lossy in one
 * direction, and the translation has three real rules:
 *   - a user message carrying tool_result blocks becomes one `role:"tool"`
 *     message PER result (OpenAI has no multi-result user turn);
 *   - an assistant message carrying tool_use blocks becomes one message with a
 *     `tool_calls` array and arguments serialized back to a JSON string;
 *   - thinking blocks are dropped — there is no portable field for them.
 */
function toOpenAIMessages(req: ProviderRequest): any[] {
  const out: any[] = [];
  const system = [req.system.cacheablePrefix, req.system.dynamicSuffix].filter((s) => s.trim()).join("\n\n");
  if (system) out.push({ role: "system", content: system });

  for (const m of req.messages) {
    if (!isAgentVisible(m)) continue;

    const toolResults = m.content.filter((b) => b.type === "tool_result");
    const texts = m.content.filter((b) => b.type === "text").map((b) => b.text).filter(Boolean);
    const toolUses = m.content.filter((b) => b.type === "tool_use");

    if (m.role === "user") {
      // tool results first: OpenAI requires each to directly follow the
      // assistant turn that requested it.
      for (const r of toolResults) {
        out.push({
          role: "tool",
          tool_call_id: r.tool_use_id,
          content: r.is_error ? `ERROR: ${r.content}` : r.content,
        });
      }
      if (texts.length) out.push({ role: "user", content: texts.join("\n\n") });
      continue;
    }

    if (texts.length === 0 && toolUses.length === 0) continue;
    const msg: any = { role: "assistant", content: texts.join("\n\n") || null };
    if (toolUses.length) {
      msg.tool_calls = toolUses.map((t) => ({
        id: t.id,
        type: "function",
        function: { name: t.name, arguments: JSON.stringify(t.input ?? {}) },
      }));
    }
    out.push(msg);
  }
  return out;
}

function toOpenAITools(tools: ToolSchema[]): any[] {
  return [...tools]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));
}

class OpenAIProvider implements Provider {
  readonly id: string;
  readonly label: string;
  readonly model: string;
  readonly contextWindow: number;
  #profile: ProviderProfile;
  #onRetry?: (attempt: number, waitMs: number, why: string) => void;

  constructor(profile: ProviderProfile, onRetry?: (a: number, w: number, why: string) => void) {
    this.#profile = profile;
    this.id = profile.id;
    this.model = profile.model;
    this.contextWindow = profile.contextWindow;
    this.label = `${profile.id}/${profile.model}`;
    this.#onRetry = onRetry;
  }

  #headers(): Record<string, string> {
    const h: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${this.#profile.apiKey}`,
    };
    if (this.#profile.id === "openrouter") {
      // OpenRouter uses these for attribution on its dashboards; harmless elsewhere.
      h["HTTP-Referer"] = process.env.OPENROUTER_SITE_URL ?? "https://github.com/agent-prereq";
      h["X-Title"] = process.env.OPENROUTER_APP_NAME ?? "lean-agent";
    }
    return h;
  }

  async *stream(req: ProviderRequest): AsyncGenerator<StreamEvent> {
    if (!this.#profile.apiKey && this.#profile.id !== "openai-compatible") {
      throw new ProviderError(401, `Missing ${keyVarFor(this.#profile.id)}`);
    }
    const body: Record<string, unknown> = {
      model: this.model,
      messages: toOpenAIMessages(req),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (req.tools.length) {
      body.tools = toOpenAITools(req.tools);
      body.tool_choice = "auto";
    }
    if (this.#profile.usesMaxCompletionTokens) body.max_completion_tokens = req.maxTokens;
    else body.max_tokens = req.maxTokens;

    const res = await postWithRetry(
      `${this.#profile.baseUrl}/chat/completions`,
      { method: "POST", headers: this.#headers(), body: JSON.stringify(body) },
      req.signal,
      this.#onRetry,
    );

    // OpenAI has no content_block_stop, so we accumulate per tool-call index and
    // flush everything when the stream ends. Same rule as Anthropic: the
    // arguments string is only parsed once, at flush.
    const calls = new Map<number, { id: string; name: string; args: string }>();
    let text = "";
    let thinking = "";
    let stopReason: string | null = null;
    const usage: UsageDelta = { ...ZERO_USAGE };

    for await (const data of sseRecords(res, req.signal)) {
      if (data === "[DONE]") break;
      const ev = safeJson(data);
      if (!ev) continue;
      if (ev.error) {
        const msg = typeof ev.error === "string" ? ev.error : ev.error.message ?? JSON.stringify(ev.error);
        if (looksLikeContextOverflow(400, msg)) throw new ContextLengthExceededError(msg);
        throw new ProviderError(0, `Provider stream error: ${msg}`);
      }

      if (ev.usage) {
        usage.input = ev.usage.prompt_tokens ?? usage.input;
        usage.output = ev.usage.completion_tokens ?? usage.output;
        usage.cacheRead = ev.usage.prompt_tokens_details?.cached_tokens ?? usage.cacheRead;
      }

      const choice = ev.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) stopReason = choice.finish_reason;
      const delta = choice.delta ?? {};

      if (typeof delta.content === "string" && delta.content) {
        text += delta.content;
        yield { type: "text-delta", text: delta.content };
      }
      // OpenRouter and several local servers surface reasoning here.
      const reason = delta.reasoning ?? delta.reasoning_content;
      if (typeof reason === "string" && reason) {
        thinking += reason;
        yield { type: "thinking-delta", text: reason };
      }

      for (const tc of delta.tool_calls ?? []) {
        const idx = tc.index ?? 0;
        const cur = calls.get(idx) ?? { id: "", name: "", args: "" };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments; // raw chars
        calls.set(idx, cur);
      }
    }

    // Flush in a fixed order: thinking, then text, then tool calls by index —
    // so the assistant message reads the same way it would from Anthropic.
    if (thinking) yield { type: "block-end", block: { type: "thinking", thinking } };
    if (text) yield { type: "block-end", block: { type: "text", text } };
    for (const idx of [...calls.keys()].sort((a, b) => a - b)) {
      const c = calls.get(idx)!;
      if (!c.name) continue;
      yield {
        type: "block-end",
        block: {
          type: "tool_use",
          id: c.id || `call_${idx}_${Date.now().toString(36)}`,
          name: c.name,
          input: safeJson(c.args) ?? {},
        },
      };
    }
    yield { type: "usage", usage: { ...usage } };
    yield { type: "finish", stopReason };
  }
}

// ── factory ──────────────────────────────────────────────────────────────────

export function createProvider(
  profile: ProviderProfile,
  onRetry?: (attempt: number, waitMs: number, why: string) => void,
): Provider {
  if (profile.id === "anthropic") return new AnthropicProvider(profile, onRetry);
  if (profile.id === "mock") throw new Error("Use createMockProvider() from mock.ts for the mock profile");
  return new OpenAIProvider(profile, onRetry);
}
