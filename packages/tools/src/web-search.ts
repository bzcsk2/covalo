import type { AgentTool } from "../../core/src/interface.js"
import { safeStringify } from "./safe-stringify.js"

const SEARCH_TIMEOUT = 15_000

export function createWebSearchTool(): AgentTool {
  return {
    name: "WebSearch",
    description: "Search the web using Google search. Returns real-time information with source URLs. Use this when you need up-to-date information about current events or any topic that may have changed.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query" },
        num_results: { type: "number", description: "Number of results to return (default 5, max 10)" },
      },
      required: ["query"],
    },
    concurrency: "shared",
    approval: "read",
    async execute(args, ctx) {
      if (typeof args.query !== "string" || !args.query) {
        return { content: safeStringify({ error: "query is required" }), isError: true }
      }
      const numResults = Math.min(typeof args.num_results === "number" ? args.num_results : 5, 10)

      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT)
        const signal = ctx.signal ? anySignal(ctx.signal, controller.signal) : controller.signal
        const t0 = Date.now()

        const params = new URLSearchParams({ q: args.query, num: String(numResults) })
        const resp = await fetch(`https://www.google.com/search?${params}`, {
          signal,
          headers: { "User-Agent": "Mozilla/5.0 (compatible; Deepicode/1.0)" },
        })
        clearTimeout(timer)

        if (!resp.ok) {
          return { content: safeStringify({ error: `Search failed: HTTP ${resp.status}` }), isError: true }
        }

        const html = await resp.text()
        const results = parseGoogleResults(html).slice(0, numResults)
        const elapsed = Date.now() - t0

        return {
          content: safeStringify({ results, count: results.length, durationMs: elapsed }),
          isError: false,
        }
      } catch (e) {
        if (e instanceof Error && e.name === "AbortError") {
          return { content: safeStringify({ error: "Search timed out" }), isError: true }
        }
        return { content: safeStringify({ error: `Search error: ${e instanceof Error ? e.message : String(e)}` }), isError: true }
      }
    },
  }
}

function anySignal(...signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController()
  for (const s of signals) {
    if (s.aborted) { controller.abort(s.reason); return controller.signal }
    s.addEventListener("abort", () => controller.abort(s.reason), { once: true })
  }
  return controller.signal
}

function parseGoogleResults(html: string): Array<{ title: string; url: string; snippet: string }> {
  const results: Array<{ title: string; url: string; snippet: string }> = []
  const anchorRe = /<a[^>]*href="\/url\?q=([^"&]+)[^"]*"[^>]*>(.*?)<\/a>/gi
  let m: RegExpExecArray | null
  while ((m = anchorRe.exec(html)) !== null) {
    const url = decodeURIComponent(m[1])
    const title = m[2].replace(/<[^>]+>/g, "").trim()
    if (!title || url.startsWith("http")) continue
    results.push({ title, url, snippet: "" })
  }

  const snippetRe = /<span[^>]*class="[^"]*?(?:aCOpRe|st|VwiC3b)[^"]*"[^>]*>(.*?)<\/span>/gi
  let si = 0
  while ((m = snippetRe.exec(html)) !== null && si < results.length) {
    results[si].snippet = m[1].replace(/<[^>]+>/g, "").trim()
    si++
  }

  return results
}
