/**
 * 一次 TUI 显示会话：把 display 域的模块接到 Pi 生命周期上。
 *
 * Flow: `session_start` 提供主题、同步思考折叠标签、安装紧凑 footer 并刷新 usage；
 * `message_update`/`message_end` 标记思考内容，`context` 事件清掉思考标记，快捷键切换折叠。
 * Rule: 补丁安装留在组合根；事件接线、主题缓存、思考折叠动作和 usage 调度集中在这里，
 * 每个事件处理器自己承担失败隔离，不让可选功能影响 Pi 启动。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { errorMessage } from "../optional-feature.ts";

type ThemeLike = { bold(text: string): string; fg(color: string, text: string): string };
type MessageDisplayModule = typeof import("./message-display.ts");
type CompactFooterBundle = {
  create: typeof import("./compact-footer.ts").createCompactFooter;
  widthUtils: {
    visibleWidth: typeof import("@earendil-works/pi-tui").visibleWidth;
    truncateToWidth: typeof import("@earendil-works/pi-tui").truncateToWidth;
  };
};
type UsageController = { clear(ctx: ExtensionContext): void; refresh(ctx: ExtensionContext): Promise<void> };

export type DisplaySessionOptions = {
  messageDisplay?: MessageDisplayModule;
  compactFooter?: CompactFooterBundle;
  usageController?: UsageController;
  /** installThinkingCollapse 是否成功；失败时只保留思考显示，不接管折叠。 */
  thinkingAvailable?: boolean;
};

function hasUiMethod<T extends keyof ExtensionContext["ui"]>(ctx: ExtensionContext, method: T): boolean {
  try {
    return Boolean(ctx.hasUI && typeof ctx.ui?.[method] === "function");
  } catch {
    return false;
  }
}

export function restoreWorkingIndicator(ctx: ExtensionContext): void {
  if (!hasUiMethod(ctx, "setWorkingVisible")) return;
  try {
    ctx.ui.setWorkingVisible(true);
  } catch (error) {
    console.error(`[pi-tui-enhancements/内置工作指示器] 不可用，已隐藏相关功能：${errorMessage(error)}`);
  }
}

async function refreshUsage(controller: UsageController, ctx: ExtensionContext): Promise<void> {
  try {
    await controller.refresh(ctx);
  } catch (error) {
    console.error(`[pi-tui-enhancements/usage] 刷新失败：${errorMessage(error)}`);
  }
}

function clearUsage(controller: UsageController, ctx: ExtensionContext): void {
  try {
    controller.clear(ctx);
  } catch (error) {
    console.error(`[pi-tui-enhancements/usage] 清理失败：${errorMessage(error)}`);
  }
}

export function createDisplaySession(options: DisplaySessionOptions): { register(pi: ExtensionAPI): void } {
  const { messageDisplay, compactFooter, usageController } = options;
  const thinkingAvailable = options.thinkingAvailable === true && messageDisplay !== undefined;

  const installFooter = (ctx: ExtensionContext): void => {
    if (!compactFooter || !hasUiMethod(ctx, "setFooter")) return;
    ctx.ui.setFooter((tui, theme, footerData) =>
      compactFooter.create(
        ctx,
        tui,
        theme,
        footerData,
        compactFooter.widthUtils,
      ));
    restoreWorkingIndicator(ctx);
  };

  const start = (ctx: ExtensionContext): void => {
    try {
      if (ctx.hasUI && ctx.ui?.theme) {
        messageDisplay?.setDisplayTheme(ctx.ui.theme as unknown as ThemeLike);
        if (thinkingAvailable && hasUiMethod(ctx, "setHiddenThinkingLabel")) {
          messageDisplay!.syncThinkingLabel(ctx);
        }
        installFooter(ctx);
      }
    } catch (error) {
      console.error(`[pi-tui-enhancements/会话显示初始化] 失败：${errorMessage(error)}`);
    }
    if (usageController) void refreshUsage(usageController, ctx);
  };

  const labelAssistantMessage = (event: { message?: unknown }, ctx: ExtensionContext): void => {
    if (!messageDisplay) return;
    if (!ctx.hasUI || !ctx.ui?.theme) return;
    if (messageDisplay.isAssistantMessage(event.message)) {
      messageDisplay.labelThinking(event.message, ctx.ui.theme as unknown as ThemeLike);
    }
  };

  const labelHandler = (event: { message?: unknown }, ctx: ExtensionContext): void => {
    try {
      labelAssistantMessage(event, ctx);
    } catch (error) {
      console.error(`[pi-tui-enhancements/思考内容标记] 失败：${errorMessage(error)}`);
    }
  };

  const register = (pi: ExtensionAPI): void => {
    if (typeof pi.on === "function") {
      pi.on("session_start", (_event, ctx) => {
        start(ctx);
      });

      if (usageController) {
        pi.on("model_select", (_event, ctx) => {
          // The usage controller selects the provider-specific endpoint and
          // clears the optional status for unsupported providers.
          void refreshUsage(usageController, ctx);
        });
      }

      pi.on("session_shutdown", (_event, ctx) => {
        if (usageController) clearUsage(usageController, ctx);
      });

      if (messageDisplay) {
        // 两个事件共用同一处理器：message_update 流式到达、message_end 收尾时都要标记思考内容。
        pi.on("message_update", labelHandler);
        pi.on("message_end", labelHandler);

        pi.on("context", (event) => {
          try {
            event.messages.splice(0, event.messages.length, ...messageDisplay.sanitizeThinking(event.messages));
          } catch (error) {
            console.error(`[pi-tui-enhancements/思考内容清理] 失败：${errorMessage(error)}`);
          }
        });
      }
    }

    if (!thinkingAvailable || typeof pi.registerShortcut !== "function") return;
    pi.registerShortcut("ctrl+shift+t", {
      description: "折叠或展开思考内容",
      handler: (ctx) => {
        try {
          if (hasUiMethod(ctx, "setHiddenThinkingLabel")) {
            messageDisplay!.toggleThinking(ctx);
          }
        } catch (error) {
          console.error(`[pi-tui-enhancements/thinking 快捷键] 失败：${errorMessage(error)}`);
        }
      },
    });
  };

  return { register };
}
