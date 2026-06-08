/**
 * WebSearch tool — searches the web via MCP-based search providers (Exa/Parallel).
 *
 * Adapted from opencode's websearch tool:
 * - Uses Exa or Parallel MCP services instead of Google HTML scraping
 * - Supports live crawling, search type tuning, and result count control
 * - Environment variables: EXA_API_KEY, PARALLEL_API_KEY
 * - Provider selection: OPENCODE_WEBSEARCH_PROVIDER (exa|parallel)
 */
import type { AgentTool } from "@deepicode/core"
import { safeStringify } from "./safe-stringify.js"

const SEARCH_TIMEOUT = 25_000
const MAX_RESPONSE_BYTES = 256 * 1024

// MCP endpoint URLs
const EXA_MCP_URL = "https://mcp.exa.ai/mcp"
const PARALLEL_MCP_URL = "https://search.parallel.ai/mcp"

type SearchProvider = "exa" | "parallel"
type SearchType = "auto" | "fast" | "deep"
type LiveCrawlMode = "fallback" | "preferred"

export function createWebSearchTool(): AgentTool {
  return {
    name: "WebSearch",
    description: `Search the web using a search provider. Returns real-time information with source URLs and summaries. Use this when you need up-to-date information about current events or any topic that may have changed.

Controls live crawling ('fallback' or 'preferred'), search type ('auto', 'fast', or 'deep'), and result count.
Set EXA_API_KEY or PARALLEL_API_KEY environment variable to configure the search provider.`,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query" },
        num_results: { type: "number", description: "Number of results to return (default 8, max 20)" },
        livecrawl: {
          type: "string",
          enum: ["fallback", "preferred"],
          description: "Live crawl mode - 'fallback': use cache if available, 'preferred': always fetch fresh (default: 'fallback')",
        },
        type: {
          type: "string",
          enum: ["auto", "fast", "deep"],
          description: "Search type - 'auto': balanced, 'fast': quick results, 'deep': comprehensive (default: 'auto')",
        },
      },
      required: ["query"],
    },
    concurrency: "shared",
    approval: "read",
    async execute(args, ctx) {
      if (typeof args.query !== "string" || !args.query) {
        return { content: safeStringify({ error: "query is required" }), isError: true }
      }

      const numResults = Math.min(
        typeof args.num_results === "number" ? args.num_results : 8,
        20,
      )
      const livecrawl: LiveCrawlMode = args.livecrawl === "preferred" ? "preferred" : "fallback"
      const type: SearchType =
        args.type === "fast" ? "fast" : args.type === "deep" ? "deep" : "auto"

      const provider = selectProvider()

      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT)
        const { signal, cleanup } = ctx.signal
          ? anySignal(ctx.signal, controller.signal)
          : { signal: controller.signal, cleanup: () => {} }

        const t0 = Date.now()
        let resultText: string | undefined

        try {
          if (provider === "exa") {
            resultText = await callExaMCP(args.query, numResults, type, livecrawl, signal)
          } else {
            resultText = await callParallelMCP(args.query, numResults, signal)
          }
        } finally {
          clearTimeout(timer)
          cleanup()
        }

        const elapsed = Date.now() - t0

        if (!resultText) {
          return {
            content: safeStringify({
              results: [],
              count: 0,
              durationMs: elapsed,
              provider,
              note: "No search results found. Please try a different query.",
            }),
            isError: false,
          }
        }

        // Parse the results from the MCP response
        const results = parseMCPSearchResults(resultText)
        const truncated = results.slice(0, numResults)

        return {
          content: safeStringify({
            results: truncated,
            count: truncated.length,
            durationMs: elapsed,
            provider,
          }),
          isError: false,
        }
      } catch (e) {
        if (e instanceof Error && e.name === "AbortError") {
          return { content: safeStringify({ error: "Search timed out" }), isError: true }
        }
        return {
          content: safeStringify({
            error: `Search error: ${e instanceof Error ? e.message : String(e)}`,
          }),
          isError: true,
        }
      }
    },
  }
}

// ─── Provider Selection ───

function selectProvider(): SearchProvider {
  const envProvider = process.env.OPENCODE_WEBSEARCH_PROVIDER
  if (envProvider === "exa" || envProvider === "parallel") return envProvider

  // Prefer Exa if key is set
  if (process.env.EXA_API_KEY) return "exa"
  if (process.env.PARALLEL_API_KEY) return "parallel"

  // Default to Exa (no key needed for basic usage)
  return "exa"
}

// ─── Exa MCP Client ───

async function callExaMCP(
  query: string,
  numResults: number,
  type: SearchType,
  livecrawl: LiveCrawlMode,
  signal: AbortSignal,
): Promise<string | undefined> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "web_search_exa",
      arguments: {
        query,
        type,
        numResults,
        livecrawl,
      },
    },
  })

  const url = process.env.EXA_API_KEY
    ? `${EXA_MCP_URL}?exaApiKey=${encodeURIComponent(process.env.EXA_API_KEY)}`
    : EXA_MCP_URL

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(process.env.EXA_API_KEY
        ? { Authorization: `Bearer ${process.env.EXA_API_KEY}` }
        : {}),
    },
    body,
    signal,
  })

  if (!resp.ok) {
    throw new Error(`Exa search failed: HTTP ${resp.status}`)
  }

  const text = await resp.text()
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    throw new Error("Exa response exceeded size limit")
  }

  return parseMCPResponse(text)
}

// ─── Parallel MCP Client ───

async function callParallelMCP(
  query: string,
  numResults: number,
  signal: AbortSignal,
): Promise<string | undefined> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "web_search",
      arguments: {
        objective: query,
        search_queries: [query],
        session_id: `deepicode-${Date.now()}`,
      },
    },
  })

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "User-Agent": "Deepicode/1.0",
  }

  if (process.env.PARALLEL_API_KEY) {
    headers["Authorization"] = `Bearer ${process.env.PARALLEL_API_KEY}`
  }

  const resp = await fetch(PARALLEL_MCP_URL, {
    method: "POST",
    headers,
    body,
    signal,
  })

  if (!resp.ok) {
    throw new Error(`Parallel search failed: HTTP ${resp.status}`)
  }

  const text = await resp.text()
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    throw new Error("Parallel response exceeded size limit")
  }

  return parseMCPResponse(text)
}

// ─── MCP Response Parser ───

/**
 * Parse an MCP response. Handles both direct JSON and SSE-streamed formats.
 * Adapted from opencode's parseResponse().
 */
function parseMCPResponse(body: string): string | undefined {
  const trimmed = body.trim()

  // Try parsing the entire body as JSON first
  const direct = tryParseMCPPayload(trimmed)
  if (direct) return direct

  // Try SSE format: "data: {...}\n\n"
  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ")) continue
    const payload = line.slice(6).trim()
    if (!payload) continue
    const result = tryParseMCPPayload(payload)
    if (result) return result
  }

  return undefined
}

function tryParseMCPPayload(payload: string): string | undefined {
  try {
    const parsed = JSON.parse(payload)
    const content = parsed?.result?.content
    if (Array.isArray(content)) {
      for (const item of content) {
        if (item.type === "text" && typeof item.text === "string") {
          return item.text
        }
      }
    }
  } catch {
    // Not JSON, skip
  }
  return undefined
}

// ─── Search Results Parser ───

interface SearchResult {
  title: string
  url: string
  snippet: string
}

/**
 * Parse the MCP search provider's text response into structured results.
 * Exa/Parallel return results in a text format with URLs and descriptions.
 */
function parseMCPSearchResults(text: string): SearchResult[] {
  const results: SearchResult[] = []

  // Try to find structured result blocks (Exa/Parallel format)
  // Format: numbered entries with title, URL, and description
  const lines = text.split("\n")
  let current: Partial<SearchResult> = {}

  for (const line of lines) {
    const trimmed = line.trim()

    // Skip empty lines and separators
    if (!trimmed || trimmed === "---" || /^\d+\.\s*$/.test(trimmed)) {
      if (current.title && current.url) {
        results.push({
          title: current.title,
          url: current.url,
          snippet: current.snippet ?? "",
        })
        current = {}
      }
      continue
    }

    // URL line
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
      current.url = trimmed
      continue
    }

    // Numbered title line: "1. Title Here"
    const titleMatch = trimmed.match(/^\d+\.\s+(.+)/)
    if (titleMatch && !current.title) {
      current.title = titleMatch[1]
      continue
    }

    // If we have a title but no content yet, this might be the first snippet line
    if (current.title && !current.snippet) {
      current.snippet = trimmed
      continue
    }

    // Append to snippet
    if (current.title && current.snippet) {
      current.snippet += " " + trimmed
    }
  }

  // Don't forget the last entry
  if (current.title && current.url) {
    results.push({
      title: current.title,
      url: current.url,
      snippet: current.snippet ?? "",
    })
  }

  // If structured parsing produced no results, try URL-extraction approach
  if (results.length === 0) {
    return extractResultsFallback(text)
  }

  return results
}

/**
 * Fallback parser: extract URLs and their surrounding context from free-form text.
 */
function extractResultsFallback(text: string): SearchResult[] {
  const results: SearchResult[] = []
  const urlRegex = /(https?:\/\/[^\s]+)/g

  // Split text into sections by double newlines
  const sections = text.split(/\n\s*\n/)

  for (const section of sections) {
    const urls = [...section.matchAll(urlRegex)]
    if (urls.length === 0) continue

    for (const match of urls) {
      const url = match[0].replace(/[.,;:!?)]$/, "")
      // Extract title: text before the URL
      const beforeUrl = section.slice(0, match.index!).trim()
      const title = beforeUrl
        .replace(/^[\d\s.]+/, "")
        .replace(/:$/, "")
        .trim()
      // Extract snippet: text after the URL
      const afterUrl = section.slice(match.index! + match[0].length).trim()

      results.push({
        title: title || url,
        url,
        snippet: afterUrl.replace(/^[:\s-]*/, "").trim(),
      })
    }
  }

  return results
}

// ─── Utilities ───

function anySignal(...signals: AbortSignal[]): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController()
  const handlers: Array<() => void> = []
  for (const s of signals) {
    if (s.aborted) {
      controller.abort(s.reason)
      return { signal: controller.signal, cleanup: () => {} }
    }
    const handler = () => controller.abort(s.reason)
    s.addEventListener("abort", handler, { once: true })
    handlers.push(() => s.removeEventListener("abort", handler))
  }
  return {
    signal: controller.signal,
    cleanup: () => handlers.forEach((h) => h()),
  }
}
