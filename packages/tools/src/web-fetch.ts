import type { AgentTool } from "../../core/src/interface.js"
import { safeStringify } from "./safe-stringify.js"
import { isIP } from "node:net"
import { promises as dns } from "node:dns"

const FETCH_TIMEOUT = 30_000
const MAX_CONTENT_LENGTH = 10 * 1024 * 1024
const MAX_OUTPUT_LENGTH = 100_000

const BLOCKED_NETS = ["0.", "10.", "100.", "127.", "169.254.", "172.16.", "172.17.", "172.18.", "172.19.", "172.20.", "172.21.", "172.22.", "172.23.", "172.24.", "172.25.", "172.26.", "172.27.", "172.28.", "172.29.", "172.30.", "172.31.", "192.0.0.", "192.0.2.", "192.168.", "198.18.", "198.19.", "198.51.100.", "203.0.113.", "224.", "240.", "fc", "fd", "fe80", "::1", "::"]

function hasPrivateIP(host: string): boolean {
  if (isIP(host)) return BLOCKED_NETS.some(p => host.startsWith(p))
  return false
}

async function isPrivateHostname(host: string): Promise<boolean> {
  try {
    const addrs = await dns.resolve(host)
    return addrs.some(a => BLOCKED_NETS.some(p => a.startsWith(p)))
  } catch {
    return true // can't resolve = unsafe
  }
}

export function createWebFetchTool(): AgentTool {
  return {
    name: "WebFetch",
    description: "Fetches content from a URL and returns it as text/markdown. Supports HTML and text content types. HTTP URLs are automatically upgraded to HTTPS.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to fetch content from." },
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

      let url = args.url
      try {
        const parsed = new URL(url)
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
        const signal = ctx.signal ? anySignal(ctx.signal, controller.signal) : controller.signal

        const t0 = Date.now()
        const resp = await fetch(url, { signal, redirect: "manual" })
        clearTimeout(timer)

        if (!resp.ok) {
          return {
            content: safeStringify({ error: `HTTP ${resp.status}: ${resp.statusText}`, code: resp.status, url }),
            isError: true,
          }
        }

        const contentType = resp.headers.get("content-type") ?? ""
        const isHtml = contentType.includes("text/html") || contentType.includes("text/markdown")

        const buf = await resp.arrayBuffer()
        const bytes = buf.byteLength
        if (bytes > MAX_CONTENT_LENGTH) {
          return { content: safeStringify({ error: `Content too large: ${bytes} bytes exceeds limit of ${MAX_CONTENT_LENGTH}` }), isError: true }
        }

        let text = new TextDecoder().decode(buf)
        let result: string

        if (isHtml) {
          result = htmlToText(text)
        } else {
          result = text
        }

        if (result.length > maxLen) {
          result = result.slice(0, maxLen) + `\n... [truncated: ${result.length - maxLen} more chars]`
        }

        const elapsed = Date.now() - t0
        return {
          content: safeStringify({
            content: result,
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

function anySignal(...signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController()
  for (const s of signals) {
    if (s.aborted) { controller.abort(s.reason); return controller.signal }
    s.addEventListener("abort", () => controller.abort(s.reason), { once: true })
  }
  return controller.signal
}

function htmlToText(html: string): string {
  let text = html
  text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
  text = text.replace(/<br\s*\/?>/gi, "\n")
  text = text.replace(/<\/p>/gi, "\n\n")
  text = text.replace(/<\/div>/gi, "\n")
  text = text.replace(/<\/h[1-6]>/gi, "\n")
  text = text.replace(/<\/li>/gi, "\n")
  text = text.replace(/<[^>]+>/g, "")
  text = text.replace(/&amp;/g, "&")
  text = text.replace(/&lt;/g, "<")
  text = text.replace(/&gt;/g, ">")
  text = text.replace(/&quot;/g, '"')
  text = text.replace(/&#39;/g, "'")
  text = text.replace(/&nbsp;/g, " ")
  text = text.replace(/\n{3,}/g, "\n\n")
  text = text.trim()
  return text
}
