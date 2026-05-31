import { createInterface } from "node:readline"

createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line)
  if (message.id == null) return
  let result
  switch (message.method) {
    case "initialize":
      result = { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fake", version: "1" } }
      break
    case "tools/list":
      result = { tools: [{ name: "echo", description: "Echo text", inputSchema: { type: "object" } }] }
      break
    case "tools/call":
      result = { content: [{ type: "text", text: message.params.arguments.text }] }
      break
    case "resources/list":
      result = { resources: [] }
      break
    case "prompts/list":
      result = { prompts: [] }
      break
    default:
      result = {}
  }
  console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }))
})
