import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type ThemeLike = {
  bold(text: string): string;
  fg(color: string, text: string): string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function loadOptional<T>(name: string, load: () => Promise<T>): Promise<T | undefined> {
  try {
    return await load();
  } catch (error) {
    // Rule: optional peer packages and prototype APIs may disappear without
    // preventing Pi or the other independent display features from loading.
    console.error(`[pi-lean-tool-display] ${name} 不可用，已隐藏相关功能：${errorMessage(error)}`);
    return undefined;
  }
}

function runOptional(name: string, effect: () => void): boolean {
  try {
    effect();
    return true;
  } catch (error) {
    console.error(`[pi-lean-tool-display] ${name} 不可用，已隐藏相关功能：${errorMessage(error)}`);
    return false;
  }
}

function hasUiMethod<T extends keyof ExtensionContext["ui"]>(ctx: ExtensionContext, method: T): boolean {
  try {
    return Boolean(ctx.hasUI && typeof ctx.ui?.[method] === "function");
  } catch {
    return false;
  }
}

async function refreshUsage(controller: { refresh(ctx: ExtensionContext): Promise<void> }, ctx: ExtensionContext): Promise<void> {
  try {
    await controller.refresh(ctx);
  } catch (error) {
    console.error(`[pi-lean-tool-display] Codex usage 刷新失败：${errorMessage(error)}`);
  }
}

function clearUsage(controller: { clear(ctx: ExtensionContext): void }, ctx: ExtensionContext): void {
  try {
    controller.clear(ctx);
  } catch (error) {
    console.error(`[pi-lean-tool-display] Codex usage 清理失败：${errorMessage(error)}`);
  }
}

type IntervalClock = {
  setInterval(callback: () => void, delayMs: number): ReturnType<typeof setInterval>;
  clearInterval(timer: ReturnType<typeof setInterval>): void;
};

const THINKING_FRAME_INTERVAL_MS = 125;
const THINKING_FRAME_COUNT = 8;

export function createThinkingIndicator(clock: IntervalClock = {
  setInterval: (callback, delayMs) => setInterval(callback, delayMs),
  clearInterval: (timer) => clearInterval(timer),
}) {
  let active = false;
  let frameIndex = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of listeners) listener();
  };
  const stopTimer = () => {
    if (timer === undefined) return;
    clock.clearInterval(timer);
    timer = undefined;
  };

  return {
    isActive: () => active,
    getFrameIndex: () => frameIndex,
    onChange(callback: () => void) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    setActive(next: boolean) {
      if (active === next) return;
      active = next;
      frameIndex = 0;
      stopTimer();
      if (active) {
        timer = clock.setInterval(() => {
          frameIndex = (frameIndex + 1) % THINKING_FRAME_COUNT;
          notify();
        }, THINKING_FRAME_INTERVAL_MS);
      }
      notify();
    },
  };
}

export default async function leanToolDisplay(pi: ExtensionAPI): Promise<void> {
  const [messageDisplay, toolRendering, codexUsageModule, compactFooter] = await Promise.all([
    loadOptional("消息/思考显示", () => import("../src/message-display.ts")),
    loadOptional("工具显示", () => import("../src/tool-rendering.ts")),
    loadOptional("Codex usage", () => import("../src/codex-usage.ts")),
    loadOptional("紧凑页脚", async () => {
      const [footer, tui] = await Promise.all([
        import("../src/compact-footer.ts"),
        import("@earendil-works/pi-tui"),
      ]);
      return {
        create: footer.createCompactFooter,
        widthUtils: {
          visibleWidth: tui.visibleWidth,
          truncateToWidth: tui.truncateToWidth,
        },
      };
    }),
  ]);

  if (toolRendering) {
    runOptional("工具容器分组", toolRendering.installContainerParentTracking);
    runOptional("工具紧凑渲染", toolRendering.installToolRenderers);
  }

  let thinkingAvailable = false;
  if (messageDisplay) {
    runOptional("用户消息紧凑渲染", messageDisplay.installCompactUserMessage);
    thinkingAvailable = runOptional("思考折叠", messageDisplay.installThinkingCollapse);
  }

  let codexUsage: { clear(ctx: ExtensionContext): void; refresh(ctx: ExtensionContext): Promise<void> } | undefined;
  const thinkingIndicator = createThinkingIndicator();

  // The controller constructor is local and should not be allowed to affect
  // display registration. Keep this small boundary explicit for old runtimes.
  if (codexUsageModule) {
    try {
      codexUsage = codexUsageModule.createCodexUsageController();
    } catch (error) {
      console.error(`[pi-lean-tool-display] Codex usage controller 不可用：${errorMessage(error)}`);
      codexUsage = undefined;
    }
  }

  if (typeof pi.on === "function") {
    pi.on("session_start", (_event, ctx) => {
      try {
        if (ctx.hasUI && ctx.ui?.theme) {
          (globalThis as { __piLeanTheme?: ThemeLike }).__piLeanTheme = ctx.ui.theme as unknown as ThemeLike;
          if (thinkingAvailable && hasUiMethod(ctx, "setHiddenThinkingLabel")) {
            ctx.ui.setHiddenThinkingLabel(messageDisplay!.getThinkingLabel(messageDisplay!.getThinkingState().collapsed));
          }
          if (compactFooter && hasUiMethod(ctx, "setFooter")) {
            const footerInstalled = runOptional("紧凑页脚", () => {
              ctx.ui.setFooter((tui, theme, footerData) =>
                compactFooter.create(
                  ctx,
                  tui,
                  theme,
                  footerData,
                  compactFooter.widthUtils,
                  thinkingIndicator,
                ));
            });
            if (footerInstalled && hasUiMethod(ctx, "setWorkingVisible")) {
              runOptional("内置工作指示器", () => ctx.ui.setWorkingVisible(false));
            }
          }
        }
      } catch (error) {
        console.error(`[pi-lean-tool-display] 会话显示初始化失败：${errorMessage(error)}`);
      }
      if (codexUsage) void refreshUsage(codexUsage, ctx);
    });

    if (codexUsage) {
      pi.on("model_select", (event, ctx) => {
        try {
          if (event.model.provider === "openai-codex") {
            void refreshUsage(codexUsage!, ctx);
          } else {
            clearUsage(codexUsage!, ctx);
          }
        } catch (error) {
          console.error(`[pi-lean-tool-display] 模型切换处理失败：${errorMessage(error)}`);
        }
      });
    }

    pi.on("turn_start", () => thinkingIndicator.setActive(true));
    pi.on("tool_execution_start", () => thinkingIndicator.setActive(false));
    pi.on("turn_end", () => thinkingIndicator.setActive(false));
    pi.on("agent_settled", () => thinkingIndicator.setActive(false));
    pi.on("session_shutdown", (_event, ctx) => {
      thinkingIndicator.setActive(false);
      if (codexUsage) clearUsage(codexUsage, ctx);
    });

    if (messageDisplay) {
      pi.on("message_update", (event, ctx) => {
        try {
          if (!ctx.hasUI || !ctx.ui?.theme) return;
          if (messageDisplay.isAssistantMessage(event.message)) {
            messageDisplay.labelThinking(event.message, ctx.ui.theme as unknown as ThemeLike);
          }
        } catch (error) {
          console.error(`[pi-lean-tool-display] 思考内容标记失败：${errorMessage(error)}`);
        }
      });

      pi.on("message_end", (event, ctx) => {
        try {
          if (!ctx.hasUI || !ctx.ui?.theme) return;
          if (messageDisplay.isAssistantMessage(event.message)) {
            messageDisplay.labelThinking(event.message, ctx.ui.theme as unknown as ThemeLike);
          }
        } catch (error) {
          console.error(`[pi-lean-tool-display] 思考内容标记失败：${errorMessage(error)}`);
        }
      });

      pi.on("context", (event) => {
        try {
          event.messages.splice(0, event.messages.length, ...messageDisplay.sanitizeThinking(event.messages));
        } catch (error) {
          console.error(`[pi-lean-tool-display] 思考内容清理失败：${errorMessage(error)}`);
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
          messageDisplay!.setThinkingCollapsed(ctx, !messageDisplay!.getThinkingState().collapsed);
        }
      } catch (error) {
        console.error(`[pi-lean-tool-display] thinking 快捷键失败：${errorMessage(error)}`);
      }
    },
  });
}
