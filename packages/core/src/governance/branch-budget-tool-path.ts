// G1: 对齐运行时真实工具名。原集合含 edit_file/append_file/patch_file/
// batch_edit_file 等运行时不存在的名字，导致 edit/NotebookEdit 的编辑计数被遗漏。
// 运行时注册见 engine.ts:938 / loop.ts:575。
const FILE_WRITE_TOOLS = new Set([
  "write_file",
  "edit",
  "NotebookEdit",
])

/** 从 write/edit 类工具参数中提取目标文件路径。 */
export function extractToolTargetPath(
  toolName: string,
  args: Record<string, unknown>,
): string | undefined {
  if (!FILE_WRITE_TOOLS.has(toolName)) return undefined
  const raw = args.path ?? args.file_path
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined
}

/** 从 run_command 参数中提取命令字符串。 */
export function extractRunCommand(args: Record<string, unknown>): string | undefined {
  const raw = args.command ?? args.cmd ?? args.script
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined
}

/** 是否为文件写入类工具。 */
export function isFileWriteTool(toolName: string): boolean {
  return FILE_WRITE_TOOLS.has(toolName)
}
