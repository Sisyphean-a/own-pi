import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default async function (pi: ExtensionAPI): Promise<void> {
  try {
    if (typeof pi.on !== "function" || typeof pi.registerCommand !== "function") return;
    const { register } = await import("../src/index.ts");
    register(pi);
  } catch {
    // Failure: 缺少可选宿主能力时不阻断其他扩展；入口不启动资源。
  }
}
