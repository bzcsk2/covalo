/**
 * WebFetch tool — fetches URL content with HTML→Markdown/Text conversion.
 *
 * Adapted from opencode's webfetch tool:
 * - Uses TurndownService for proper HTML→Markdown conversion
 * - Uses htmlparser2 for clean HTML→text extraction
 * - Retains deepicode's SSRF protection and approval model
 */
import type { AgentTool } from "@deepicode/core"
import { safeStringify } from "./safe-stringify.js"
import { isIP } from "node:net"
import { promises as dns } from "node:dns"
import { Parser } from "htmlparser2"
import TurndownService from "turndown"

const FETCH_TIMEOUT = 30_000
const MAX_CONTENT_LENGTH = 10 * 1024 * 1024
const MAX_OUTPUT_LENGTH = 100_000

const BLOCKED_NETS = [
  "0.", "10.", "100.", "127.", "169.254.",
  "172.16.", "172.17.", "172.18.", "172.19.", "172.20.",
  "172.21.", "172.22.", "172.23.", "172.24.", "172.25.",
  "172.26.", "172.27.", "172.28.", "172.29.", "172.30.", "172.31.",
  "192.0.0.", "192.0.2.", "192.168.",
  "198.18.", "198.19.", "198.51.100.", "203.0.113.",
  "224.", "240.",
  "fc", "fd", "fe80", "::1", "::",
]

export function hasPrivateIP(host: string): boolean {
  if (isIP(host)) return BLOCKED_NETS.some(p => host.startsWith(p))
  return false
}

export async function isPrivateHostname(host: string): Promise<boolean> {
  try {
    const addrs = await dns.resolve(host)
    return addrs.some(a => BLOCKED_NETS.some(p => a.startsWith(p)))
  } catch {
    return true // can't resolve = unsafe
  }
}

type FetchFormat = "text" | "markdown" | "html"

export function createWebFetchTool(): AgentTool {
  return {
    name: "WebFetch",
    description: "Fetches content from a URL and returns it as markdown, text, or raw HTML. Supports HTML, text, and common web content types. HTTP URLs are automatically upgraded to HTTPS.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to fetch content from." },
        format: {
          type: "string",
          enum: ["markdown", "text", "html"],
          description: "Output format. 'markdown' converts HTML to Markdown (default), 'text' extracts plain text, 'html' returns raw HTML.",
        },
        max_length: { type: "number", description: "Maximum characters to return (default 100000)." },
      },
      required: ["url"],
    },
    concurrency: "shared",
    approval: "read",
    async execute(args, ctx) {
      if (typeof args.url !== "string" || !args.url) {
        return { content: safeStringify({ error: "url is required" }), isError: true }
      }

      const format: FetchFormat =
        args.format === "markdown" || args.format === "text" || args.format === "html"
          ? args.format
          : "markdown"

      let url = args.url
      try {
        const parsed = new URL(url)
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          return { content: safeStringify({ error: `Unsupported protocol: ${parsed.protocol}` }), isError: true }
        }
        if (parsed.protocol === "http:") {
          parsed.protocol = "https:"
          url = parsed.toString()
        }
        if (parsed.username || parsed.password) {
          return { content: safeStringify({ error: "URL with credentials is not allowed" }), isError: true }
        }
        if (hasPrivateIP(parsed.hostname)) {
          return { content: safeStringify({ error: `Access to internal network is not allowed: ${parsed.hostname}` }), isError: true }
        }
        if (!isIP(parsed.hostname) && await isPrivateHostname(parsed.hostname)) {
          return { content: safeStringify({ error: `Hostname resolves to internal network: ${parsed.hostname}` }), isError: true }
        }
      } catch {
        return { content: safeStringify({ error: `Invalid URL: ${url}` }), isError: true }
      }

      const maxLen = typeof args.max_length === "number" ? Math.min(args.max_length, MAX_OUTPUT_LENGTH) : MAX_OUTPUT_LENGTH

      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT)
        const { signal, cleanup } = ctx.signal ? anySignal(ctx.signal, controller.signal) : { signal: controller.signal, cleanup: () => {} }

        const t0 = Date.now()
        let resp: Response
        try {
          resp = await fetch(url, {
            signal,
            redirect: "follow",
            headers: {
              "User-Agent": "Mozilla/5.0 (compatible; Deepicode/1.0; +https://deepicode.dev)",
              Accept: acceptHeader(format),
            },
          })
        } finally {
          clearTimeout(timer)
          cleanup()
        }

        // SSRF: validate final URL after any redirects
        const finalUrl = resp.redirected ? new URL(resp.url) : new URL(url)
        if (hasPrivateIP(finalUrl.hostname) ||
            (!isIP(finalUrl.hostname) && await isPrivateHostname(finalUrl.hostname))) {
          return { content: safeStringify({ error: `URL resolves to internal network: ${finalUrl.hostname}` }), isError: true }
        }

        if (!resp.ok) {
          return {
            content: safeStringify({ error: `HTTP ${resp.status}: ${resp.statusText}`, code: resp.status, url }),
            isError: true,
          }
        }

        const contentType = resp.headers.get("content-type") ?? ""
        const isHtml = contentType.includes("text/html")

        const buf = await resp.arrayBuffer()
        const bytes = buf.byteLength
        if (bytes > MAX_CONTENT_LENGTH) {
          return { content: safeStringify({ error: `Content too large: ${bytes} bytes exceeds limit of ${MAX_CONTENT_LENGTH}` }), isError: true }
        }

        let text = new TextDecoder().decode(buf)
        let result: string

        if (isHtml) {
          if (format === "markdown") {
            result = convertHTMLToMarkdown(text)
          } else if (format === "text") {
            result = extractTextFromHTML(text)
          } else {
            result = text // raw HTML
          }
        } else {
          // Non-HTML content: return as-is regardless of format
          result = text
        }

        if (result.length > maxLen) {
          result = result.slice(0, maxLen) + `\n... [truncated: ${result.length - maxLen} more chars]`
        }

        const elapsed = Date.now() - t0
        return {
          content: safeStringify({
            content: result,
            format,
            bytes,
            code: resp.status,
            durationMs: elapsed,
            url,
          }),
          isError: false,
        }
      } catch (e) {
        if (e instanceof Error && e.name === "AbortError") {
          return { content: safeStringify({ error: "Request timed out or was aborted" }), isError: true }
        }
        return { content: safeStringify({ error: `Fetch error: ${e instanceof Error ? e.message : String(e)}` }), isError: true }
      }
    },
  }
}

function acceptHeader(format: FetchFormat): string {
  switch (format) {
    case "markdown":
      return "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1"
    case "text":
      return "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1"
    case "html":
      return "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, */*;q=0.1"
  }
}

function anySignal(...signals: AbortSignal[]): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController()
  const handlers: Array<() => void> = []
  for (const s of signals) {
    if (s.aborted) { controller.abort(s.reason); return { signal: controller.signal, cleanup: () => {} } }
    const handler = () => controller.abort(s.reason)
    s.addEventListener("abort", handler, { once: true })
    handlers.push(() => s.removeEventListener("abort", handler))
  }
  return { signal: controller.signal, cleanup: () => handlers.forEach(h => h()) }
}

/**
 * Convert HTML to Markdown using TurndownService.
 * Adapted from opencode's convertHTMLToMarkdown().
 */
function convertHTMLToMarkdown(html: string): string {
  const turndown = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  })
  turndown.remove(["script", "style", "meta", "link", "noscript", "iframe", "object", "embed"])
  return turndown.turndown(html)
}

/**
 * Extract plain text from HTML using htmlparser2.
 * Skips script, style, noscript, iframe, object, embed content.
 * Adapted from opencode's extractTextFromHTML().
 */
function extractTextFromHTML(html: string): string {
  let text = ""
  let skipDepth = 0
  const parser = new Parser({
    onopentag(name) {
      if (skipDepth > 0 || ["script", "style", "noscript", "iframe", "object", "embed"].includes(name)) {
        skipDepth++
      }
    },
    ontext(input) {
      if (skipDepth === 0) text += input
    },
    onclosetag() {
      if (skipDepth > 0) skipDepth--
    },
  })
  parser.write(html)
  parser.end()
  return text.trim()
}
