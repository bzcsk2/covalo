import http from "node:http"
import { AddressInfo } from "node:net"
import { Socket } from "node:net"

const SCENARIOS: Record<string, () => { chunks: SseChunk[]; status: number }> = {
  normal: () => ({
    status: 200,
    chunks: [
      { data: `data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n` },
      { data: `data: {"choices":[{"delta":{"content":" world"}}]}\n\n` },
      { data: `data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":3,"total_tokens":13}}\n\n` },
      { data: "data: [DONE]\n\n" },
    ],
  }),

  tool_calls: () => ({
    status: 200,
    chunks: [
      { data: `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":""}}]}}]}\n\n` },
      { data: `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\"test.txt\\""}}}]}}]}\n\n` },
      { data: `data: {"choices":[{"delta":{"content":""},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":20,"completion_tokens":5,"total_tokens":25}}\n\n` },
      { data: "data: [DONE]\n\n" },
    ],
  }),

  reasoning: () => ({
    status: 200,
    chunks: [
      { data: `data: {"choices":[{"delta":{"reasoning_content":"Let me think"}}]}\n\n` },
      { data: `data: {"choices":[{"delta":{"reasoning_content":" step by step"}}]}\n\n` },
      { data: `data: {"choices":[{"delta":{"content":"The answer is 42"}}]}\n\n` },
      { data: `data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":8,"total_tokens":18}}\n\n` },
      { data: "data: [DONE]\n\n" },
    ],
  }),

  error_429: () => ({
    status: 429,
    chunks: [{ data: `{"error":{"message":"Rate limit exceeded","type":"rate_limit_error"}}` }],
  }),

  error_500: () => ({
    status: 500,
    chunks: [{ data: `{"error":{"message":"Internal server error"}}` }],
  }),
}

export interface SseChunk {
  data: string
  delay?: number
}

function buildScenarioChunks(scenario: string): { chunks: SseChunk[]; status: number } {
  const builder = SCENARIOS[scenario]
  if (builder) return builder()
  return SCENARIOS.normal()
}

export class MockSseServer {
  #server: http.Server
  #url = ""
  #scenario = "normal"
  #chunks: SseChunk[] = []
  #statusCode = 200
  #delayMs = 30
  #chunkSize = 0
  #requestCount = 0
  #maxRequests = Infinity
  #failFirst = 0
  #sockets = new Set<Socket>()

  constructor() {
    this.#server = http.createServer((req, res) => {
      res.on("close", () => this.#sockets.delete(req.socket))
      this.#sockets.add(req.socket)
      this.#requestCount++
      if (this.#requestCount > this.#maxRequests) {
        res.writeHead(503)
        res.end("request limit exceeded")
        return
      }
      if (this.#requestCount <= this.#failFirst) {
        res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "1" })
        res.end(JSON.stringify({ error: { message: "Rate limit exceeded", type: "rate_limit_error" } }))
        return
      }
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`)
      const scenario = url.searchParams.get("scenario") ?? this.#scenario
      const { chunks, status } = buildScenarioChunks(scenario)
      const effectiveChunks = this.#chunks.length > 0 ? this.#chunks : chunks
      const effectiveStatus = this.#statusCode !== 200 ? this.#statusCode : status

      if (effectiveStatus !== 200) {
        res.writeHead(effectiveStatus, { "Content-Type": "application/json" })
        for (const c of effectiveChunks) {
          res.write(c.data)
        }
        res.end()
        return
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      })

      let parts: string[] | null = null
      let partIdx = 0
      let chunkIdx = 0
      const emit = () => {
        if (parts) {
          if (partIdx < parts.length) {
            res.write(parts[partIdx++])
            setTimeout(emit, this.#delayMs > 0 ? 1 : 0)
            return
          }
          parts = null
          partIdx = 0
        }
        if (chunkIdx >= effectiveChunks.length) {
          res.end()
          return
        }
        const c = effectiveChunks[chunkIdx++]
        const delay = c.delay ?? this.#delayMs
        if (this.#chunkSize > 0 && c.data.length > this.#chunkSize) {
          parts = splitIntoParts(c.data, this.#chunkSize)
          partIdx = 0
          res.write(parts[partIdx++])
          setTimeout(emit, this.#delayMs > 0 ? 1 : 0)
        } else {
          res.write(c.data)
          if (delay > 0) {
            setTimeout(emit, delay)
          } else {
            setImmediate(emit)
          }
        }
      }
      emit()
    })
  }

  async start(): Promise<void> {
    if (this.#url) return
    await new Promise<void>((resolve) => this.#server.listen(0, resolve))
    const port = (this.#server.address() as AddressInfo).port
    this.#url = `http://localhost:${port}`
  }

  async stop(): Promise<void> {
    if (!this.#url) return
    for (const sock of this.#sockets) {
      sock.destroy()
    }
    this.#sockets.clear()
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => resolve(), 2000)
      this.#server.close((err) => {
        clearTimeout(timer)
        if (err) reject(err); else resolve()
      })
    })
    this.#url = ""
  }

  get url(): string {
    if (!this.#url) throw new Error("MockSseServer not started")
    return this.#url
  }

  get baseUrl(): string {
    return this.url + "/"
  }

  setScenario(name: string): this {
    this.#scenario = name
    this.#chunks = []
    this.#statusCode = 200
    return this
  }

  setChunks(chunks: SseChunk[], statusCode = 200): this {
    this.#chunks = chunks
    this.#statusCode = statusCode
    return this
  }

  setDelay(ms: number): this {
    this.#delayMs = ms
    return this
  }

  setChunkSize(bytes: number): this {
    this.#chunkSize = bytes
    return this
  }

  setMaxRequests(n: number): this {
    this.#maxRequests = n
    return this
  }

  setFailFirst(n: number): this {
    this.#failFirst = n
    return this
  }

  get requestCount(): number {
    return this.#requestCount
  }

  reset(): void {
    this.#requestCount = 0
    this.#maxRequests = Infinity
    this.#failFirst = 0
    this.#scenario = "normal"
    this.#chunks = []
    this.#statusCode = 200
    this.#delayMs = 30
    this.#chunkSize = 0
  }
}

function splitIntoParts(data: string, size: number): string[] {
  const parts: string[] = []
  for (let i = 0; i < data.length; i += size) {
    parts.push(data.slice(i, i + size))
  }
  return parts
}
