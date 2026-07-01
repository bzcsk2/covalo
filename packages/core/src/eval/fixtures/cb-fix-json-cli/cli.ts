// A simple CLI tool that parses JSON from stdin and transforms it
// BUG: transformValue returns "[object Object]" for objects instead of proper key-value pairs

export function parseInput(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return undefined;
  }
}

export function transformValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return `"${value}"`;
  if (Array.isArray(value)) {
    return "[" + value.map((v) => transformValue(v)).join(", ") + "]";
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `"${k}": ${transformValue(v)}`)
      .join(", ");
    return `{${entries}}`;
  }
  return String(value);
}

export function processInput(input: string): string {
  const parsed = parseInput(input);
  if (parsed === undefined) {
    return "Error: Invalid JSON";
  }
  return transformValue(parsed);
}

// When run directly from CLI
if (process.argv[1]?.endsWith("cli.ts")) {
  const chunks: Buffer[] = [];
  process.stdin.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  process.stdin.on("end", () => {
    const input = Buffer.concat(chunks).toString().trim();
    console.log(processInput(input));
  });
}
