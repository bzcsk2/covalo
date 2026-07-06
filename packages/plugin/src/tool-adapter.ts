import type { PluginLoaded } from "./loader.js"
import type { ToolSpec } from "@covalo/protocol"
import { isSchemaAwareTool } from "./define-tool.js"
import { convertSchemaToJsonSpec, validateSchemaArgs } from "./schema-adapter.js"
import type { StandardSchemaLike } from "./schema-adapter.js"

export interface PluginTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute: (args: Record<string, unknown>) => Promise<unknown>
  /** Present if the tool was created via definePluginTool with a schema */
  inputSchema?: StandardSchemaLike
}

export type PluginToolError =
  | { type: "invalid_schema"; pluginId: string; toolName: string; cause: string }
  | { type: "execute_failed"; pluginId: string; toolName: string; cause: string }
  | { type: "validation_failed"; pluginId: string; toolName: string; issues: Array<{ path: string; message: string }> }

export interface PluginToolResult {
  tools: PluginTool[]
  errors: PluginToolError[]
}

function buildToolDescription(pluginId: string, key: string, desc?: string): string {
  return desc ?? `Plugin tool ${pluginId}.${key}`
}

async function extractPluginTools(plugin: PluginLoaded): Promise<PluginToolResult> {
  const tools: PluginTool[] = []
  const errors: PluginToolError[] = []

  if (!plugin.hooks) {
    return { tools, errors }
  }

  for (const [key, value] of Object.entries(plugin.hooks)) {
    if (typeof value !== "function") continue

    const toolName = `${plugin.mod.id}.${key}`

    if (isSchemaAwareTool(value)) {
      const meta = value.covaloTool
      let parameters: Record<string, unknown>
      try {
        parameters = await convertSchemaToJsonSpec(meta.inputSchema)
      } catch (e) {
        errors.push({
          type: "invalid_schema",
          pluginId: plugin.mod.id,
          toolName: key,
          cause: e instanceof Error ? e.message : String(e),
        })
        continue
      }

      tools.push({
        name: toolName,
        description: buildToolDescription(plugin.mod.id, key, meta.description),
        parameters,
        inputSchema: meta.inputSchema,
        execute: async (args: Record<string, unknown>) => {
          const validation = await validateSchemaArgs(meta.inputSchema, args)
          if (!validation.success) {
            throw new Error(JSON.stringify({
              error: "Invalid tool arguments",
              issues: validation.issues,
            }))
          }
          try {
            return await value(validation.data as Record<string, unknown>)
          } catch (e) {
            throw new Error(e instanceof Error ? e.message : String(e))
          }
        },
      })
    } else {
      // Plain function — no schema, no validation
      tools.push({
        name: toolName,
        description: buildToolDescription(plugin.mod.id, key),
        parameters: { type: "object", properties: {} },
        execute: async (args: Record<string, unknown>) => {
          try {
            return await value(args)
          } catch (e) {
            throw new Error(e instanceof Error ? e.message : String(e))
          }
        },
      })
    }
  }

  return { tools, errors }
}

export async function extractToolsFromPlugins(plugins: PluginLoaded[]): Promise<PluginToolResult> {
  const allTools: PluginTool[] = []
  const allErrors: PluginToolError[] = []

  for (const plugin of plugins) {
    const result = await extractPluginTools(plugin)
    allTools.push(...result.tools)
    allErrors.push(...result.errors)
  }

  return { tools: allTools, errors: allErrors }
}

export function pluginToolsToToolSpecs(tools: PluginTool[]): ToolSpec[] {
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }))
}

export async function executePluginTool(
  tool: PluginTool,
  args: Record<string, unknown>,
): Promise<string> {
  try {
    const result = await tool.execute(args)
    if (typeof result === "string") {
      return result
    }
    if (result && typeof result === "object") {
      const record = result as Record<string, unknown>
      if (record.title && record.output) {
        return JSON.stringify({
          title: record.title,
          output: record.output,
          metadata: record.metadata,
        })
      }
    }
    return JSON.stringify(result)
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : String(e))
  }
}
