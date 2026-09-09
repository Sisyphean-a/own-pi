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
      console.error(`[pi-tui-enhancements] ${name} 未导出有效入口，已跳过`);
      return;
    }
    await activate(pi);
  } catch (error) {
    // Rule: display and panel have independent optional runtime seams; one
    // feature must not prevent the other from loading.
    console.error(`[pi-tui-enhancements] ${name} 不可用，已跳过：${errorMessage(error)}`);
  }
}

export default async function piTuiEnhancements(pi: ExtensionAPI): Promise<void> {
  await Promise.all([
    activateFeature("紧凑显示", () => import("../src/display/index.ts"), pi),
    activateFeature("快捷面板", () => import("../src/panel/index.ts"), pi),
  ]);
}
