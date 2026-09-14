export type ToolIdentity = {
  toolName: string;
  builtInToolDefinition?: unknown;
  toolDefinition?: { label?: unknown };
};

const BUILTIN_TOOL_NAMES = new Set(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]);
// Rule: 内置 shell 工具与检索类工具共用紧凑结果；其余内置工具保留 Pi 原生渲染（例如 edit/write 的 diff 预览）。
const BUILTIN_WITH_COMPACT_RESULTS = new Set(["read", "grep", "find", "ls", "bash", "powershell"]);

// Rule: 折叠态可分组工具最多保留一行正文，只显示标题、行数或错误摘要。
const COLLAPSED_TOOL_CONTENT_LINES = 1;

// Rule: edit 和 write 保持独立边界，不参与连续工具行的间距合并。
export function canJoinToolGroup(component: Pick<ToolIdentity, "toolName">): boolean {
  return component.toolName !== "write" && component.toolName !== "edit";
}

// Rule: 只有折叠态裁剪正文；展开态交给 Pi 输出完整结果，避免遮蔽 Ctrl+O 的展开语义。
// Failure: Pi 不再暴露 expanded 或仍用旧的二行上限时按折叠处理，最坏情况只是正文被裁得更紧。
export function getCollapsedContentLineLimit(
  component: ToolIdentity & { expanded?: unknown },
): number | undefined {
  if (component.expanded === true) {
    return undefined;
  }
  return canJoinToolGroup(component) ? COLLAPSED_TOOL_CONTENT_LINES : undefined;
}

// 兼容新版 Pi：内置 renderer 已合并到 toolDefinition，不再单独暴露 builtInToolDefinition。
export function isBuiltInTool(component: ToolIdentity): boolean {
  const label = typeof component.toolDefinition?.label === "string" ? component.toolDefinition.label : "";
  const isMcpTool = label === "MCP" || label.startsWith("MCP:");
  return !isMcpTool && (Boolean(component.builtInToolDefinition) || BUILTIN_TOOL_NAMES.has(component.toolName));
}

export function shouldCompact(component: ToolIdentity): boolean {
  return !isBuiltInTool(component) || BUILTIN_WITH_COMPACT_RESULTS.has(component.toolName);
}
