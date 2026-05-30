import { stdin as input, stdout as output, stderr as errorOutput } from "node:process"
import { writeSync } from "node:fs"
import { loadConfig } from "../../core/src/config.js"
import { ReasonixEngine } from "../../core/src/engine.js"
import { buildSystemPrompt } from "../../core/src/system-prompt.js"
import { createBashTool, createEditTool, createReadFileTool, createWriteFileTool, createListDirTool, createGrepTool, createTodoWriteTool, createGlobTool, createWebFetchTool, createWebSearchTool, createSkillTool } from "../../tools/src/index.js"
import { clearReadTracker } from "../../tools/src/stale-read.js"
import { McpHost, createListMcpResourcesTool, createReadMcpResourceTool, createMcpAuthTool, setMcpHost } from "../../mcp/src/index.js"
import React from "react"
import { wrappedRender as render } from "@deepicode/ink"
import { App } from "../../tui/src/App.js"

function printHelp(): void {
  output.write(`deepicode

Usage:
  bun run packages/cli/src/index.ts
  echo "你好" | bun run packages/cli/src/index.ts

Commands:
  /exit, /bye    exit the interactive session
  /help          show this help
`)
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printHelp()
    return
  }

  const sessionIdx = process.argv.indexOf("--session")
  const sessionId = sessionIdx >= 0 ? process.argv[sessionIdx + 1] : undefined
  const config = loadConfig()

  // Initialize MCP host
  const mcpHost = new McpHost()
  try { await mcpHost.loadConfig() } catch { /* no mcp.json */ }
  setMcpHost(mcpHost)

  const engine = sessionId
    ? await ReasonixEngine.recover(config, sessionId)
    : new ReasonixEngine(config, clearReadTracker)
  engine.setSystemPrompt(buildSystemPrompt(process.cwd()))
  engine.registerTool(createReadFileTool())
  engine.registerTool(createBashTool())
  engine.registerTool(createEditTool())
  engine.registerTool(createWriteFileTool())
  engine.registerTool(createListDirTool())
  engine.registerTool(createGrepTool())
  engine.registerTool(createTodoWriteTool())
  engine.registerTool(createGlobTool())
  engine.registerTool(createWebFetchTool())
  engine.registerTool(createWebSearchTool())
  engine.registerTool(createSkillTool())
  engine.registerTool(createListMcpResourcesTool())
  engine.registerTool(createReadMcpResourceTool())
  engine.registerTool(createMcpAuthTool())

  if (!input.isTTY) {
    await runPipeMode(engine)
    return
  }

  await runTUIMode(engine, config)
}

async function runPipeMode(engine: ReasonixEngine): Promise<void> {
  const chunks: Buffer[] = []
  for await (const chunk of input) chunks.push(Buffer.from(chunk))
  const prompt = Buffer.concat(chunks).toString("utf8").trim()
  if (!prompt) return
  for await (const event of engine.submit(prompt)) {
    switch (event.role) {
      case "assistant_delta":
        output.write(event.content ?? "")
        break
      case "assistant_final":
        output.write("\n")
        break
      case "reasoning_delta":
        break
      case "tool_call_delta":
        break
      case "tool_start":
        output.write(`\n[tool] ${event.toolName ?? "unknown"} ...\n`)
        break
      case "tool_progress":
        break
      case "tool": {
        const c = event.content ?? ""
        try { const p = JSON.parse(c) as Record<string,unknown>; output.write(JSON.stringify(p, null, 2) + "\n") }
        catch { output.write(c + "\n") }
        break
      }
      case "status":
        if (event.content && event.content !== "tools_completed" && event.content !== "interrupted") {
          output.write(`\n# ${event.content}\n`)
        }
        break
      case "warning":
        errorOutput.write(`\nwarning: ${event.content ?? ""}\n`)
        break
      case "error":
        errorOutput.write(`\nerror: ${event.content ?? ""}\n`)
        break
      case "done":
        break
    }
  }
}

async function runTUIMode(engine: ReasonixEngine, config: ReturnType<typeof loadConfig>): Promise<void> {
  try {
    const { waitUntilExit } = await render(
      React.createElement(App, { engine, config }),
      { exitOnCtrlC: false }  // Don't let Ink intercept \x03 — we handle SIGINT ourselves
    );
    await waitUntilExit();
  } finally {
    // Ensure terminal is restored even if render throws
    try { writeSync(1, '\x1b[?1049l'); } catch {} // EXIT_ALT_SCREEN
    try { writeSync(1, '\x1b[?25h'); } catch {}   // SHOW_CURSOR
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
