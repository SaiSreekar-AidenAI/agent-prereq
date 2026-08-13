// Example extension (Ch. 17). Any .ts/.mjs file in this directory that exports
// `register(pi)` — or a `tools` array — adds tools to the agent. This one loads
// at startup and is also the template the agent follows when it writes its own.
//
// A tool declared here goes through exactly the same permission gate as a
// built-in, and `readOnly` defaults to FALSE if you omit it, so a tool that
// forgets to declare itself safe is treated as a writer.

export function register(pi) {
  pi.addTool({
    name: "word_count",
    description: "Count the words, lines, and characters in a piece of text.",
    input_schema: {
      type: "object",
      properties: { text: { type: "string", description: "Text to measure" } },
      required: ["text"],
    },
    readOnly: true,
    async run(input) {
      const text = String(input?.text ?? "");
      const words = (text.trim().match(/\S+/g) || []).length;
      const lines = text ? text.split("\n").length : 0;
      return { content: `words=${words} lines=${lines} chars=${text.length}` };
    },
  });
}
