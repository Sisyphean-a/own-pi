/**
 * pi-optimization 的包级组合根。
 *
 * Rule: 五个优化/调度功能独立可选加载；任一功能失败只跳过自己，不影响其他功能或 Pi 启动。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createFeatureLoader } from "../src/optional-feature.ts";

const loader = createFeatureLoader((name, error) => {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`[pi-optimization/${name}] 不可用，已跳过：${detail}`);
});

export default async function piOptimization(pi: ExtensionAPI): Promise<void> {
  await Promise.all([
    loader.activate(
      "fix-nul-redirect",
      () => import("../src/nul-redirect.ts"),
      pi,
    ),
    loader.activate(
      "vision-mcp-auto",
      () => import("../src/vision-mcp-auto.ts"),
      pi,
    ),
    loader.activate(
      "fullscreen-scroll",
      () => import("../src/fullscreen-scroll.ts"),
      pi,
    ),
    loader.activate(
      "auto-extension-update",
      () => import("../src/auto-extension-update.ts"),
      pi,
    ),
    loader.activate(
      "wait",
      () => import("../src/wait.ts"),
      pi,
    ),
  ]);
}
