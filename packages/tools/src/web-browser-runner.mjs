import { lookup } from "node:dns/promises"
import { isIP } from "node:net"

const options = JSON.parse(process.argv[2] ?? "{}")

try {
  const { chromium } = await import("playwright")
  const browser = await chromium.launch({ headless: true })
  try {
    const context = await browser.newContext()
    await context.route("**/*", async route => {
      if (await isPrivateUrl(route.request().url())) await route.abort("blockedbyclient")
      else await route.continue()
    })
    const page = await context.newPage()
    page.setDefaultTimeout(options.timeoutMs ?? 15000)
    await page.goto(options.url, { waitUntil: "domcontentloaded" })

    switch (options.action) {
      case "screenshot":
        console.log(JSON.stringify({ url: page.url(), screenshot: `data:image/png;base64,${(await page.screenshot()).toString("base64")}` }))
        break
      case "click":
        await page.click(options.selector)
        console.log(JSON.stringify({ url: page.url(), clicked: options.selector, content: await page.locator("body").innerText() }))
        break
      case "fill":
        await page.fill(options.selector, options.value)
        console.log(JSON.stringify({ url: page.url(), filled: options.selector, value: await page.inputValue(options.selector) }))
        break
      case "extract":
        console.log(JSON.stringify({ url: page.url(), selector: options.selector, content: await page.locator(options.selector).innerText() }))
        break
      default:
        throw new Error(`Unsupported browser action: ${options.action}`)
    }
  } finally {
    await browser.close()
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}

async function isPrivateUrl(raw) {
  let url
  try { url = new URL(raw) } catch { return false }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false
  const hostname = url.hostname.toLowerCase()
  if (hostname === "localhost" || hostname.endsWith(".local") || hostname.endsWith(".internal")) return true
  if (isIP(hostname)) return isPrivateIp(hostname)
  try {
    const addresses = await lookup(hostname, { all: true })
    return addresses.some(({ address }) => isPrivateIp(address))
  } catch {
    return true
  }
}

function isPrivateIp(address) {
  if (address === "::1" || address.startsWith("fc") || address.startsWith("fd") || address.startsWith("fe80:")) return true
  const match = address.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (!match) return false
  const [, a, b] = match.map(Number)
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}
