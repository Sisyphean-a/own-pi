/**
 * 额度 provider 描述符与窗口类型：三个适配器共享的结构定义。
 *
 * Rule: 窗口形状用稳定的种类描述，具体字段名（fiveHour 等）和百分比语义由 provider-usage.ts 映射；
 * 适配器只声明自己有哪些窗口，消费方不重复判断 provider。
 */

export const CODEX_PROVIDER_ID = "openai-codex";
export const OPENCODE_GO_PROVIDER_ID = "opencode-go";
export const COMMANDCODE_PROVIDER_ID = "commandcode";
export const TUI_PROVIDER_USAGE_STATUS_ID = "tui-provider-usage";

export type WindowKind = "fiveHour" | "weekly" | "monthly";

export type UsageWindow = {
  /** 剩余百分比，0-100 的整数。 */
  remainingPercent: number;
  /** 秒级时间戳；provider 未提供时省略。 */
  resetAt?: number;
};

/**
 * 一个 provider 的额度快照，比该 provider 的固定窗口集合更宽：
 * 缺失的窗口省略，但未声明的窗口不会出现。
 */
export type ProviderUsageWindows = Partial<Record<WindowKind, UsageWindow>>;

export type UsageAuth = { ok: true; apiKey: string } | { ok: false };

export type UsageFetchOptions = {
  allowPartial?: boolean;
  requireResetAt?: boolean;
};
