/**
 * pi-tui-enhancements 的包级组合根。
 *
 * Rule: 显示、面板和上下文三个功能域独立可选加载；任一侧失败只跳过自己，不影响其他侧或 Pi 启动。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { logFailure } from "../src/extension-log.ts";
import { createFeatureLoader } from "../src/optional-feature.ts";

const loader = createFeatureLoader((name, error) => {
  const detail = error instanceof Error ? error.message : String(error);
  logFailure(name, `不可用，已跳过：${detail}`);
});

export default async function piTuiEnhancements(pi: ExtensionAPI): Promise<void> {
  await Promise.all([
    loader.activate("紧凑显示", () => import("../src/display/index.ts"), pi),
    loader.activate("快捷面板", () => import("../src/panel/index.ts"), pi),
    loader.activate("上下文查看", () => import("../src/context/index.ts"), pi),
  ]);
}
