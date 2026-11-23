import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Keep the advisor feature optional: if the Pi runtime or one of its peer
 * packages is unavailable, loading this package must not block other extensions.
 */
export default async function piAdvisor(pi: ExtensionAPI): Promise<void> {
  try {
    const module = await import("../src/advisor.ts");
    if (typeof module.default !== "function") {
      console.error("[pi-advisor] 未导出有效入口，已跳过");
      return;
    }
    await module.default(pi);
  } catch (error) {
    console.error(`[pi-advisor] 不可用，已跳过：${errorMessage(error)}`);
  }
}
