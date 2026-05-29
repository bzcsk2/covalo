import type { DeepicodeConfig } from "./config.js"
import { ContextManager } from "./context/manager.js"
import type { ChatMessage, ToolCall, ToolSpec } from "./types.js"
import type { CoreEngine, AgentConfig, AgentTool, LoopEvent, AgentState, ToolContext, SessionStats, ToolResult } from "./interface.js"
import { DeepSeekClient } from "./client.js"
import { StreamingToolExecutor } from "./streaming-executor.js"
import { AsyncSessionWriter } from "./session.js"

let sessionCounter = 0

export class ReasonixEngine implements CoreEngine {
  private config: DeepicodeConfig
  private ctx: ContextManager
  private tools: Map<string, AgentTool> = new Map()
  private client: DeepSeekClient
  private toolExecutor: StreamingToolExecutor
  private _interrupted = false
  private activeAbortController?: AbortController
  private sessionId: string
  private sessionWriter?: AsyncSessionWriter
  private stats: SessionStats = {
    promptTokens: 0, completionTokens: 0,
    cacheHitTokens: 0, cacheMissTokens: 0,
    apiCalls: 0, toolCalls: 0, totalCost: 0,
  }

  constructor(config: DeepicodeConfig) {
    this.config = config
    this.ctx = new ContextManager()
    this.client = new DeepSeekClient()
    this.sessionId = `session-${++sessionCounter}-${Date.now()}`
    this.toolExecutor = new StreamingToolExecutor(this.tools, this.sessionId)

    // best-effort session persistence
    const sessionPath = `${process.cwd()}/.deepicode/sessions/${this.sessionId}.jsonl`
    const writer = new AsyncSessionWriter(sessionPath)
    writer.init().catch(() => {})
    this.sessionWriter = writer
  }

  setSystemPrompt(prompt: string): void {
    this.ctx.prefix.build(prompt)
  }

  getContextManager(): ContextManager {
    return this.ctx
  }

  registerTool(tool: AgentTool): void {
    this.tools.set(tool.name, tool)
  }

  interrupt(): void {
    this._interrupted = true
    this.activeAbortController?.abort()
  }

  switchAgent(_agentName: string): void {}
  resolveTierDecision(_tier: string): void {}

  getState(): AgentState {
    return {
      sessionId: this.sessionId,
      messages: [...this.ctx.buildMessages()],
      isStreaming: false,
      streamingMessage: "",
      pendingToolCalls: [],
      currentAgent: "build",
      stats: { ...this.stats },
    }
  }

  async *submit(userInput: string, _agentConfig?: AgentConfig): AsyncGenerator<LoopEvent> {
    this._interrupted = false
    const abortController = new AbortController()
    this.activeAbortController = abortController
    this.ctx.startTurn()
    this.ctx.log.append({ role: "user", content: userInput })
    this.sessionWriter?.enqueue({ ts: Date.now(), type: "messages", payload: this.ctx.buildMessages() })

    try {
      const toolSpecs: ToolSpec[] = []
      for (const tool of this.tools.values()) {
        toolSpecs.push({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        })
      }

      // Rebuild prefix fingerprint with current tool specs (tool schema changes affect prefix-cache)
      this.ctx.prefix.build(this.ctx.prefix.messages[0]?.content ?? "", toolSpecs)

      let turnCount = 0
      const maxTurns = 10
      let consecutiveErrors = 0

      while (turnCount < maxTurns) {
        turnCount++
        if (this._interrupted) {
          yield { role: "status", content: "interrupted" }
          return
        }

        let fullContent = ""
        let fullReasoning = ""
        const toolCalls: ToolCall[] = []
        let streamError: LoopEvent | null = null

        for await (const event of this.client.chatCompletionsStream(this.ctx.buildMessages(), {
          apiKey: this.config.apiKey,
          baseUrl: this.config.baseUrl,
          model: this.config.model,
          maxTokens: this.config.maxTokens,
          temperature: this.config.temperature,
          signal: abortController.signal,
          tools: toolSpecs.length > 0 ? toolSpecs : undefined,
        })) {
          if (this._interrupted) {
            yield { role: "status", content: "interrupted" }
            return
          }

          switch (event.type) {
            case "text_delta":
              fullContent += event.delta
              yield { role: "assistant_delta", content: event.delta }
              this.sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: { role: "assistant_delta", content: event.delta } })
              break
            case "reasoning_delta":
              fullReasoning += event.delta
              yield { role: "reasoning_delta", content: event.delta }
              this.sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: { role: "reasoning_delta", content: event.delta } })
              break
            case "tool_call_end": {
              const tc: ToolCall = {
                id: event.id,
                type: "function",
                function: {
                  name: event.name,
                  arguments: event.arguments,
                },
              }
              toolCalls.push(tc)
              yield { role: "tool_call_delta", toolName: event.name, content: event.arguments }
              this.sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: { role: "tool_call_delta", toolName: event.name, content: event.arguments } })
              break
            }
            case "usage":
              this.stats.promptTokens += event.usage.promptTokens
              this.stats.completionTokens += event.usage.completionTokens
              this.stats.cacheHitTokens += event.usage.cacheHitTokens ?? 0
              this.stats.cacheMissTokens += event.usage.cacheMissTokens ?? 0
              this.stats.apiCalls++
              this.sessionWriter?.enqueue({ ts: Date.now(), type: "stats", payload: { ...this.stats } })
              break
            case "done": {
              const reason = event.finishReason ?? "stop"
              // tool-calling reasons vary across providers; accept common variants.
              const isToolUse =
                reason === "tool_calls" || reason === "tool_use" || reason === "toolUse" || reason === "toolCall" || reason === "tool"

              // yield assistant_final before tool execution or done
              yield { role: "assistant_final", content: fullContent, metadata: { reasoning: fullReasoning || undefined } }

              if (isToolUse) {
                this.ctx.log.append({
                  role: "assistant",
                  content: fullContent || null,
                  reasoning_content: fullReasoning || null,
                  tool_calls: toolCalls,
                })
                this.sessionWriter?.enqueue({ ts: Date.now(), type: "messages", payload: this.ctx.buildMessages() })

                for await (const toolEvent of this.toolExecutor.run(toolCalls, abortController.signal, (tc, result) => this.appendToolResult(tc, result))) {
                  yield toolEvent
                  this.sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: toolEvent })
                }
                yield { role: "status", content: "tools_completed" }
                this.sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: { role: "status", content: "tools_completed" } })
              } else {
                this.ctx.log.append({ role: "assistant", content: fullContent, reasoning_content: fullReasoning || null })
                yield { role: "done", metadata: { reason } as Record<string, unknown> }
                this.sessionWriter?.enqueue({ ts: Date.now(), type: "messages", payload: this.ctx.buildMessages() })
                this.sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: { role: "done", metadata: { reason } } })
                return
              }

              break
            }
            case "error":
              streamError = { role: "error", content: event.message, severity: "error", metadata: event.status ? { status: event.status } : undefined }
              yield streamError
              this.sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: streamError })
              break
          }
        }

        if (streamError) {
          // If we got partial content, we can try again next turn
          if (fullContent) {
            this.ctx.log.append({ role: "assistant", content: fullContent, reasoning_content: fullReasoning || null })
          }
          consecutiveErrors++
          if (consecutiveErrors >= 3) {
            yield { role: "error", content: `Stream failed after ${consecutiveErrors} consecutive attempts`, severity: "error" }
            return
          }
          // Continue the while loop to retry
          continue
        }
        consecutiveErrors = 0
      }

      yield { role: "warning", content: `Reached maximum tool loop count (${maxTurns}).`, severity: "warning" }
      yield { role: "done", metadata: { reason: "maxTurns" } }
    } finally {
      if (this.activeAbortController === abortController) {
        this.activeAbortController = undefined
      }
    }
  }

  private appendToolResult(tc: ToolCall, result: ToolResult): void {
    this.stats.toolCalls++
    this.ctx.log.append({
      role: "tool",
      tool_call_id: tc.id,
      content: result.content,
      name: tc.function.name,
      is_error: result.isError,
    })
  }
}

// buildOmpContext removed: engine now talks directly to DeepSeek official API.
