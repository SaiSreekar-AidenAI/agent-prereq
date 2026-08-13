// ui.ts — terminal output.
//
// Deliberately thin. Ch. 17 is explicit that the entire TUI is the first thing
// to omit: the loop should emit events and something else should render them.
// So this file is a handful of write() calls, and everything it prints comes
// from the event stream the loop already produces.

const useColor = process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb";

const code = (n: string) => (s: string) => (useColor ? `\u001b[${n}m${s}\u001b[0m` : s);

export const dim = code("2");
export const bold = code("1");
export const red = code("31");
export const green = code("32");
export const yellow = code("33");
export const blue = code("34");
export const magenta = code("35");
export const cyan = code("36");

export function write(s: string): void {
  process.stdout.write(s);
}

export function line(s = ""): void {
  process.stdout.write(s + "\n");
}

export function info(s: string): void {
  line(dim(s));
}

export function warn(s: string): void {
  line(yellow(s));
}

export function error(s: string): void {
  line(red(s));
}

export function heading(s: string): void {
  line(bold(s));
}

/** `⏵ bash  npm test` — one line announcing a tool call. */
export function toolCall(name: string, subject: string): void {
  const shown = subject.replace(/\s+/g, " ").trim();
  line(`${cyan("⏵")} ${bold(name)} ${dim(truncate(shown, 140))}`);
}

/**
 * Indented, truncated tool output, labelled with the tool it came from — without
 * the label a parallel batch of reads produces interleaved output you cannot
 * attribute.
 */
export function toolResult(name: string, content: string, isError: boolean, maxLines = 12): void {
  const lines = content.split("\n");
  const shown = lines.slice(0, maxLines);
  const paint = isError ? red : dim;
  const label = (isError ? red : dim)(`  ${name} ${isError ? "✗" : "→"} `);
  shown.forEach((l, i) => line(i === 0 ? label + paint(truncate(l, 200)) : "    " + paint(truncate(l, 200))));
  if (lines.length > maxLines) line("    " + dim(`… ${lines.length - maxLines} more line(s)`));
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function bar(fraction: number, width = 20): string {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
  return "[" + "█".repeat(filled) + "·".repeat(width - filled) + "]";
}
