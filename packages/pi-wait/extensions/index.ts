import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default async function piWait(pi: ExtensionAPI): Promise<void> {
  try {
    const { activateWaitExtension } = await import("../src/wait.ts");
    activateWaitExtension(pi);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[pi-wait] 插件不可用，已跳过：${message}`);
  }
}
