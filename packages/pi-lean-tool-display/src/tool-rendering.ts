import {
  renderDiff,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { Container, Text } from "@earendil-works/pi-tui";

type Theme = {
  bold(text: string): string;
  fg(color: string, text: string): string;
};

type ToolContent = { type?: string; text?: string };
type ToolResult = { content?: ToolContent[]; details?: Record<string, unknown> };
type ToolResultOptions = { expanded: boolean; isPartial: boolean };
type CallComponent = { setText(text: string): void };
type ToolRenderState = {
  leanCallComponent?: CallComponent;
  leanCallText?: string;
  leanCallSuffix?: string;
};
type ToolRenderContext = {
  args?: unknown;
  cwd?: string;
  isError?: boolean;
  state?: ToolRenderState;
};
type ToolCallRenderer = (args: unknown, theme: Theme, context?: ToolRenderContext) => unknown;
type ToolResultRenderer = (
  result: ToolResult,
  options: ToolResultOptions,
  theme: Theme,
  context?: ToolRenderContext,
) => unknown;

type ToolDefinitionShape = {
  label?: unknown;
  parameters?: { properties?: Record<string, { type?: unknown }> };
};

type ToolComponent = {
  builtInToolDefinition?: unknown;
  isPartial?: boolean;
  toolDefinition?: ToolDefinitionShape & { renderShell?: unknown };
  toolName: string;
};

type ToolExecutionPrototype = {
  getCallRenderer(this: ToolComponent): ToolCallRenderer | undefined;
  getResultRenderer(this: ToolComponent): ToolResultRenderer | undefined;
  getRenderShell(this: ToolComponent): unknown;
  render(this: ToolComponent, width: number): string[];
};

type Renderable = { render(width: number): string[] };
type ContainerLike = { children: Renderable[] };
type ContainerPrototype = {
  render(this: ContainerLike, width: number): string[];
};
type RenderAwareToolComponent = ToolComponent & {
  [TOOL_PREVIOUS]?: ToolComponent;
};

const LEGACY_TOOL_PATCH = Symbol.for("pi.lean-tool-display.tool-renderers.v1");
const TOOL_PATCH = Symbol.for("pi.lean-tool-display.tool-renderers.v2");
const LEGACY_CONTAINER_PATCH = Symbol.for("pi.lean-tool-display.container-groups.v1");
const CONTAINER_PATCH = Symbol.for("pi.lean-tool-display.container-groups.v2");
const TOOL_PREVIOUS = Symbol.for("pi.lean-tool-display.tool-previous.v1");
const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const OSC133_PATTERN = /\x1b\]133;[ABC](?:\x07|\x1b\\)/g;
const BUILTIN_WITH_COMPACT_RESULTS = new Set(["read", "grep", "find", "ls", "bash"]);

type Patched<T> = T & Record<PropertyKey, unknown>;
type ToolRendererPatch = {
  originalCallRenderer: ToolCallRenderer;
  originalResultRenderer: ToolResultRenderer;
  originalRenderShell: ToolExecutionPrototype["getRenderShell"];
  originalRender: ToolExecutionPrototype["render"];
};
type ContainerPatch = { originalRender: ContainerPrototype["render"] };

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function getText(result: ToolResult): string {
  return (result.content ?? [])
    .filter((block): block is ToolContent & { type: "text"; text: string } =>
      block.type === "text" && typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function countLines(text: string): number {
  return text ? text.split(/\r?\n/).length : 0;
}

function formatToolName(toolName: string): string {
  return toolName
    .replace(/^context_mode_ctx_/, "ctx ")
    .replace(/^context_mode_/, "ctx ")
    .replace(/^context-mode_ctx_/, "ctx ")
    .replace(/^context-mode_/, "ctx ")
    .replace(/^codegraph_codegraph_/, "graph ")
    .replace(/^codegraph_/, "graph ")
    .replace(/_/g, " ");
}

// 主参数候选顺序:优先常见主输入字段,其余按 schema 声明顺序。
const PRIMARY_KEYS = [
  "query",
  "task",
  "path",
  "file_path",
  "command",
  "url",
  "tool",
  "server",
  "search",
  "description",
  "action",
];

function getSchemaStringKeys(toolDefinition: ToolDefinitionShape | undefined): string[] {
  const properties = toolDefinition?.parameters?.properties;
  if (!properties) return [];
  return Object.keys(properties).filter((key) => properties[key]?.type === "string");
}

// Rule: 优先用注册元数据(JSON Schema)确定主参数;无 schema 时回退到参数名白名单。
function pickPrimaryKey(
  toolDefinition: ToolDefinitionShape | undefined,
  args: Record<string, unknown>,
): string | undefined {
  const schemaKeys = getSchemaStringKeys(toolDefinition);
  if (schemaKeys.length > 0) {
    const ordered = [
      ...PRIMARY_KEYS.filter((key) => schemaKeys.includes(key)),
      ...schemaKeys.filter((key) => !PRIMARY_KEYS.includes(key)),
    ];
    return ordered.find((key) => getTextArgument(args[key]) !== undefined);
  }
  return PRIMARY_KEYS.find((key) => getTextArgument(args[key]) !== undefined);
}

// Rule: 显示名优先取注册 label(MCP 工具为 "MCP: 真实工具名"),
// 剥掉服务器前缀;无 label 时才回退到工具名字符串处理。
function formatToolTitle(toolName: string, toolDefinition: ToolDefinitionShape | undefined): string {
  const label = typeof toolDefinition?.label === "string" ? toolDefinition.label.trim() : "";
  if (!label || label === "MCP") return formatToolName(toolName);
  return label.replace(/^MCP:\s*/i, "").replace(/_/g, " ");
}

function getPathDisplay(rawPath: string, cwd?: string): { fileName: string; relativePath: string } {
  const path = rawPath.replace(/^@/, "");
  const absolutePath = cwd && !isAbsolute(path) ? resolve(cwd, path) : path;
  const relativePath = (cwd ? relative(cwd, absolutePath) || "." : path).split(sep).join("/");
  return { fileName: basename(absolutePath), relativePath };
}

function formatReadRange(args: Record<string, unknown>): string {
  const hasOffset = typeof args.offset === "number" && args.offset > 0;
  const offset = hasOffset ? Math.floor(args.offset as number) : 1;
  const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : undefined;
  if (!hasOffset && limit === undefined) {
    return "";
  }
  return ` · lines ${offset}–${limit === undefined ? "…" : offset + limit - 1}`;
}

function formatPathCall(
  toolName: string,
  rawPath: string,
  theme: Theme,
  cwd?: string,
  suffix = "",
): Text {
  const { fileName, relativePath } = getPathDisplay(rawPath, cwd);
  const pathLabel = relativePath === fileName ? "" : ` · ${relativePath}`;
  return new Text(
    theme.fg("toolTitle", theme.bold(`${toolName} `)) +
      theme.fg("accent", fileName) +
      theme.fg("muted", pathLabel + suffix),
    0,
    0,
  );
}

function formatReadCall(args: Record<string, unknown>, theme: Theme, cwd?: string): Text {
  const rawPath = typeof args.path === "string"
    ? args.path
    : typeof args.file_path === "string"
      ? args.file_path
      : "";
  if (!rawPath) {
    return new Text(theme.fg("toolTitle", theme.bold("read")), 0, 0);
  }
  return formatPathCall("read", rawPath, theme, cwd, formatReadRange(args));
}

function getTextArgument(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function formatCustomCall(
  toolName: string,
  toolDefinition: ToolDefinitionShape | undefined,
  args: Record<string, unknown>,
  theme: Theme,
  cwd?: string,
): Text {
  const title = formatToolTitle(toolName, toolDefinition);
  const primaryKey = pickPrimaryKey(toolDefinition, args);
  const primaryValue = primaryKey ? getTextArgument(args[primaryKey]) : undefined;
  if (primaryValue) {
    if (primaryKey === "path" || primaryKey === "file_path") {
      return formatPathCall(title, primaryValue, theme, cwd);
    }
    const suffix = primaryKey === "language" && typeof args.code === "string" ? " code" : "";
    return new Text(
      theme.fg("toolTitle", theme.bold(`${title} `)) + theme.fg("accent", primaryValue + suffix),
      0,
      0,
    );
  }

  const query = getTextArgument(args.query)
    ?? (Array.isArray(args.queries)
      ? args.queries.map(getTextArgument).filter((value): value is string => Boolean(value)).join(" · ")
      : undefined);
  const summary = query
    ?? getTextArgument(args.task)
    ?? getTextArgument(args.command)
    ?? getTextArgument(args.url)
    ?? getTextArgument(args.tool)
    ?? getTextArgument(args.server)
    ?? getTextArgument(args.search)
    ?? getTextArgument(args.description)
    ?? getTextArgument(args.action)
    ?? (getTextArgument(args.language) && typeof args.code === "string"
      ? `${args.language} code`
      : undefined);
  if (summary) {
    return new Text(
      theme.fg("toolTitle", theme.bold(`${title} `)) + theme.fg("accent", summary),
      0,
      0,
    );
  }

  const fields = Object.keys(args).filter((name) => name !== "code" && name !== "content" && name !== "args");
  const suffix = fields.length === 0 ? "" : ` (${fields.length} args)`;
  return new Text(
    theme.fg("toolTitle", theme.bold(title)) + theme.fg("muted", suffix),
    0,
    0,
  );
}

function formatCall(
  toolName: string,
  toolDefinition: ToolDefinitionShape | undefined,
  args: unknown,
  theme: Theme,
  context?: ToolRenderContext,
): Text {
  const record = asRecord(args);
  if (toolName === "read") {
    return formatReadCall(record, theme, context?.cwd);
  }
  return formatCustomCall(toolName, toolDefinition, record, theme, context?.cwd);
}

function rememberCallComponent(component: unknown, context?: ToolRenderContext): unknown {
  const state = context?.state;
  const componentRecord = asRecord(component);
  const text = componentRecord.text;
  const setText = componentRecord.setText;
  if (!state || typeof text !== "string" || typeof setText !== "function") {
    return component;
  }

  state.leanCallComponent = component as CallComponent;
  state.leanCallText = text;
  if (state.leanCallSuffix) {
    state.leanCallComponent.setText(text + state.leanCallSuffix);
  }
  return component;
}

function updateCallSuffix(context: ToolRenderContext | undefined, suffix: string): void {
  const state = context?.state;
  if (!state) {
    return;
  }
  state.leanCallSuffix = suffix;
  if (state.leanCallComponent && state.leanCallText !== undefined) {
    state.leanCallComponent.setText(state.leanCallText + suffix);
  }
}

function formatLineCountSuffix(lines: number, theme: Theme): string {
  return theme.fg("muted", ` (${lines} ${lines === 1 ? "line" : "lines"})`);
}

function emptyResult(): Text {
  return new Text("", 0, 0);
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find((item) => item.trim())?.trim() ?? "tool failed";
  return line.length > 240 ? `${line.slice(0, 239)}...` : line;
}

function compactResult(
  result: ToolResult,
  options: ToolResultOptions,
  theme: Theme,
  context?: ToolRenderContext,
): Text {
  const output = getText(result);
  if (options.isPartial) {
    updateCallSuffix(context, "");
    return emptyResult();
  }
  if (context?.isError) {
    updateCallSuffix(context, theme.fg("error", ` (error: ${firstLine(output)})`));
    return emptyResult();
  }

  const truncation = asRecord(result.details?.truncation);
  const outputLines = typeof truncation.outputLines === "number" && truncation.outputLines >= 0
    ? Math.floor(truncation.outputLines)
    : countLines(output);
  updateCallSuffix(context, formatLineCountSuffix(outputLines, theme));

  if (options.expanded) {
    return new Text(
      output ? theme.fg("toolOutput", output) : theme.fg("muted", "completed"),
      0,
      0,
    );
  }
  return emptyResult();
}

function compactEditResult(
  result: ToolResult,
  options: ToolResultOptions,
  theme: Theme,
  context?: ToolRenderContext,
): Text {
  if (options.isPartial || context?.isError) {
    return compactResult(result, options, theme, context);
  }

  const diff = typeof result.details?.diff === "string" ? result.details.diff : undefined;
  const lines = diff ? countLines(diff) : 0;
  updateCallSuffix(context, formatLineCountSuffix(lines, theme));
  if (options.expanded && diff) {
    return new Text(renderDiff(diff), 0, 0);
  }
  return emptyResult();
}

function compactWriteResult(
  result: ToolResult,
  options: ToolResultOptions,
  theme: Theme,
  context?: ToolRenderContext,
): Text {
  if (options.isPartial || context?.isError) {
    return compactResult(result, options, theme, context);
  }

  const content = typeof asRecord(context?.args).content === "string"
    ? asRecord(context?.args).content as string
    : "";
  const lines = countLines(content);
  updateCallSuffix(context, formatLineCountSuffix(lines, theme));
  if (options.expanded && content) {
    const numberedAdditions = content
      .split(/\r?\n/)
      .map((line, index) => `+${index + 1} ${line}`)
      .join("\n");
    return new Text(renderDiff(numberedAdditions), 0, 0);
  }
  return emptyResult();
}

function shouldCompact(component: ToolComponent): boolean {
  return !component.builtInToolDefinition || BUILTIN_WITH_COMPACT_RESULTS.has(component.toolName);
}

function isMcpTool(component: ToolComponent): boolean {
  const label = typeof component.toolDefinition?.label === "string" ? component.toolDefinition.label : "";
  return label === "MCP" || label.startsWith("MCP:");
}

function canJoinToolGroup(component: ToolComponent): boolean {
  return component.toolName !== "write" && component.toolName !== "edit";
}

function isAdjacentToToolGroup(component: ToolComponent): boolean {
  const previous = (component as RenderAwareToolComponent)[TOOL_PREVIOUS];
  return Boolean(previous && canJoinToolGroup(previous) && canJoinToolGroup(component));
}

function removeTrailingBlankLines(lines: string[]): void {
  while (lines.length > 0 && stripControlSequences(lines[lines.length - 1]).trim().length === 0) {
    lines.pop();
  }
}

/**
 * Effect: groups consecutive visible tool rows; edit and write remain standalone.
 * Guarantee: invisible rows do not split a group, while visible non-tool rows do.
 */
export function installContainerParentTracking(): void {
  const prototype = Container.prototype as unknown as Patched<ContainerPrototype>;
  const currentPatch = prototype[CONTAINER_PATCH] as ContainerPatch | undefined;
  if (currentPatch) return;

  const legacyPatch = prototype[LEGACY_CONTAINER_PATCH] as ContainerPatch | undefined;
  const originalRender = legacyPatch?.originalRender ?? prototype.render;
  prototype.render = function renderWithToolGroups(this: ContainerLike, width: number): string[] {
    const lines: string[] = [];
    let previousVisibleTool: ToolComponent | undefined;

    for (const child of this.children) {
      const isTool = child instanceof ToolExecutionComponent;
      const tool = isTool ? child as unknown as ToolComponent : undefined;
      const joinsPrevious = Boolean(
        tool && previousVisibleTool && canJoinToolGroup(tool) && canJoinToolGroup(previousVisibleTool),
      );
      if (tool) {
        (tool as RenderAwareToolComponent)[TOOL_PREVIOUS] = joinsPrevious
          ? previousVisibleTool
          : undefined;
      }

      const childLines = child.render(width);
      if (joinsPrevious && childLines.length > 0) {
        removeTrailingBlankLines(lines);
      }
      lines.push(...childLines);
      if (childLines.length > 0) {
        previousVisibleTool = tool;
      }
    }

    return lines;
  };
  prototype[CONTAINER_PATCH] = { originalRender } satisfies ContainerPatch;
}

export function installToolRenderers(): void {
  const prototype = ToolExecutionComponent.prototype as unknown as Patched<ToolExecutionPrototype>;
  const previousPatch = prototype[TOOL_PATCH] as ToolRendererPatch | undefined;
  if (!previousPatch && prototype[LEGACY_TOOL_PATCH]) {
    return;
  }
  const originalCallRenderer = previousPatch?.originalCallRenderer ?? prototype.getCallRenderer;
  const originalResultRenderer = previousPatch?.originalResultRenderer ?? prototype.getResultRenderer;
  const originalRenderShell = previousPatch?.originalRenderShell ?? prototype.getRenderShell;
  const originalRender = previousPatch?.originalRender ?? prototype.render;

  prototype.getCallRenderer = function getLeanCallRenderer(this: ToolComponent) {
    if (!shouldCompact(this)) {
      return originalCallRenderer.call(this);
    }
    if (this.builtInToolDefinition && this.toolName !== "read") {
      const renderer = originalCallRenderer.call(this);
      return renderer
        ? (args, theme, context) => rememberCallComponent(renderer(args, theme, context), context)
        : undefined;
    }
    return (args, theme, context) => rememberCallComponent(
      formatCall(this.toolName, this.toolDefinition, args, theme, context),
      context,
    );
  };

  prototype.getResultRenderer = function getLeanResultRenderer(this: ToolComponent) {
    if (!shouldCompact(this)) {
      return originalResultRenderer.call(this);
    }
    if (this.toolName === "edit") {
      return compactEditResult;
    }
    if (this.toolName === "write") {
      return compactWriteResult;
    }
    return compactResult;
  };

  // Effect: MCP adapter defaults to a self-rendered compact surface. Lean replaces its
  // renderers with one-line summaries, so use pi's default shell to retain tool state framing.
  prototype.getRenderShell = function getLeanRenderShell(this: ToolComponent) {
    return shouldCompact(this) && isMcpTool(this) ? "default" : originalRenderShell.call(this);
  };

  prototype.render = function renderLeanToolExecution(this: ToolComponent, width: number): string[] {
    const joinsGroup = canJoinToolGroup(this);
    const maxContentLines = this.toolName === "edit" && this.isPartial === false
      ? undefined
      : joinsGroup
        ? 2
        : undefined;
    return compactToolFrame(
      originalRender.call(this, width),
      joinsGroup && isAdjacentToToolGroup(this),
      maxContentLines,
    );
  };

  prototype[TOOL_PATCH] = {
    originalCallRenderer,
    originalResultRenderer,
    originalRenderShell,
    originalRender,
  } satisfies ToolRendererPatch;
}

function stripControlSequences(line: string): string {
  return line.replace(OSC133_PATTERN, "").replace(ANSI_PATTERN, "");
}

function compactToolFrame(
  lines: string[],
  removeLeadingSpacer = false,
  maxContentLines?: number,
): string[] {
  if (lines.length === 0) {
    return lines;
  }

  let start = 0;
  let end = lines.length;
  while (start < end && stripControlSequences(lines[start]).trim().length === 0) {
    start++;
  }
  while (end > start && stripControlSequences(lines[end - 1]).trim().length === 0) {
    end--;
  }

  const content = maxContentLines === undefined
    ? lines.slice(start, end)
    : lines.slice(start, end).slice(0, maxContentLines);
  if (content.length === 0) {
    return [];
  }
  const leadingSpacers = !removeLeadingSpacer ? lines.slice(0, start) : [];
  const trailingSpacers = lines.slice(end);
  return [...leadingSpacers, ...content, ...trailingSpacers];
}

