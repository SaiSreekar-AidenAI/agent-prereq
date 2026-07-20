// Example extension. Any .ts file here that exports register(pi) (or a tools[]
// array) adds tools to the agent. This one is loaded automatically at startup;
// it is also the template the agent follows when it writes its OWN extensions.
export function register(pi) {
  pi.addTool({
    name: "word_count",
    description: "Count the words, lines, and characters in a piece of text.",
    input_schema: {
      type: "object",
      properties: { text: { type: "string", description: "Text to measure" } },
      required: ["text"],
    },
    needsApproval: false,
    async run(input) {
      const text = String(input?.text ?? "");
      const words = (text.trim().match(/\S+/g) || []).length;
      const lines = text ? text.split("\n").length : 0;
      return { content: `words=${words} lines=${lines} chars=${text.length}` };
    },
  });
}
