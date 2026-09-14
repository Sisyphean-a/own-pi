/**
 * 上下文查看：`/context` 打开带标签页的弹窗，展示当前会话的完整 LLM 上下文。
 *
 * 标签页：[统计] token 分布与分类明细、[系统] 系统提示词、[工具] 已启用工具定义、
 * [消息] 全部会话消息、[完整] 完整上下文转储。
 */

import {
  buildSessionContext,
  DEFAULT_COMPACTION_SETTINGS,
  estimateTokens,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  buildNumberedLines,
  buildTokenBreakdown,
  buildToolsText,
  buildTotalContextText,
  formatMessagesText,
  formatTokens,
} from "./format.ts";
import { OVERLAY_OPTIONS, overlayContentHeight, type UiTheme, type WidthUtils } from "./frame.ts";
import { TabbedOverlay } from "./overlay.ts";
import { ScrollableTabContent } from "./scrollable-tab.ts";
import { StatsTabContent } from "./stats-tab.ts";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function numberedTab(
  text: string,
  name: string,
  theme: UiTheme,
  widthUtils: WidthUtils,
  contentHeight: number,
): ScrollableTabContent {
  return new ScrollableTabContent(
    { rawText: text, displayLines: buildNumberedLines(text, theme), theme, widthUtils, contentHeight },
    name,
  );
}

async function showContextInspector(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("上下文查看仅支持交互式终端", "warning");
    return;
  }

  const systemPrompt = ctx.getSystemPrompt() ?? "";
  const usage = ctx.getContextUsage();

  const activeToolNames = pi.getActiveTools();
  const activeToolDefs = pi.getAllTools().filter((tool) => activeToolNames.includes(tool.name));

  const branch = ctx.sessionManager.getBranch();
  const context = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());

  const breakdown = buildTokenBreakdown(systemPrompt, activeToolDefs, branch, usage, {
    estimateTokens,
    reserveTokens: DEFAULT_COMPACTION_SETTINGS.reserveTokens,
  });
  const toolsText = buildToolsText(activeToolDefs);
  const fullText = buildTotalContextText(systemPrompt, context, usage, ctx.model);
  const messagesText = formatMessagesText(context);

  const subtitle =
    usage?.tokens != null && usage.contextWindow != null
      ? `${formatTokens(usage.tokens)} / ${formatTokens(usage.contextWindow)} (${(usage.percent ?? (usage.tokens / usage.contextWindow) * 100).toFixed(1)}%)`
      : "暂无用量数据";

  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => {
      const widthUtils: WidthUtils = { visibleWidth, truncateToWidth };
      const contentHeight = overlayContentHeight(tui.terminal?.rows ?? 40);
      const modelName = ctx.model?.id ?? "未知模型";

      const tabs = [
        new StatsTabContent(breakdown, theme, widthUtils, {
          name: modelName,
          contextWindow: ctx.model?.contextWindow ?? usage?.contextWindow,
        }),
        numberedTab(systemPrompt, "系统", theme, widthUtils, contentHeight),
        numberedTab(toolsText, "工具", theme, widthUtils, contentHeight),
        numberedTab(messagesText, "消息", theme, widthUtils, contentHeight),
        numberedTab(fullText, "完整", theme, widthUtils, contentHeight),
      ];

      return new TabbedOverlay({
        title: "上下文查看器",
        subtitle,
        tabs,
        theme,
        widthUtils,
        contentHeight,
        done,
      });
    },
    OVERLAY_OPTIONS,
  );
}

export default function contextInspector(pi: ExtensionAPI): void {
  if (typeof pi.registerCommand !== "function") return;
  pi.registerCommand("context", {
    description: "查看上下文用量、系统提示词、工具、消息和完整上下文",
    handler: async (_args, ctx) => {
      try {
        await showContextInspector(pi, ctx);
      } catch (error) {
        // Failure: 弹窗或数据采集失败时提示原因，不影响当前会话。
        ctx.ui.notify(`无法打开上下文查看：${errorMessage(error)}`, "error");
      }
    },
  });
}
