// fake-provider.ts — a local server that speaks BOTH wire formats.
//
// This is what makes the end-to-end tests real rather than mocked: the agent
// runs unmodified, opens an actual HTTP connection, and parses actual
// server-sent events. Only the far end is scripted.
//
//   POST /v1/messages          Anthropic Messages, SSE
//   POST /v1/chat/completions  OpenAI Chat Completions, SSE
//   POST /__script             load the next scripted turns  {turns:[…]}
//   GET  /__requests           every request body the server received
//   POST /__reset              clear the script and the recording
//
// Tool-call arguments are deliberately split across several SSE deltas so the
// accumulate-then-parse-once rule (Ch. 4) is actually exercised, not assumed.

import { createServer } from "node:http";
import type { Server } from "node:http";

export interface ScriptedToolCall {
  name: string;
  input: unknown;
  id?: string;
}

export interface ScriptedTurn {
  text?: string;
  thinking?: string;
  tools?: ScriptedToolCall[];
  /** Respond with this HTTP status and body instead of a stream. */
  error?: { status: number; body: string };
  /** Usage numbers reported for this turn. */
  usage?: { input: number; output: number };
}

export interface FakeProvider {
  port: number;
  url: string;
  script(turns: ScriptedTurn[]): void;
  requests(): any[];
  reset(): void;
  close(): Promise<void>;
}

function sse(res: any, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** Split a string into n roughly-equal pieces, to force real accumulation. */
function chop(s: string, n: number): string[] {
  if (s.length <= n) return s.split("");
  const size = Math.ceil(s.length / n);
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

function writeAnthropic(res: any, turn: ScriptedTurn): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const usage = turn.usage ?? { input: 1200, output: 80 };
  sse(res, "message_start", {
    type: "message_start",
    message: {
      id: "msg_fake",
      type: "message",
      role: "assistant",
      model: "fake",
      content: [],
      usage: { input_tokens: usage.input, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  });

  let index = 0;
  if (turn.thinking) {
    sse(res, "content_block_start", { type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } });
    for (const c of chop(turn.thinking, 3)) {
      sse(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: c } });
    }
    sse(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "signature_delta", signature: "sig_fake" } });
    sse(res, "content_block_stop", { type: "content_block_stop", index });
    index++;
  }
  if (turn.text) {
    sse(res, "content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
    for (const c of chop(turn.text, 5)) {
      sse(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: c } });
    }
    sse(res, "content_block_stop", { type: "content_block_stop", index });
    index++;
  }
  for (const [i, call] of (turn.tools ?? []).entries()) {
    sse(res, "content_block_start", {
      type: "content_block_start",
      index,
      content_block: { type: "tool_use", id: call.id ?? `toolu_${i}`, name: call.name, input: "" },
    });
    for (const c of chop(JSON.stringify(call.input ?? {}), 4)) {
      sse(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: c } });
    }
    sse(res, "content_block_stop", { type: "content_block_stop", index });
    index++;
  }

  sse(res, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: turn.tools?.length ? "tool_use" : "end_turn" },
    usage: { input_tokens: usage.input, output_tokens: usage.output },
  });
  sse(res, "message_stop", { type: "message_stop" });
  res.end();
}

function writeOpenAI(res: any, turn: ScriptedTurn): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const base = { id: "chatcmpl-fake", object: "chat.completion.chunk", model: "fake" };

  if (turn.thinking) {
    for (const c of chop(turn.thinking, 3)) send({ ...base, choices: [{ index: 0, delta: { reasoning: c } }] });
  }
  if (turn.text) {
    for (const c of chop(turn.text, 5)) send({ ...base, choices: [{ index: 0, delta: { content: c } }] });
  }
  for (const [i, call] of (turn.tools ?? []).entries()) {
    send({
      ...base,
      choices: [
        { index: 0, delta: { tool_calls: [{ index: i, id: call.id ?? `call_${i}`, type: "function", function: { name: call.name, arguments: "" } }] } },
      ],
    });
    for (const c of chop(JSON.stringify(call.input ?? {}), 4)) {
      send({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: c } }] } }] });
    }
  }
  send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: turn.tools?.length ? "tool_calls" : "stop" }] });
  const usage = turn.usage ?? { input: 1200, output: 80 };
  send({ ...base, choices: [], usage: { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.input + usage.output } });
  res.write("data: [DONE]\n\n");
  res.end();
}

export async function startFakeProvider(): Promise<FakeProvider> {
  let queue: ScriptedTurn[] = [];
  const received: any[] = [];

  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = req.url ?? "/";
      const parsed = body ? (JSON.parse(body) as any) : {};

      if (url === "/__script") {
        queue = parsed.turns ?? [];
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ok: true, queued: queue.length }));
      }
      if (url === "/__reset") {
        queue = [];
        received.length = 0;
        res.writeHead(200);
        return res.end("{}");
      }
      if (url === "/__requests") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(received));
      }

      received.push({ url, headers: req.headers, body: parsed });
      const turn = queue.shift() ?? { text: "(fake provider ran out of scripted turns)" };
      if (turn.error) {
        res.writeHead(turn.error.status, { "content-type": "application/json" });
        return res.end(turn.error.body);
      }
      if (url.endsWith("/v1/messages")) return writeAnthropic(res, turn);
      return writeOpenAI(res, turn);
    });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port as number;
  const url = `http://127.0.0.1:${port}`;

  return {
    port,
    url,
    script(turns) {
      queue = turns;
    },
    requests() {
      return received;
    },
    reset() {
      queue = [];
      received.length = 0;
    },
    async close() {
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

// Allow running standalone: `node test/fake-provider.ts` prints its URL.
if (import.meta.url === `file://${process.argv[1]}`) {
  const p = await startFakeProvider();
  process.stdout.write(`fake provider listening on ${p.url}\n`);
}
