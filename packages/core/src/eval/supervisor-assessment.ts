function extractJsonCandidates(text: string): string[] {
  const candidates: string[] = [];

  // 1. fenced code blocks
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (const m of text.matchAll(fenceRe)) {
    candidates.push(m[1].trim());
  }

  // 2. balanced braces
  const stack: number[] = [];
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") {
      if (stack.length === 0) start = i;
      stack.push(i);
    } else if (text[i] === "}") {
      stack.pop();
      if (stack.length === 0 && start >= 0) {
        candidates.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return candidates;
}

export function extractAssessment(
  supervisorOutput: string,
): Record<string, number> | null {
  const candidates = extractJsonCandidates(supervisorOutput);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (!parsed || typeof parsed !== "object" || !("dimensions" in parsed)) {
        continue;
      }

      const dims = (parsed as { dimensions?: Record<string, unknown> }).dimensions;
      if (!dims || typeof dims !== "object" || Array.isArray(dims)) {
        continue;
      }

      const result: Record<string, number> = {};
      for (const [key, value] of Object.entries(dims)) {
        if (typeof value === "number" && !Number.isNaN(value)) {
          result[key] = value > 1 ? Math.max(0, Math.min(1, value / 100)) : Math.max(0, Math.min(1, value));
        }
      }

      if (Object.keys(result).length > 0) {
        return result;
      }
    } catch {
      // ignore invalid JSON candidate
    }
  }

  return null;
}
