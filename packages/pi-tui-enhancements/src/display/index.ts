import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { logFailure } from "../extension-log.ts";
import { createFeatureLoader, errorMessage } from "../optional-feature.ts";
import { createDisplaySession } from "./session.ts";

// Rule: 可选 peer、原型 API 和包内模块随时可能消失；登记过的失败在这里统一转成“隐藏该功能”的日志。
const loader = createFeatureLoader((name, error) => {
  logFailure(name, `不可用，已隐藏相关功能：${errorMessage(error)}`);
});

function installToolRendering(toolRendering: typeof import("./tool-rendering.ts") | undefined): void {
  if (!toolRendering) return;
  try {
    toolRendering.installContainerParentTracking();
  } catch (error) {
    logFailure("工具容器分组", `不可用，已隐藏相关功能：${errorMessage(error)}`);
  }
  try {
    toolRendering.installToolRenderers();
  } catch (error) {
    logFailure("工具紧凑渲染", `不可用，已隐藏相关功能：${errorMessage(error)}`);
  }
}

function installMessageDisplay(messageDisplay: typeof import("./message-display.ts") | undefined): boolean {
  if (!messageDisplay) return false;
  try {
    messageDisplay.installCompactUserMessage();
  } catch (error) {
    logFailure("用户消息紧凑渲染", `不可用，已隐藏相关功能：${errorMessage(error)}`);
  }
  try {
    messageDisplay.installThinkingCollapse();
    return true;
  } catch (error) {
    logFailure("思考折叠", `不可用，已隐藏相关功能：${errorMessage(error)}`);
    return false;
  }
}

function createUsageController(
  usageModule: typeof import("../provider-usage.ts") | undefined,
): ReturnType<typeof import("../provider-usage.ts").createProviderUsageController> | undefined {
  if (!usageModule) return undefined;
  // The controller constructor is local and should not be allowed to affect
  // display registration. Keep this small boundary explicit for old runtimes.
  try {
    return usageModule.createProviderUsageController();
  } catch (error) {
    logFailure("provider usage controller", `不可用：${errorMessage(error)}`);
    return undefined;
  }
}

export default async function displayEnhancements(pi: ExtensionAPI): Promise<void> {
  const [messageDisplay, toolRendering, usageModule, compactFooter] = await Promise.all([
    loader.import("消息/思考显示", () => import("./message-display.ts")),
    loader.import("工具显示", () => import("./tool-rendering.ts")),
    loader.import("provider usage", () => import("../provider-usage.ts")),
    loader.import("紧凑页脚", async () => {
      const [footer, tui] = await Promise.all([
        import("./compact-footer.ts"),
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

  installToolRendering(toolRendering);
  const thinkingAvailable = installMessageDisplay(messageDisplay);
  const usageController = createUsageController(usageModule);

  createDisplaySession({
    messageDisplay,
    compactFooter,
    usageController,
    thinkingAvailable,
  }).register(pi);
}
