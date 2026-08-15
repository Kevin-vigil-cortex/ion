import type { Tool } from './types'
import type { ToolDef } from '../types'
import { readFileTool, writeFileTool, editFileTool, listDirTool } from './fs'
import { globTool, grepTool } from './search'
import { runTerminalTool } from './terminal'
import { findPathTool } from './find-path'
import { gitDiffTool, gitCommitTool } from './git'
import { getDiagnosticsTool } from './diagnostics'
import { codeReviewTool } from './code-review'

export const defaultTools: Tool[] = [
  readFileTool,
  listDirTool,
  globTool,
  grepTool,
  writeFileTool,
  editFileTool,
  runTerminalTool,
  findPathTool,
  gitDiffTool,
  gitCommitTool,
  getDiagnosticsTool,
  codeReviewTool
]

/** Index tools by name for O(1) dispatch. */
export function toolMap(tools: Tool[]): Map<string, Tool> {
  return new Map(tools.map((t) => [t.name, t]))
}

/** Project tools down to the provider-facing schema. */
export function toToolDefs(tools: Tool[]): ToolDef[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters
  }))
}

export * from './types'
