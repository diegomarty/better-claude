// Which tool calls may change the working tree, and so need the turn's snapshot first. When
// unsure, a tool may write: a snapshot it did not need costs a tree walk, a missing one costs
// the way back.

import { readOnly } from './bash.js'

// Tools that never write the working tree. An agent's own tools raise their own calls, so
// starting one writes nothing by itself
const LOOKS = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite', 'TodoRead', 'Agent', 'Task',
  'AskUserQuestion', 'ToolSearch', 'Skill', 'ListMcpResourcesTool', 'ReadMcpResourceTool', 'ReadMcpResourceDirTool',
  'TaskGet', 'TaskList', 'TaskOutput', 'ExitPlanMode', 'EnterPlanMode', 'LSP'])
// An MCP tool whose name says it only reads: `mcp__github__get_issue`, `mcp__fs__list_directory`
const MCP_LOOKS = /^mcp__.+__(?:get|list|read|search|find|fetch|query|view|show|describe|lookup|check|count|stat)(?:_|$)/i
// …unless a verb that writes is anywhere in it: `find_and_replace`, `check_and_fix`
const MCP_WRITES = /(?:^|_)(?:write|edit|replace|create|update|delete|remove|move|rename|apply|fix|set|save|patch|insert|put|add|append|upsert|store|upload|download|copy|clear|reset|commit|merge|run|exec|execute|format|generate|install|import|sync|push|pull|restore|extract)(?:_|$)/i

/**
 * Whether the call may change files. Bash by its command (see bash.js); a known tool by its
 * name; any other, an MCP writer or a tool this list has never heard of, may.
 * @param {string} tool
 * @param {Record<string, unknown>} [input]
 */
export function mayWrite (tool, input = {}) {
  if (tool === 'Bash') return !(typeof input.command === 'string' && readOnly(input.command))
  if (LOOKS.has(tool)) return false
  return !(MCP_LOOKS.test(tool) && !MCP_WRITES.test(tool.replace(/^mcp__.+?__/, '')))
}
