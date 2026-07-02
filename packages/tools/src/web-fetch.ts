/**
 * WebFetch tool — fetches URL content with HTML→Markdown/Text conversion.
 *
 * Adapted from opencode's webfetch tool:
 * - Uses TurndownService for proper HTML→Markdown conversion
 * - Uses htmlparser2 for clean HTML→text extraction
 * - Retains covalo's SSRF protection and approval model
 *
 * SSRF protection:
 * - Proper CIDR-based IP matching (not string prefixes)
 * - IPv4-mapped IPv6 detection
 * - DNS resolution with all-address check
 * - Redirect following with per-hop re-validation
 */
import type { AgentTool } from "@covalo/core"
import { safeStringify } from "./safe-stringify.js"
import { isIP } from "node:net"
import { promises as dns } from "node:dns"
import { Parser } from "htmlparser2"
import TurndownService from "turndown"

const FETCH_TIMEOUT = 30_000
const MAX_CONTENT_LENGTH = 10 * 1024 * 1024
const MAX_OUTPUT_LENGTH = 100_000
const MAX_REDIRECTS = 5

// ---------- CIDR-based IP blocking ----------

/** Parse a CIDR string like "10.0.0.0/8" or "fc00::/7" into { network, bits, mask } */
function parseCIDR(cidr: string): { network: bigint; bits: number; mask: bigint; family: 4 | 6 } | null {
  const [addr, bitsStr] = cidr.split("/")
  const bits = parseInt(bitsStr, 10)
  if (!addr || isNaN(bits)) return null

  if (isIP(addr) === 4) {
    const network = ipv4ToUint32(addr)
    const mask = bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(32 - bits)
    return { network: network & mask, bits, mask, family: 4 }
  }

  if (isIP(addr) === 6) {
    const bytes = ipv6ToBytes(addr)
    const network = bytesToBigInt(bytes)
    const mask = bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(128 - bits)
    return { network: network & mask, bits, mask, family: 6 }
  }

  return null
}

function ipv4ToUint32(ip: string): bigint {
  const parts = ip.split(".").map(Number)
  return BigInt(((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0)
}

function ipv6ToBytes(ip: string): number[] {
  // Handle IPv4-mapped IPv6 (::ffff:127.0.0.1)
  const v4MappedMatch = ip.match(/^::ffff:(\d+)\.(\d+)\.(\d+)\.(\d+)$/i)
  if (v4MappedMatch) {
    const bytes: number[] = []
    for (let i = 0; i < 10; i++) bytes.push(0)
    bytes.push(0xff, 0xff)
    bytes.push(parseInt(v4MappedMatch[1]!), parseInt(v4MappedMatch[2]!))
    bytes.push(parseInt(v4MappedMatch[3]!), parseInt(v4MappedMatch[4]!))
    return bytes
  }

  // Strip IPv4 tail if present (e.g., ::1.2.3.4)
  let ipv6Part = ip
  const v4TailMatch = ip.match(/^([0-9a-f:.]+):(\d+\.\d+\.\d+\.\d+)$/i)
  if (v4TailMatch) {
    ipv6Part = v4TailMatch[1]!
  }

  const parts = ipv6Part.split(":")
  const doubleColon = parts.indexOf("")

  // Count non-empty hextets
  const nonEmpty = parts.filter(p => p !== "")
  const zerosNeeded = 8 - nonEmpty.length

  let expanded: string[]
  if (doubleColon >= 0) {
    expanded = [
      ...parts.slice(0, doubleColon).map(p => p || "0"),
      ...Array(zerosNeeded).fill("0"),
      ...parts.slice(doubleColon + 1).map(p => p || "0"),
    ]
  } else {
    expanded = parts.map(p => p || "0")
  }

  if (expanded.length !== 8) return []

  const bytes: number[] = []
  for (const hex of expanded) {
    const parsed = parseInt(hex, 16)
    if (isNaN(parsed)) return []
    bytes.push((parsed >> 8) & 0xff)
    bytes.push(parsed & 0xff)
  }
  return bytes.length === 16 ? bytes : []
}

function bytesToBigInt(bytes: number[]): bigint {
  let result = 0n
  for (const b of bytes) {
    result = (result << 8n) | BigInt(b)
  }
  return result
}

function ipInCIDR(ip: string, cidr: string): boolean {
  const parsed = parseCIDR(cidr)
  if (!parsed) return false

  if (parsed.family === 4) {
    if (isIP(ip) !== 4) {
      // Check for IPv4-mapped IPv6 (::ffff:a.b.c.d)
      const mappedMatch = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
      if (mappedMatch) {
        const ipv4 = mappedMatch[1]!
        const addr = ipv4ToUint32(ipv4)
        return (addr & parsed.mask) === parsed.network
      }
      return false
    }
    const addr = ipv4ToUint32(ip)
    return (addr & parsed.mask) === parsed.network
  }

  if (parsed.family === 6) {
    if (isIP(ip) !== 6) return false
    // IPv4-mapped IPv6: convert to IPv4 and check v4 CIDRs too
    const mappedMatch = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
    if (mappedMatch) {
      // Also check against IPv4 CIDRs
      const ipv4 = mappedMatch[1]!
      for (const v4Cidr of BLOCKED_V4_CIDRS) {
        const p = parseCIDR(v4Cidr)
        if (p) {
          const addr = ipv4ToUint32(ipv4)
          if ((addr & p.mask) === p.network) return true
        }
      }
    }
    const bytes = ipv6ToBytes(ip)
    const addr = bytesToBigInt(bytes)
    return (addr & parsed.mask) === parsed.network
  }

  return false
}

// Blocked CIDR ranges:
// IPv4 private/reserved ranges
const BLOCKED_V4_CIDRS = [
  "0.0.0.0/8",       // Current network (RFC 6890)
  "10.0.0.0/8",      // Private
  "100.64.0.0/10",   // CGNAT (RFC 6598)
  "127.0.0.0/8",     // Loopback
  "169.254.0.0/16",  // Link-local
  "172.16.0.0/12",   // Private
  "192.0.0.0/24",    // IETF protocol assignments (RFC 6890)
  "192.0.2.0/24",    // Documentation (TEST-NET-1)
  "192.168.0.0/16",  // Private
  "198.18.0.0/15",   // Benchmarking
  "198.51.100.0/24", // Documentation (TEST-NET-2)
  "203.0.113.0/24",  // Documentation (TEST-NET-3)
  "224.0.0.0/4",     // Multicast
  "240.0.0.0/4",     // Reserved
]

// IPv6 blocked ranges
const BLOCKED_V6_CIDRS = [
  "::/128",          // Unspecified
  "::1/128",         // Loopback
  "fc00::/7",        // Unique-local
  "fe80::/10",       // Link-local
]

// Combined list for iteration
const BLOCKED_CIDRS = [...BLOCKED_V4_CIDRS, ...BLOCKED_V6_CIDRS]

export function hasPrivateIP(host: string): boolean {
  const ipFamily = isIP(host)
  if (!ipFamily) return false

  for (const cidr of BLOCKED_CIDRS) {
    if (ipInCIDR(host, cidr)) return true
  }

  // Also check IPv4-mapped IPv6 against IPv4 CIDRs
  if (ipFamily === 6) {
    const mappedMatch = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
    if (mappedMatch) {
      return hasPrivateIP(mappedMatch[1]!)
    }
  }

  return false
}

export async function isPrivateHostname(host: string): Promise<boolean> {
  try {
    const addrs = await dns.lookup(host, { all: true })
    return addrs.some(a => hasPrivateIP(a.address))
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

      // Validate and check initial URL
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

        // Initial SSRF check
        const ssrfError = await checkSSRF(parsed.hostname, url)
        if (ssrfError) {
          return { content: safeStringify({ error: ssrfError }), isError: true }
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

        // Manual redirect handling for per-hop SSRF validation
        let currentUrl = url
        let redirectCount = 0
        let resp: Response | null = null

        try {
          while (redirectCount <= MAX_REDIRECTS) {
            resp = await fetch(currentUrl, {
              signal,
              redirect: "manual",
              headers: {
                "User-Agent": "Mozilla/5.0 (compatible; Deepreef/1.0; +https://covalo.dev)",
                Accept: acceptHeader(format),
              },
            })

            // Handle redirect (3xx)
            if (resp.status >= 300 && resp.status < 400) {
              const location = resp.headers.get("location")
              if (!location) {
                return { content: safeStringify({ error: `Redirect without Location header: ${resp.status}` }), isError: true }
              }

              redirectCount++
              if (redirectCount > MAX_REDIRECTS) {
                return { content: safeStringify({ error: `Too many redirects (max ${MAX_REDIRECTS})` }), isError: true }
              }

              // Resolve relative redirect URL
              const redirectUrl = new URL(location, currentUrl)
              currentUrl = redirectUrl.toString()

              // SSRF check on redirect target
              const ssrfError = await checkSSRF(redirectUrl.hostname, currentUrl)
              if (ssrfError) {
                return { content: safeStringify({ error: `Redirect target ${ssrfError}` }), isError: true }
              }

              // Continue loop to follow redirect
              continue
            }

            // Non-redirect response: proceed
            break
          }

          if (!resp) {
            return { content: safeStringify({ error: "No response received" }), isError: true }
          }

          // SSRF: validate final URL hostname
          const finalHostname = new URL(currentUrl).hostname
          const ssrfError = await checkSSRF(finalHostname, currentUrl)
          if (ssrfError) {
            return { content: safeStringify({ error: `Final URL ${ssrfError}` }), isError: true }
          }

          if (!resp.ok) {
            return {
              content: safeStringify({ error: `HTTP ${resp.status}: ${resp.statusText}`, code: resp.status, url: currentUrl }),
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
              url: currentUrl,
            }),
            isError: false,
          }
        } finally {
          clearTimeout(timer)
          cleanup()
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

/**
 * Check a hostname/IP for SSRF (private/reserved ranges).
 * Returns an error string if blocked, or null if allowed.
 */
async function checkSSRF(hostname: string, url: string): Promise<string | null> {
  // IP address check
  if (isIP(hostname)) {
    if (hasPrivateIP(hostname)) {
      return `Access to internal network is not allowed: ${hostname}`
    }
    return null
  }

  // Hostname: resolve DNS and check all addresses (both A and AAAA)
  try {
    const addrs = await dns.lookup(hostname, { all: true })
    const blocked = addrs.filter(a => hasPrivateIP(a.address))
    if (blocked.length > 0) {
      return `Hostname ${hostname} resolves to internal network: ${blocked.map(a => a.address).join(", ")}`
    }
    return null
  } catch {
    return `Cannot resolve hostname: ${hostname}`
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
