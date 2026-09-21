/**
 * 上下文查看的文本格式化与 token 估算。
 *
 * 本模块不引入 Pi 运行时依赖：token 估算器和压缩预留量由调用方注入，因此可以直接在 `node --test` 中验证。
 */

import type { ContextUsage, SessionContext, SessionEntry, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { UiTheme } from "../overlay-frame.ts";

type AgentMessage = SessionContext["messages"][number];
type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;
type ToolCallBlock = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;
type MessageContent = Extract<AgentMessage, { content: unknown }>["content"];
type ToolDefView = Pick<ToolInfo, "name"> & { description?: string; parameters?: unknown };

export type TokenBreakdownDeps = {
  /** Pi 的逐条消息 token 估算器，覆盖 thinking 与图片内容。 */
  estimateTokens(message: AgentMessage): number;
  /** Pi 自动压缩预留量。 */
  reserveTokens: number;
};

const roleLabels: Record<string, string> = {
  user: "用户",
  assistant: "助手",
  toolResult: "工具结果",
  bashExecution: "命令执行",
  branchSummary: "分支摘要",
  compactionSummary: "压缩摘要",
  custom: "自定义",
};

const stopReasonLabels: Record<string, string> = {
  pending: "进行中",
  stop: "正常结束",
  length: "达到长度上限",
  toolUse: "调用工具",
  error: "错误",
  aborted: "已中止",
  deferred: "已延后",
};

export function formatTokens(n: number | null | undefined): string {
  if (n == null) return "N/A";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.min(999, Math.round(n / 1_000))}k`;
  return n.toString();
}

export function formatLabel(value: string | undefined, labels: Record<string, string>): string {
  if (!value) return "未知";
  return labels[value] ?? value;
}

/** 生成带行号的显示行；主题只用于着色，不改变列宽。 */
export function buildNumberedLines(text: string, theme: UiTheme): string[] {
  const rawLines = text.split("\n");
  const numWidth = String(rawLines.length).length;
  return rawLines.map((line, i) => {
    const num = String(i + 1).padStart(numWidth, " ");
    return `${theme.fg("dim", num)} ${theme.fg("dim", "│")} ${line}`;
  });
}

export function formatContent(content: MessageContent): string[] {
  if (typeof content === "string") return [content];

  const lines: string[] = [];
  for (const block of content) {
    switch (block.type) {
      case "text":
        lines.push(block.text);
        break;
      case "thinking":
        lines.push(`[思考：${block.thinking}]`);
        break;
      case "toolCall":
        lines.push(`[工具调用：${block.name}(${JSON.stringify(block.arguments ?? {})})]`);
        break;
      case "image":
        lines.push(`[图片：${block.mimeType ?? "未知类型"}]`);
        break;
      default:
        lines.push(`[${(block as { type?: string }).type ?? "未知"}]`);
    }
  }
  return lines;
}

export function formatUsage(usage: AssistantMessage["usage"]): string {
  const parts: string[] = [
    `输入 ${usage.input}`,
    `输出 ${usage.output}`,
    `缓存读取 ${usage.cacheRead}`,
    `缓存写入 ${usage.cacheWrite}`,
    `合计 ${usage.totalTokens}`,
  ];
  return `Token：${parts.join("，")}`;
}

export function formatMessageForDisplay(message: AgentMessage, index: number): string[] {
  const lines: string[] = ["", `──── 消息 ${index + 1} ────`, `角色：${formatLabel(message.role, roleLabels)}`];

  if (message.role === "assistant") {
    lines.push(`模型：${[message.provider, message.model].filter(Boolean).join("/")}`);
    lines.push(formatUsage(message.usage));
    lines.push(`停止原因：${formatLabel(message.stopReason, stopReasonLabels)}`);
    if (message.errorMessage) lines.push(`错误：${message.errorMessage}`);
  }

  if (message.role === "toolResult") {
    lines.push(`工具：${message.toolName ?? "未知"}`);
    lines.push(`工具调用 ID：${message.toolCallId ?? "未知"}`);
    lines.push(`错误：${message.isError ? "是" : "否"}`);
  }

  if (message.role === "bashExecution") {
    lines.push(`命令：${message.command}`);
    lines.push(...(message.output ? message.output.split("\n") : ["（无输出）"]));
    const status: string[] = [];
    if (message.cancelled) status.push("已取消");
    if (message.truncated) status.push("已截断");
    lines.push(
      `退出码：${message.exitCode == null ? "未知" : message.exitCode}${status.length > 0 ? `（${status.join("、")}）` : ""}`,
    );
    if (message.truncated && message.fullOutputPath) {
      lines.push(`完整输出：${message.fullOutputPath}`);
    }
    return lines;
  }

  if (message.role === "branchSummary") {
    lines.push(`分支来源：${message.fromId}`);
    lines.push(message.summary);
    return lines;
  }

  if (message.role === "compactionSummary") {
    lines.push(`压缩前 token：${message.tokensBefore}`);
    lines.push(message.summary);
    return lines;
  }

  if (message.role === "custom") {
    lines.push(`自定义类型：${message.customType}`);
  }

  if ("content" in message) {
    lines.push(...formatContent(message.content));
  }
  return lines;
}

export function formatMessagesText(context: SessionContext): string {
  const lines: string[] = [];
  if (context.messages.length > 0) {
    for (let i = 0; i < context.messages.length; i++) {
      lines.push(...formatMessageForDisplay(context.messages[i]!, i));
    }
  } else {
    lines.push("（暂无消息）");
  }
  return lines.join("\n");
}

export interface ContextViewerModelInfo {
  provider: string;
  id: string;
  contextWindow?: number;
}

export function buildTotalContextText(
  systemPrompt: string,
  context: SessionContext,
  usage: ContextUsage | undefined,
  model: ContextViewerModelInfo | undefined,
): string {
  const sections: string[] = [];

  sections.push("═══════════════════════════════════════════════════════");
  sections.push("系统提示词");
  sections.push("═══════════════════════════════════════════════════════");
  sections.push(systemPrompt);
  sections.push("");

  sections.push("═══════════════════════════════════════════════════════");
  sections.push("消息");
  sections.push("═══════════════════════════════════════════════════════");
  sections.push(formatMessagesText(context));
  sections.push("");

  sections.push("═══════════════════════════════════════════════════════");
  sections.push("上下文用量");
  sections.push("═══════════════════════════════════════════════════════");
  if (usage) {
    sections.push(`Token：${usage.tokens?.toLocaleString() ?? "未知"}`);
    if (model) {
      sections.push(`模型：${model.provider}/${model.id}`);
      const contextWindow = model.contextWindow ?? usage.contextWindow;
      if (contextWindow) {
        const pct = usage.percent ?? (usage.tokens == null ? null : (usage.tokens / contextWindow) * 100);
        sections.push(
          `用量：${usage.tokens?.toLocaleString() ?? "未知"} / ${contextWindow.toLocaleString()}（${pct == null ? "未知" : `${pct.toFixed(1)}%`}）`,
        );
      }
    }
  } else {
    sections.push("（暂无用量数据）");
  }

  return sections.join("\n");
}

/** 把已启用工具定义格式化为可读文本。 */
export function buildToolsText(activeToolDefs: ToolDefView[]): string {
  if (activeToolDefs.length === 0) return "（无已启用工具）";

  const sections: string[] = [];
  for (const tool of activeToolDefs) {
    sections.push("─".repeat(56));
    sections.push(`工具：${tool.name}`);
    if (tool.description) {
      sections.push(`说明：${tool.description}`);
    }
    if (tool.parameters) {
      sections.push("参数：");
      const params = tool.parameters as {
        properties?: Record<string, { type?: string; description?: string }>;
        required?: string[];
      };
      if (params?.properties) {
        for (const [key, val] of Object.entries(params.properties)) {
          const required = params.required?.includes(key) ? "" : "，可选";
          const type = val.type ?? "未知";
          const desc = val.description ? `：${val.description}` : "";
          sections.push(`  ${key}（${type}${required}）${desc}`);
        }
      } else {
        sections.push(`  ${JSON.stringify(tool.parameters, null, 2).split("\n").join("\n  ")}`);
      }
    }
    sections.push("");
  }

  return sections.join("\n");
}

export interface ContextTokenBreakdown {
  total: number;
  contextWindow: number;
  percent: number;
  reserveTokens: number;
  safeAvailable: number;
  systemPrompt: number;
  systemTools: number;
  tools: number;
  skills: number;
  messages: number;
  other: number;
}

/** 读取技能文件的工具调用（含技能目录）计入技能而不是工具；Windows 反斜杠路径先归一化。 */
export function isSkillPath(path: unknown): boolean {
  if (typeof path !== "string") return false;
  return /(^|\/)\.agents\/skills\/|(^|\/)\.pi\/agent\/.*\/skills\/|(^|\/)skills\/[^/]+\/SKILL\.md$/i.test(path.replaceAll("\\", "/"));
}

export function isSkillReadToolCall(block: ToolCallBlock): boolean {
  if (block.name !== "read") return false;
  return isSkillPath(block.arguments?.path);
}

const ESTIMATED_IMAGE_CHARS = 4800;

/**
 * 按类别拆分 token 用量：先用字符估算得到各类别比例，再整体缩放到 provider 上报的总量。
 *
 * Guarantee: 各分类之和加上 `other` 恰好等于 `usage.tokens`，不会出现总量与分类不一致。
 */
export function buildTokenBreakdown(
  systemPrompt: string,
  activeToolDefs: ToolInfo[],
  branch: SessionEntry[],
  usage: ContextUsage | undefined,
  deps: TokenBreakdownDeps,
): ContextTokenBreakdown | null {
  if (usage == null || usage.tokens == null || !usage.contextWindow) return null;

  const estimateChars = (text: string) => Math.ceil(text.length / 4);
  const reserveTokens = Math.min(deps.reserveTokens, usage.contextWindow);

  const systemRaw = estimateChars(systemPrompt);
  const toolDefsRaw = estimateChars(JSON.stringify(activeToolDefs));

  let msgTokensRaw = 0;
  let toolsRaw = 0;
  let skillsRaw = 0;
  const skillToolCallIds = new Set<string>();

  for (const entry of branch) {
    if (entry.type === "message") {
      const message = entry.message;
      const messageTotal = deps.estimateTokens(message);
      const weights = { messages: 0, tools: 0, skills: 0 };

      if (message.role === "user" || message.role === "custom") {
        if (typeof message.content === "string") {
          weights.messages += estimateChars(message.content);
        } else {
          for (const block of message.content) {
            if (block.type === "text") weights.messages += estimateChars(block.text);
            else if (block.type === "image") weights.messages += ESTIMATED_IMAGE_CHARS;
          }
        }
      } else if (message.role === "assistant") {
        for (const block of message.content) {
          if (block.type === "text") weights.messages += estimateChars(block.text);
          else if (block.type === "thinking") weights.messages += estimateChars(block.thinking);
          else if (block.type === "toolCall") {
            if (isSkillReadToolCall(block)) {
              weights.skills += estimateChars(JSON.stringify(block));
              skillToolCallIds.add(block.id);
            } else {
              weights.tools += estimateChars(JSON.stringify(block));
            }
          }
        }
      } else if (message.role === "toolResult") {
        const isSkillResult = skillToolCallIds.has(message.toolCallId);
        for (const block of message.content) {
          if (block.type === "text") {
            if (isSkillResult) weights.skills += estimateChars(block.text);
            else weights.tools += estimateChars(block.text);
          }
        }
      } else if (message.role === "bashExecution") {
        weights.tools += estimateChars(message.command) + estimateChars(message.output);
      }

      const weightSum = weights.messages + weights.tools + weights.skills;
      if (weightSum > 0) {
        const scale = messageTotal / weightSum;
        msgTokensRaw += weights.messages * scale;
        toolsRaw += weights.tools * scale;
        skillsRaw += weights.skills * scale;
      }
    } else if (entry.type === "branch_summary" || entry.type === "compaction") {
      msgTokensRaw += estimateChars(entry.summary);
    }
  }

  const totalRaw = systemRaw + skillsRaw + toolDefsRaw + msgTokensRaw + toolsRaw;
  const ratio = totalRaw > 0 ? usage.tokens / totalRaw : 1;

  const exact = {
    systemPrompt: systemRaw * ratio,
    systemTools: toolDefsRaw * ratio,
    tools: toolsRaw * ratio,
    skills: skillsRaw * ratio,
    messages: msgTokensRaw * ratio,
  };
  const allocated = { systemPrompt: 0, systemTools: 0, tools: 0, skills: 0, messages: 0 };
  let remainder = usage.tokens;
  const keys = Object.keys(exact) as (keyof typeof exact)[];
  for (const key of keys) {
    const value = Math.floor(exact[key]);
    allocated[key] = value;
    remainder -= value;
  }
  if (totalRaw > 0) {
    const byFraction = [...keys].sort((a, b) => (exact[b] % 1) - (exact[a] % 1));
    for (const key of byFraction) {
      if (remainder <= 0) break;
      allocated[key] += 1;
      remainder -= 1;
    }
  }

  return {
    total: usage.tokens,
    contextWindow: usage.contextWindow,
    percent: usage.percent ?? (usage.tokens / usage.contextWindow) * 100,
    reserveTokens,
    safeAvailable: Math.max(0, usage.contextWindow - reserveTokens - usage.tokens),
    systemPrompt: allocated.systemPrompt,
    systemTools: allocated.systemTools,
    tools: allocated.tools,
    skills: allocated.skills,
    messages: allocated.messages,
    other: Math.max(
      0,
      usage.tokens -
        (allocated.systemPrompt + allocated.systemTools + allocated.tools + allocated.skills + allocated.messages),
    ),
  };
}
