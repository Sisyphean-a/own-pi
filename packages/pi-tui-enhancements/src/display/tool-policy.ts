export type ToolIdentity = {
  toolName: string;
  builtInToolDefinition?: unknown;
  toolDefinition?: { label?: unknown };
};

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const OSC133_PATTERN = /\x1b\]133;[ABC](?:\x07|\x1b\\)/g;

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

/** 命令与输出的行计数不把末尾换行额外算作一行。 */
export function countTextLines(text: string): number {
  if (!text) return 0;
  const lines = text.split(/\r?\n/);
  return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

export function firstLinePreview(text: string): { text: string; lineCount: number } {
  const lineCount = countTextLines(text);
  const first = text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
  return {
    text: lineCount > 1 && first ? `${first} …` : first,
    lineCount,
  };
}

export function formatCommandMetrics(commandLines: number, outputLines?: number): string {
  const lineLabel = (count: number) => `${count} ${count === 1 ? "line" : "lines"}`;
  return `(cmd ${lineLabel(commandLines)} · out ${outputLines === undefined ? "…" : lineLabel(outputLines)})`;
}

function isBlankDisplayLine(line: string): boolean {
  return line.replace(OSC133_PATTERN, "").replace(ANSI_PATTERN, "").trim().length === 0;
}

/**
 * 折叠态只保留一个稳定的底部结构空行，不能把流式文本产生的尾部空行带回结果。
 */
export function compactToolFrame(
  lines: string[],
  removeLeadingSpacer = false,
  maxContentLines?: number,
): string[] {
  if (lines.length === 0) return lines;

  let start = 0;
  let end = lines.length;
  while (start < end && isBlankDisplayLine(lines[start]!)) start++;
  while (end > start && isBlankDisplayLine(lines[end - 1]!)) end--;

  const content = maxContentLines === undefined
    ? lines.slice(start, end)
    : lines.slice(start, end).slice(0, maxContentLines);
  if (content.length === 0) return [];

  const leadingSpacers = !removeLeadingSpacer ? lines.slice(0, start) : [];
  const trailingSpacers = maxContentLines === undefined
    ? lines.slice(end)
    : end < lines.length
      ? [lines[lines.length - 1]!]
      : [];
  return [...leadingSpacers, ...content, ...trailingSpacers];
}
