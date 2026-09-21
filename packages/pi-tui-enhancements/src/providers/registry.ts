/**
 * 额度 provider 注册表。
 *
 * Rule: 新增 provider 只需在这里加一个适配器；顺序决定路由优先级，当前三者互不重叠。
 */

import { commandCodeAdapter } from "./command-code.ts";
import { codexAdapter } from "./codex.ts";
import { openCodeGoAdapter } from "./opencode-go.ts";
import type { ProviderAdapter } from "./adapter.ts";

export const PROVIDER_ADAPTERS: readonly ProviderAdapter[] = [
  codexAdapter,
  openCodeGoAdapter,
  commandCodeAdapter,
];

export function findProviderAdapter(provider: unknown): ProviderAdapter | undefined {
  return PROVIDER_ADAPTERS.find((adapter) => adapter.matches(provider));
}
