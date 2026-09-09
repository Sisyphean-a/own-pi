export type ToolIdentity = {
  toolName: string;
  builtInToolDefinition?: unknown;
  toolDefinition?: { label?: unknown };
};

const BUILTIN_TOOL_NAMES = new Set(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]);
const BUILTIN_WITH_COMPACT_RESULTS = new Set(["read", "grep", "find", "ls", "bash"]);

// 兼容新版 Pi：内置 renderer 已合并到 toolDefinition，不再单独暴露 builtInToolDefinition。
export function isBuiltInTool(component: ToolIdentity): boolean {
  const label = typeof component.toolDefinition?.label === "string" ? component.toolDefinition.label : "";
  const isMcpTool = label === "MCP" || label.startsWith("MCP:");
  return !isMcpTool && (Boolean(component.builtInToolDefinition) || BUILTIN_TOOL_NAMES.has(component.toolName));
}

export function shouldCompact(component: ToolIdentity): boolean {
  return !isBuiltInTool(component) || BUILTIN_WITH_COMPACT_RESULTS.has(component.toolName);
}
