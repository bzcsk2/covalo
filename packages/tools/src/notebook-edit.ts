import { readFile, writeFile, rename, stat, mkdir } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { dirname, resolve } from "node:path"
import type { AgentTool } from "@covalo/protocol"
import { safeStringify } from "./safe-stringify.js"
import { isSensitive } from "./sensitive.js"

export function createNotebookEditTool(): AgentTool {
  return {
    name: "NotebookEdit",
    description: "Edit Jupyter notebook (.ipynb) cells. Can create, update, or delete code/markdown cells.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to .ipynb file" },
        action: { type: "string", enum: ["create_cell", "update_cell", "delete_cell"], description: "Action to perform" },
        cell_type: { type: "string", enum: ["code", "markdown"], description: "Cell type for create action" },
        source: { type: "string", description: "New cell content for create/update" },
        index: { type: "number", description: "Cell index for update/delete. Default -1 = append for create." },
      },
      required: ["path", "action"],
    },
    concurrency: "exclusive",
    approval: "write",
    async execute(args, ctx) {
      if (typeof args.path !== "string" || !args.path) {
        return { content: safeStringify({ error: "path is required" }), isError: true }
      }
      const action = args.action
      if (action !== "create_cell" && action !== "update_cell" && action !== "delete_cell") {
        return { content: safeStringify({ error: "action must be 'create_cell', 'update_cell', or 'delete_cell'" }), isError: true }
      }

      const filePath = resolve(ctx.cwd, args.path)
      if (isSensitive(filePath)) {
        return { content: safeStringify({ error: `Access to sensitive file is denied: ${args.path}` }), isError: true }
      }
      let raw: string
      try {
        raw = await readFile(filePath, "utf-8")
      } catch {
        return { content: safeStringify({ error: `File not found: ${args.path}` }), isError: true }
      }

      let notebook: { cells?: Array<{ cell_type?: string; source?: string | string[] }> }
      try {
        notebook = JSON.parse(raw)
      } catch {
        return { content: safeStringify({ error: `Invalid JSON in notebook file: ${args.path}` }), isError: true }
      }

      if (!Array.isArray(notebook.cells)) {
        return { content: safeStringify({ error: "Notebook has no cells array" }), isError: true }
      }

      const cells = notebook.cells
      let index = typeof args.index === "number" ? Math.floor(args.index) : -1

      if (action === "create_cell") {
        const cellType = args.cell_type
        if (cellType !== "code" && cellType !== "markdown") {
          return { content: safeStringify({ error: "cell_type must be 'code' or 'markdown' for create_cell" }), isError: true }
        }
        const source = typeof args.source === "string" ? args.source : ""
        const newCell = { cell_type: cellType, source: [source], metadata: {} }
        if (cellType === "code") {
          ;(newCell as any).outputs = []
          ;(newCell as any).execution_count = null
        }
        if (index < 0 || index >= cells.length) {
          cells.push(newCell)
          index = cells.length - 1
        } else {
          cells.splice(index, 0, newCell)
        }
        await atomicWrite(filePath, JSON.stringify(notebook, null, 1))
        return { content: safeStringify({ action: "create_cell", index, cell_type: cellType, path: args.path }), isError: false }
      }

      if (action === "delete_cell") {
        const idx = index < 0 ? cells.length - 1 : index
        if (idx < 0 || idx >= cells.length) {
          return { content: safeStringify({ error: `Cell index ${idx} out of bounds (cells: ${cells.length})` }), isError: true }
        }
        cells.splice(idx, 1)
        await atomicWrite(filePath, JSON.stringify(notebook, null, 1))
        return { content: safeStringify({ action: "delete_cell", index: idx, path: args.path }), isError: false }
      }

      // update_cell
      if (typeof args.source !== "string") {
        return { content: safeStringify({ error: "source is required for update_cell" }), isError: true }
      }
      const idx = index < 0 ? cells.length - 1 : index
      if (idx < 0 || idx >= cells.length) {
        return { content: safeStringify({ error: `Cell index ${idx} out of bounds (cells: ${cells.length})` }), isError: true }
      }
      cells[idx].source = [args.source]
      await atomicWrite(filePath, JSON.stringify(notebook, null, 1))
      return { content: safeStringify({ action: "update_cell", index: idx, path: args.path }), isError: false }
    },
  }
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const dir = dirname(filePath)
  await mkdir(dir, { recursive: true })
  let originalMode: number | undefined
  try { originalMode = (await stat(filePath)).mode } catch {}
  const tmpPath = `${filePath}.covalo_tmp_${randomUUID()}`
  try {
    await writeFile(tmpPath, content, "utf-8")
    if (originalMode !== undefined) {
      const { chmod } = await import("node:fs/promises")
      await chmod(tmpPath, originalMode).catch(() => {})
    }
    await rename(tmpPath, filePath)
  } catch (e) {
    const { unlink } = await import("node:fs/promises")
    await unlink(tmpPath).catch(() => {})
    throw e
  }
}
