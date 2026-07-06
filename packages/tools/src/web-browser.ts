import { spawn } from "node:child_process"
import { isIP } from "node:net"
import { fileURLToPath } from "node:url"
import type { AgentTool } from "@covalo/protocol"
import { safeStringify } from "./safe-stringify.js"
import { hasPrivateIP, isPrivateHostname } from "./web-fetch.js"

export function createWebBrowserTool(): AgentTool {
  return {
    name: "WebBrowser",
    description: "Launch a headless browser to interact with web pages. Can navigate, click, fill forms, take screenshots, and extract content.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["navigate", "click", "fill", "screenshot", "extract"],
          description: "The action to perform.",
        },
        url: { type: "string", description: "The URL to open. Required for every action." },
        selector: { type: "string", description: "CSS selector for click/fill/extract." },
        value: { type: "string", description: "Value to fill (required for fill action)." },
        timeout_ms: { type: "number", description: "Timeout in milliseconds (default 15000)." },
      },
      required: ["action"],
    },
    concurrency: "exclusive",
    approval: "read",
    async execute(args, ctx) {
      const action = args.action as string | undefined
      if (!action || !["navigate", "click", "fill", "screenshot", "extract"].includes(action)) {
        return { content: safeStringify({ error: "action must be one of: navigate, click, fill, screenshot, extract" }), isError: true }
      }

      const timeoutMs = typeof args.timeout_ms === "number" ? Math.max(0, Math.floor(args.timeout_ms)) : 15000

      if (action === "navigate") {
        const url = args.url as string | undefined
        if (!url) return { content: safeStringify({ error: "url is required for navigate action" }), isError: true }

        const urlErr = validateUrl(url)
        if (urlErr) return { content: safeStringify({ error: urlErr }), isError: true }

        try {
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), timeoutMs)
          const { signal, cleanup } = ctx.signal ? anySignal(ctx.signal, controller.signal) : { signal: controller.signal, cleanup: () => {} }

          try {
            const result = await fetchWithManualRedirects(url, signal)
          if ("error" in result) {
            return { content: safeStringify({ error: result.error }), isError: true }
          }
          const resp = result
          const finalUrl = resp.url || url

          if (!resp.ok) {
            return { content: safeStringify({ error: `HTTP ${resp.status}: ${resp.statusText}`, code: resp.status, url: finalUrl }), isError: true }
          }

          const text = await resp.text()
          const contentType = resp.headers.get("content-type") ?? ""
          const isHtml = contentType.includes("text/html")
          const content = isHtml ? htmlToText(text) : text

          return { content: safeStringify({ content, code: resp.status, url: finalUrl }), isError: false }
          } finally {
            clearTimeout(timer)
            cleanup()
          }
        } catch (e) {
          if (e instanceof Error && e.name === "AbortError") {
            return { content: safeStringify({ error: "Navigation timed out" }), isError: true }
          }
          return { content: safeStringify({ error: `Navigation failed: ${e instanceof Error ? e.message : String(e)}` }), isError: true }
        }
      }

      const url = args.url as string | undefined
      if (!url) return { content: safeStringify({ error: `url is required for ${action} action` }), isError: true }
      const urlErr = await validateRemoteUrl(url)
      if (urlErr) return { content: safeStringify({ error: urlErr }), isError: true }
      if ((action === "click" || action === "fill" || action === "extract") && typeof args.selector !== "string") {
        return { content: safeStringify({ error: `selector is required for ${action} action` }), isError: true }
      }
      if (action === "fill" && typeof args.value !== "string") {
        return { content: safeStringify({ error: "value is required for fill action" }), isError: true }
      }

      const runner = new URL("./web-browser-runner.mjs", import.meta.url)
      const payload = JSON.stringify({
        action,
        url,
        selector: args.selector,
        value: args.value,
        timeoutMs,
      })

      let stdout: string
      let stderr: string
      let exitCode: number | null
      try {
        const result = await runPlaywright(fileURLToPath(runner), payload, timeoutMs + 5000, ctx.signal)
        stdout = result.stdout
        stderr = result.stderr
        exitCode = result.exitCode
      } catch (e) {
        return {
          content: safeStringify({ error: `Playwright process failed: ${e instanceof Error ? e.message : String(e)}` }),
          isError: true,
        }
      }

      if (exitCode !== 0) {
        const detail = stderr?.trim()
        return {
          content: safeStringify({ error: detail || "Playwright is not installed or the browser action failed. Install playwright and its Chromium browser." }),
          isError: true,
        }
      }
      try {
        return { content: safeStringify(JSON.parse(stdout)), isError: false }
      } catch {
        return { content: safeStringify({ error: "Playwright runner returned invalid output" }), isError: true }
      }
    },
  }
}

async function validateRemoteUrl(raw: string): Promise<string | null> {
  const urlErr = validateUrl(raw)
  if (urlErr) return urlErr
  const hostname = new URL(raw).hostname
  if (hasPrivateIP(hostname) || isPrivateHostnameSync(hostname)) return `URL resolves to private network: ${raw}`
  if (!isIP(hostname)) {
    try {
      if (await isPrivateHostname(hostname)) return `URL resolves to private network: ${raw}`
    } catch {
      return `Cannot resolve hostname: ${raw}`
    }
  }
  return null
}

function validateUrl(raw: string): string | null {
  let url: URL
  try { url = new URL(raw) } catch { return "Invalid URL" }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "Only http/https URLs are allowed"
  if (url.username || url.password) return "URLs with credentials are not allowed"
  return null
}

const PRIVATE_HOSTNAMES = new Set([
  "localhost", "localhost.localdomain", "localhost6", "ip6-localhost",
  "metadata.google.internal", "169.254.169.254",
])

const MAX_BROWSER_REDIRECTS = 5

/**
 * Fetch with manual redirect following and per-hop SSRF validation.
 * Each redirect target is validated before the request is made.
 */
async function fetchWithManualRedirects(
  rawUrl: string,
  signal: AbortSignal,
): Promise<Response | { error: string }> {
  let currentUrl = rawUrl

  for (let i = 0; i <= MAX_BROWSER_REDIRECTS; i++) {
    const urlErr = await validateRemoteUrl(currentUrl)
    if (urlErr) return { error: urlErr }

    const resp = await fetch(currentUrl, { signal, redirect: "manual" })

    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get("location")
      if (!location) return { error: "Redirect without Location header: " + resp.status }

      const nextUrl = new URL(location, currentUrl).toString()
      const nextErr = await validateRemoteUrl(nextUrl)
      if (nextErr) return { error: "Redirect target blocked: " + nextErr }

      currentUrl = nextUrl
      continue
    }

    return resp
  }

  return { error: `Too many redirects (max ${MAX_BROWSER_REDIRECTS})` }
}

function isPrivateHostnameSync(hostname: string): boolean {
  return PRIVATE_HOSTNAMES.has(hostname) || hostname.endsWith(".local") || hostname.endsWith(".internal")
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

function runPlaywright(
  runnerPath: string,
  payload: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [runnerPath, payload], {
      timeout: timeoutMs,
      signal,
    })
    let stdout = ""
    let stderr = ""
    let killed = false

    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString() })
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString() })

    proc.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code })
    })

    proc.on("error", (err) => {
      if (!killed) reject(err)
    })

    // Enforce output limit
    const checkSize = () => {
      if (stdout.length > 5_000_000) {
        killed = true
        proc.kill()
        resolve({ stdout: stdout.slice(0, 5_000_000), stderr, exitCode: null })
      }
    }
    proc.stdout.on("data", checkSize)
  })
}
