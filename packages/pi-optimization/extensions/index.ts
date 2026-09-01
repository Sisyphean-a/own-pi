import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function activateFeature(
  name: string,
  load: () => Promise<{ default?: (pi: ExtensionAPI) => void | Promise<void> }>,
  pi: ExtensionAPI,
): Promise<void> {
  try {
    const module = await load();
    const activate = module.default;
    if (typeof activate !== "function") {
      console.error(`[pi-optimization] ${name} 未导出有效入口，已跳过`);
      return;
    }
    await activate(pi);
  } catch (error) {
    // Rule: optional feature failure must not reject the package factory or block
    // the other optimization feature from being registered.
    console.error(`[pi-optimization] ${name} 不可用，已跳过：${errorMessage(error)}`);
  }
}

export default async function piOptimization(pi: ExtensionAPI): Promise<void> {
  await Promise.all([
    activateFeature(
      "fix-nul-redirect",
      () => import("../src/nul-redirect.ts"),
      pi,
    ),
    activateFeature(
      "vision-mcp-auto",
      () => import("../src/vision-mcp-auto.ts"),
      pi,
    ),
    activateFeature(
      "fullscreen-scroll",
      () => import("../src/fullscreen-scroll.ts"),
      pi,
    ),
    activateFeature(
      "auto-extension-update",
      () => import("../src/auto-extension-update.ts"),
      pi,
    ),
  ]);
}
