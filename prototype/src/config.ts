// config.ts — resolving WHICH model, WHICH provider, and WHERE to send it.
//
// The whole multi-provider story lives in two small tables plus a resolver.
// Everything above this file is provider-agnostic (Ch. 4 "Lean take": one
// canonical shape, translators at the edge, no branching in the loop).

import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Root for everything the agent keeps on disk: sessions, user-level AGENTS.md,
 * user-level slash commands. Overridable so tests (and sandboxes) never touch
 * the real home directory.
 */
export function agentHome(): string {
  return process.env.AGENT_HOME?.trim() || join(homedir(), ".agent");
}

export type ProviderId ="anthropic" | "openai" | "openrouter" | "openai-compatible" | "mock";

export interface ProviderProfile {
  id: ProviderId;
  /** Base URL WITHOUT a trailing slash; the client appends the path. */
  baseUrl: string;
  apiKey: string;
  model: string;
  contextWindow: number;
  /** OpenAI renamed `max_tokens` → `max_completion_tokens` for its newer models. */
  usesMaxCompletionTokens: boolean;
  /** USD per 1M tokens; undefined when we do not have a trustworthy number. */
  price?: { input: number; output: number };
}

// ── model catalog ────────────────────────────────────────────────────────────
// Only Anthropic prices are listed: those are the ones we can state accurately.
// For every other model /cost reports tokens and says the price is unknown
// rather than inventing a number.

interface ModelInfo {
  contextWindow: number;
  price?: { input: number; output: number };
}

const ANTHROPIC_MODELS: Record<string, ModelInfo> = {
  "claude-opus-5": { contextWindow: 1_000_000, price: { input: 5, output: 25 } },
  "claude-opus-4-8": { contextWindow: 1_000_000, price: { input: 5, output: 25 } },
  "claude-opus-4-7": { contextWindow: 1_000_000, price: { input: 5, output: 25 } },
  "claude-opus-4-6": { contextWindow: 1_000_000, price: { input: 5, output: 25 } },
  "claude-sonnet-5": { contextWindow: 1_000_000, price: { input: 3, output: 15 } },
  "claude-sonnet-4-6": { contextWindow: 1_000_000, price: { input: 3, output: 15 } },
  "claude-haiku-4-5": { contextWindow: 200_000, price: { input: 1, output: 5 } },
  "claude-fable-5": { contextWindow: 1_000_000, price: { input: 10, output: 50 } },
};

export const DEFAULT_MODELS: Record<Exclude<ProviderId, "mock">, string> = {
  anthropic: "claude-opus-5",
  openai: "gpt-5",
  openrouter: "anthropic/claude-opus-5",
  "openai-compatible": "local-model",
};

const DEFAULT_BASE_URLS: Record<Exclude<ProviderId, "mock">, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  "openai-compatible": "http://localhost:11434/v1",
};

/** Fallback window when the model is not in the catalog. Override with AGENT_CONTEXT_WINDOW. */
const FALLBACK_CONTEXT_WINDOW = 128_000;

// ── inference ────────────────────────────────────────────────────────────────

/**
 * Guess the provider from the model id. This is the ergonomic bit: `--model
 * gpt-5` should just work without also passing `--provider openai`.
 *   - anything with a "/" is an OpenRouter-style `vendor/model` slug
 *   - claude-* → Anthropic
 *   - gpt-*, o1/o3/o4-* → OpenAI
 */
export function providerForModel(model: string): ProviderId | undefined {
  if (!model) return undefined;
  if (model.includes("/")) return "openrouter";
  if (model.startsWith("claude-")) return "anthropic";
  if (/^(gpt-|o[1-9](-|$)|chatgpt-)/.test(model)) return "openai";
  return undefined;
}

/** OpenAI rejects `max_tokens` on its reasoning-era models; they want `max_completion_tokens`. */
function needsMaxCompletionTokens(id: ProviderId, model: string): boolean {
  if (id !== "openai") return false;
  return /^(gpt-[5-9]|o[1-9])/.test(model);
}

function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

function keyFor(id: ProviderId): string {
  switch (id) {
    case "anthropic":
      return env("ANTHROPIC_API_KEY") || env("ANTHROPIC_AUTH_TOKEN");
    case "openai":
      return env("OPENAI_API_KEY");
    case "openrouter":
      return env("OPENROUTER_API_KEY");
    case "openai-compatible":
      return env("AGENT_API_KEY") || env("OPENAI_API_KEY") || "not-needed";
    default:
      return "";
  }
}

function baseUrlFor(id: ProviderId): string {
  const explicit =
    env("AGENT_BASE_URL") ||
    (id === "anthropic" ? env("ANTHROPIC_BASE_URL") : "") ||
    (id === "openai" ? env("OPENAI_BASE_URL") : "") ||
    (id === "openrouter" ? env("OPENROUTER_BASE_URL") : "");
  const raw = explicit || DEFAULT_BASE_URLS[id as Exclude<ProviderId, "mock">];
  return raw.replace(/\/+$/, "");
}

export interface ResolveOptions {
  /** From `--provider`; also accepts a bare base URL for any OpenAI-compatible server. */
  provider?: string;
  /** From `--model`. */
  model?: string;
  /** Force the offline scripted provider. */
  mock?: boolean;
}

/**
 * Decide the provider profile. Precedence, highest first:
 *   1. explicit --provider / AGENT_PROVIDER
 *   2. the shape of --model / AGENT_MODEL
 *   3. whichever API key is present in the environment
 *   4. mock (no key anywhere → offline scripted demo)
 */
export function resolveProvider(opts: ResolveOptions = {}): ProviderProfile {
  const wantedModel = opts.model || env("AGENT_MODEL") || env("ANTHROPIC_MODEL");
  const wantedProvider = (opts.provider || env("AGENT_PROVIDER")).toLowerCase();

  let id: ProviderId | undefined;
  let baseUrlOverride: string | undefined;

  if (opts.mock || wantedProvider === "mock") {
    id = "mock";
  } else if (wantedProvider.startsWith("http://") || wantedProvider.startsWith("https://")) {
    // `--provider http://localhost:1234/v1` — any OpenAI-compatible server.
    id = "openai-compatible";
    baseUrlOverride = wantedProvider.replace(/\/+$/, "");
  } else if (wantedProvider) {
    const known: ProviderId[] = ["anthropic", "openai", "openrouter", "openai-compatible"];
    const match = known.find((k) => k === wantedProvider);
    if (!match) {
      throw new Error(
        `Unknown provider "${wantedProvider}". Use one of: ${known.join(", ")}, mock — or a base URL.`,
      );
    }
    id = match;
  } else {
    id = providerForModel(wantedModel);
  }

  if (!id) {
    if (keyFor("anthropic")) id = "anthropic";
    else if (keyFor("openai")) id = "openai";
    else if (keyFor("openrouter")) id = "openrouter";
    else if (env("AGENT_BASE_URL")) id = "openai-compatible";
    else id = "mock";
  }

  if (id === "mock") {
    return {
      id: "mock",
      baseUrl: "",
      apiKey: "",
      model: wantedModel || "mock-model",
      contextWindow: Number(env("AGENT_CONTEXT_WINDOW")) || 32_000,
      usesMaxCompletionTokens: false,
    };
  }

  const model = wantedModel || DEFAULT_MODELS[id];
  const catalog = ANTHROPIC_MODELS[model];
  const contextWindow =
    Number(env("AGENT_CONTEXT_WINDOW")) || catalog?.contextWindow || FALLBACK_CONTEXT_WINDOW;

  return {
    id,
    baseUrl: baseUrlOverride ?? baseUrlFor(id),
    apiKey: keyFor(id),
    model,
    contextWindow,
    usesMaxCompletionTokens: needsMaxCompletionTokens(id, model),
    price: catalog?.price,
  };
}

/** Which env var the user needs to set for this provider, for error messages. */
export function keyVarFor(id: ProviderId): string {
  switch (id) {
    case "anthropic":
      return "ANTHROPIC_API_KEY";
    case "openai":
      return "OPENAI_API_KEY";
    case "openrouter":
      return "OPENROUTER_API_KEY";
    default:
      return "AGENT_API_KEY";
  }
}

// ── everything else that is configurable ─────────────────────────────────────

export interface AgentSettings {
  maxTokens: number;
  /** Hard stop on model calls in a single turn, so a loop can't spin forever. */
  maxTurns: number;
  /** Compact when the estimate crosses this fraction of the window (goose: 0.8). */
  compactionRatio: number;
  /** Trailing user messages preserved verbatim by compaction (codex: ~20k). */
  compactionRecentBudget: number;
  /** Tool results larger than this are spilled to disk (claude-code Tool.ts:466). */
  maxToolResultChars: number;
  /** Max concurrent read-only tools in one batch (claude-code caps at 10). */
  maxToolConcurrency: number;
}

export function loadSettings(): AgentSettings {
  const num = (name: string, fallback: number) => {
    const v = Number(env(name));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  return {
    maxTokens: num("AGENT_MAX_TOKENS", 16_000),
    maxTurns: num("AGENT_MAX_TURNS", 50),
    compactionRatio: Math.min(0.95, num("AGENT_COMPACT_RATIO", 0.8)),
    compactionRecentBudget: num("AGENT_COMPACT_RECENT_TOKENS", 20_000),
    maxToolResultChars: num("AGENT_MAX_TOOL_RESULT_CHARS", 30_000),
    maxToolConcurrency: num("AGENT_MAX_TOOL_CONCURRENCY", 8),
  };
}
