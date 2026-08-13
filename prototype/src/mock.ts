// mock.ts — the offline provider.
//
// Not a toy for its own sake: it is the injectable seam Ch. 4 asks for
// ("make the provider an injectable seam so the loop is testable without the
// network"). It emits the same StreamEvent union as the real clients, so the
// loop, the gate, the tool runner, compaction, and the session store are all
// exercised for real with no API key. `test/fake-provider.ts` goes one step
// further and exercises the HTTP + SSE layer too.

import type { Message, Provider, ProviderRequest, StreamEvent, ToolUseBlock } from "./types.ts";
import { fileURLToPath } from "node:url";

const SHOUT_EXTENSION = `// Written by the agent itself, then hot-loaded with reload_extensions.
export function register(pi) {
  pi.addTool({
    name: "shout",
    description: "Return the given text in UPPERCASE.",
    input_schema: {
      type: "object",
      properties: { text: { type: "string", description: "Text to shout" } },
      required: ["text"],
    },
    readOnly: true,
    async run(input) {
      return { content: String(input?.text ?? "").toUpperCase() };
    },
  });
}
`;

function countToolResultTurns(messages: Message[]): number {
  return messages.filter((m) => m.content.some((b) => b.type === "tool_result")).length;
}

function firstUserText(messages: Message[]): string {
  for (const m of messages) {
    if (m.role !== "user" || m.meta) continue;
    const t = m.content.find((b) => b.type === "text");
    if (t) return t.text;
  }
  return "";
}

function lastUserText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    const t = m.content.find((b) => b.type === "text");
    if (t) return t.text;
  }
  return "";
}

export function createMockProvider(model = "mock-model", contextWindow = 32_000): Provider {
  const extDir = new URL("../extensions/", import.meta.url);
  const shoutPath = fileURLToPath(new URL("shout.ts", extDir));

  return {
    id: "mock",
    label: `mock/${model}`,
    model,
    contextWindow,
    async *stream(req: ProviderRequest): AsyncGenerator<StreamEvent> {
      const step = countToolResultTurns(req.messages);
      const task = firstUserText(req.messages);
      const latest = lastUserText(req.messages);

      // The compaction pass calls the provider with no tools and the summary
      // instruction as the last message. Answer in the expected shape.
      if (req.tools.length === 0 && latest.includes("<summary>")) {
        yield* emitText(
          "<summary>\n1. Intent — the user was exercising the offline mock provider.\n" +
            "2. Files — none changed.\n3. Decisions — none.\n4. Errors — none.\n" +
            "5. Verification — none.\n6. User messages — " + JSON.stringify(task.slice(0, 120)) + "\n" +
            "7. Current state — mock session, nothing pending.\n8. Next step — none.\n</summary>",
        );
        yield { type: "usage", usage: { input: 200, output: 90, cacheRead: 0, cacheWrite: 0 } };
        yield { type: "finish", stopReason: "end_turn" };
        return;
      }

      const selfBuild = /extension|self.?build|shout|write .*tool|build .*tool/i.test(task);
      const has = (name: string) => req.tools.some((t) => t.name === name);

      const emit = async function* (text: string, call?: ToolUseBlock): AsyncGenerator<StreamEvent> {
        yield* emitText(text);
        if (call) yield { type: "block-end", block: call };
        yield { type: "usage", usage: { input: 500 + step * 200, output: 60, cacheRead: 0, cacheWrite: 0 } };
        yield { type: "finish", stopReason: call ? "tool_use" : "end_turn" };
      };

      if (selfBuild && has("write") && has("reload_extensions")) {
        if (step === 0) {
          yield* emit("[mock] Writing a `shout` tool, then hot-loading it.", {
            type: "tool_use",
            id: "mock_1",
            name: "write",
            input: { path: shoutPath, content: SHOUT_EXTENSION },
          });
          return;
        }
        if (step === 1) {
          yield* emit("[mock] Loading the tool I just wrote.", {
            type: "tool_use",
            id: "mock_2",
            name: "reload_extensions",
            input: {},
          });
          return;
        }
        if (step === 2) {
          yield* emit("[mock] Calling my new tool.", {
            type: "tool_use",
            id: "mock_3",
            name: "shout",
            input: { text: "hello from a tool I just wrote" },
          });
          return;
        }
        yield* emit("[mock] Self-extension demo complete: wrote extensions/shout.ts, hot-loaded it, and used it.");
        return;
      }

      if (step === 0 && has("ls")) {
        yield* emit("[mock] Demonstrating the loop — listing the working directory.", {
          type: "tool_use",
          id: "mock_ls",
          name: "ls",
          input: { path: "." },
        });
        return;
      }
      yield* emit(
        "[mock] Saw the tool result and stopped, because the assistant emitted no tool_use block — " +
          "that is the exit test. Set ANTHROPIC_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY for a real model.",
      );
    },
  };
}

/** Emit text as several deltas so streaming rendering is exercised. */
async function* emitText(text: string): AsyncGenerator<StreamEvent> {
  const chunks = text.match(/[\s\S]{1,24}/g) ?? [];
  for (const c of chunks) yield { type: "text-delta", text: c };
  yield { type: "block-end", block: { type: "text", text } };
}
