import type { AgentTool } from "../../core/src/interface.js"
import { safeStringify } from "./safe-stringify.js"
import { appendFile, mkdir, readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

interface StoredMessage {
  id: string
  recipient: string
  messageType: string
  message: string
  timestamp: number
  senderSessionId: string
}

export function createSendMessageTool(): AgentTool {
  return {
    name: "SendMessage",
    description: "Send or list durable project-local messages for another agent or process.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["send", "list"], description: "Action to perform. Defaults to send." },
        recipient: { type: "string", description: "Target agent name or channel." },
        message: { type: "string", description: "Message content to send." },
        type: { type: "string", enum: ["info", "request", "response", "error"], description: "Message type." },
      },
      required: [],
    },
    concurrency: "shared",
    approval: "read",
    async execute(args, ctx) {
      const action = args.action ?? "send"
      if (action !== "send" && action !== "list") {
        return { content: safeStringify({ error: "action must be 'send' or 'list'" }), isError: true }
      }
      const filePath = resolve(ctx.cwd, ".deepicode", "messages.jsonl")

      if (action === "list") {
        const messages = await readMessages(filePath)
        const recipient = typeof args.recipient === "string" && args.recipient.trim() ? args.recipient.trim() : undefined
        return {
          content: safeStringify({ messages: recipient ? messages.filter(message => message.recipient === recipient) : messages }),
          isError: false,
        }
      }

      if (typeof args.recipient !== "string" || !args.recipient.trim() || typeof args.message !== "string" || !args.message.trim()) {
        return { content: safeStringify({ error: "recipient and message are required" }), isError: true }
      }
      const stored: StoredMessage = {
        id: crypto.randomUUID(),
        recipient: args.recipient.trim(),
        messageType: typeof args.type === "string" ? args.type : "info",
        message: args.message,
        timestamp: Date.now(),
        senderSessionId: ctx.sessionId,
      }
      await mkdir(dirname(filePath), { recursive: true })
      await appendFile(filePath, `${JSON.stringify(stored)}\n`, "utf8")
      return {
        content: safeStringify({
          status: "sent",
          ...stored,
        }),
        isError: false,
      }
    },
  }
}

async function readMessages(filePath: string): Promise<StoredMessage[]> {
  try {
    const raw = await readFile(filePath, "utf8")
    return raw.split("\n").filter(Boolean).flatMap(line => {
      try { return [JSON.parse(line) as StoredMessage] } catch { return [] }
    })
  } catch {
    return []
  }
}
