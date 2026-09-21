/**
 * 百分比窗口与重置时间的共享格式化。
 *
 * Rule: 三个 provider 的百分比校验、重置时间校验和面板展示格式相同，集中在这里；
 * 各适配器只负责把 provider 原始字段归一化成 UsageWindow。
 */

import type { ProviderUsageWindows, UsageFetchOptions, UsageWindow, WindowKind } from "./types.ts";

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** 秒级重置时间的有效性：必须能变成一个真实日期。 */
export function isValidResetAt(resetAt: number): boolean {
  const milliseconds = resetAt * 1000;
  return Number.isFinite(milliseconds) && Number.isFinite(new Date(milliseconds).getTime());
}

/**
 * 归一化 provider 直接给出的剩余百分比。
 *
 * Rule: 缺少 resetAt 时，requireResetAt 为真则整个窗口作废，否则只保留百分比。
 */
export function normalizePercentWindow(
  value: unknown,
  requireResetAt: boolean,
  field: string = "used_percent",
  resetField: string = "reset_at",
): UsageWindow | undefined {
  const window = asRecord(value);
  const usedPercent = window[field];
  const resetAt = window[resetField];
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) return undefined;

  const remainingPercent = Math.round(100 - Math.min(100, Math.max(0, usedPercent)));
  if (typeof resetAt !== "number" || !Number.isFinite(resetAt) || resetAt <= 0 || !isValidResetAt(resetAt)) {
    return requireResetAt ? undefined : { remainingPercent };
  }
  return { remainingPercent, resetAt };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatResetAt(resetAt: number, kind: "time" | "date"): string | undefined {
  if (!isValidResetAt(resetAt)) return undefined;
  const date = new Date(resetAt * 1000);
  return kind === "time"
    ? `${pad(date.getHours())}:${pad(date.getMinutes())}`
    : `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatWindow(window: UsageWindow | undefined, resetKind: "time" | "date"): string | undefined {
  if (!window || window.resetAt === undefined) return undefined;
  const reset = formatResetAt(window.resetAt, resetKind);
  return reset === undefined ? undefined : `[ ${window.remainingPercent}%  ${reset} ]`;
}

/** 每个窗口的展示时机：5 小时显示时钟，周与月显示日期。 */
const DETAIL_RESET_KIND: Record<WindowKind, "time" | "date"> = {
  fiveHour: "time",
  weekly: "date",
  monthly: "date",
};

/** 面板详细格式：`label [ 50%  19:23 ] [ 78%  08-26 ]`；没有任何可展示窗口时返回空串。 */
export function formatUsageDetail(label: string, windows: ProviderUsageWindows): string {
  const parts = (Object.keys(DETAIL_RESET_KIND) as WindowKind[])
    .map((kind) => formatWindow(windows[kind], DETAIL_RESET_KIND[kind]))
    .filter((part): part is string => part !== undefined);
  return parts.length > 0 ? `${label} ${parts.join(" ")}` : "";
}

/** footer 紧凑格式：`label [70%|55%]`；缺失窗口直接跳过。 */
export function formatUsageCompact(label: string, windows: ProviderUsageWindows): string {
  const values = (["fiveHour", "weekly", "monthly"] as WindowKind[])
    .map((kind) => windows[kind] === undefined ? undefined : `${windows[kind]!.remainingPercent}%`)
    .filter((value): value is string => value !== undefined);
  return `${label} [${values.join("|")}]`;
}

/**
 * 面板需要适配器声明为必需的窗口，footer 允许部分窗口。
 *
 * Rule: 必需窗口集合由适配器声明（codex 两窗口，opencode-go / command-code 三窗口）；
 * allowPartial 为假时缺一个即整体作废。
 */
export function hasUsableWindows(
  windows: ProviderUsageWindows,
  options: UsageFetchOptions,
  requiredKinds: readonly WindowKind[],
): boolean {
  const kinds = Object.keys(windows) as WindowKind[];
  if (kinds.length === 0) return false;
  if (!options.allowPartial && requiredKinds.some((kind) => windows[kind] === undefined)) return false;
  return true;
}
