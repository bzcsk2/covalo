import { stdin as input, stdout as output, stderr as errorOutput } from "node:process"
import { createCovaloRuntime } from "./runtime/create-covalo-runtime.js"
import { runPipeMode } from "./modes/pipe.js"
import { runTuiMode } from "./modes/tui.js"

function printHelp(): void {
  output.write(`covalo

Usage:
  covalo
  echo "你好" | covalo

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
  const sessionId = (sessionIdx >= 0 && sessionIdx + 1 < process.argv.length) ? process.argv[sessionIdx + 1] : undefined

  const runtime = await createCovaloRuntime({
    cwd: process.cwd(),
    sessionId,
    errorOutput,
  })

  try {
    if (!input.isTTY) {
      await runPipeMode(runtime)
      return
    }
    await runTuiMode(runtime)
  } finally {
    await runtime.shutdown()
  }
}

main()
  .then(() => {
    process.exit(0)
  })
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
