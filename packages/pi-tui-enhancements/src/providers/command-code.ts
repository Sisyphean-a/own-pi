/**
 * Command Code 官方 API key 额度适配器。
 *
 * Flow: 先用 credits 接口取 5 小时/周窗口，再 best-effort 取订阅套餐推断月度窗口；
 * 订阅失败时仍返回已拿到的窗口。
 * Rule: provider 名称可能是 commandcode / command-code / cmdc，按名称特征路由而不是固定 id；
 * 月度额度来自订阅套餐表，未知套餐不猜测额度，只省略月窗口。
 */

import type { ProviderParseContext, ProviderAdapter } from "./adapter.ts";
import { fetchJsonBestEffort, resolveApiKeyAuth } from "./fetch.ts";
import { asRecord, hasUsableWindows, isValidResetAt } from "./format.ts";
import {
  COMMANDCODE_PROVIDER_ID,
  type ProviderUsageWindows,
  type UsageFetchOptions,
  type UsageWindow,
} from "./types.ts";

const COMMANDCODE_CREDITS_URL = "https://api.commandcode.ai/alpha/billing/credits";
const COMMANDCODE_SUBSCRIPTIONS_URL = "https://api.commandcode.ai/alpha/billing/subscriptions";

const COMMANDCODE_PROVIDER_PATTERN = /command[-_ ]?code|\bcmdc\b/i;

// Rule: 月度额度是订阅套餐总额度，官方 CLI 也用同一张硬编码表；新增套餐只改这里。
const COMMANDCODE_PLAN_CREDITS: Record<string, number> = {
  "individual-go": 10,
  "individual-goat": 70,
  "individual-pro": 30,
  "individual-pro-v1": 80,
  "individual-provider": 15,
  "individual-max": 150,
  "individual-ultra": 300,
  "teams-pro": 40,
};
const COMMANDCODE_PLAN_KEYS = Object.keys(COMMANDCODE_PLAN_CREDITS).sort((a, b) => b.length - a.length);

export function isCommandCodeProvider(provider: unknown): boolean {
  return typeof provider === "string" && COMMANDCODE_PROVIDER_PATTERN.test(provider.trim());
}

/** 订阅 planId 可能是 individual-goat-v2 这类带后缀的形式，按最长前缀匹配。 */
function getPlanTotal(planId: unknown): number | undefined {
  if (typeof planId !== "string" || planId.length === 0) return undefined;
  const normalized = planId.toLowerCase().replace(/_/g, "-");
  const key = COMMANDCODE_PLAN_KEYS.find((candidate) => normalized.startsWith(candidate));
  return key === undefined ? undefined : COMMANDCODE_PLAN_CREDITS[key];
}

/** credits 的 used/cap 是额度数值而不是百分比；resetAt 是毫秒时间戳。 */
function getWindow(value: unknown, requireResetAt: boolean): UsageWindow | undefined {
  const window = asRecord(value);
  const used = window.used;
  const cap = window.cap;
  if (typeof used !== "number" || !Number.isFinite(used)) return undefined;
  if (typeof cap !== "number" || !Number.isFinite(cap) || cap <= 0) return undefined;

  const remainingPercent = Math.round(100 - Math.min(100, Math.max(0, used / cap * 100)));
  const resetAtMs = window.resetAt;
  if (typeof resetAtMs !== "number" || !Number.isFinite(resetAtMs) || resetAtMs <= 0) {
    return requireResetAt ? undefined : { remainingPercent };
  }
  const resetAt = resetAtMs / 1000;
  if (!isValidResetAt(resetAt)) return requireResetAt ? undefined : { remainingPercent };
  return { remainingPercent, resetAt };
}

function getMonthlyWindow(options: {
  credits: Record<string, unknown>;
  planId: unknown;
  periodEnd: unknown;
  requireResetAt: boolean;
}): UsageWindow | undefined {
  const cap = getPlanTotal(options.planId);
  const remaining = options.credits.monthlyCredits;
  if (cap === undefined || cap <= 0) return undefined;
  if (typeof remaining !== "number" || !Number.isFinite(remaining)) return undefined;

  const remainingPercent = Math.round(Math.min(100, Math.max(0, remaining / cap * 100)));
  if (typeof options.periodEnd !== "string" || options.periodEnd.length === 0) {
    return options.requireResetAt ? undefined : { remainingPercent };
  }
  const resetAt = Date.parse(options.periodEnd) / 1000;
  if (!Number.isFinite(resetAt) || resetAt <= 0 || !isValidResetAt(resetAt)) {
    return options.requireResetAt ? undefined : { remainingPercent };
  }
  return { remainingPercent, resetAt };
}

function parseCommandCodeWindows(
  creditsPayload: unknown,
  subscriptionPayload: unknown,
  options: UsageFetchOptions,
): ProviderUsageWindows | undefined {
  const envelope = asRecord(creditsPayload);
  const limits = asRecord(envelope.windowLimits);
  const subscription = asRecord(asRecord(subscriptionPayload).data);
  const requireResetAt = options.requireResetAt !== false;

  const windows: ProviderUsageWindows = {
    fiveHour: getWindow(limits.fiveHour, requireResetAt),
    weekly: getWindow(limits.weekly, requireResetAt),
    // Guarantee: 月度窗口依赖套餐表，缺失时不影响 5 小时/周窗口的展示。
    monthly: getMonthlyWindow({
      credits: asRecord(envelope.credits),
      planId: subscription.planId,
      periodEnd: subscription.currentPeriodEnd,
      requireResetAt,
    }),
  };
  return hasUsableWindows(windows, options, ["fiveHour", "weekly"]) ? windows : undefined;
}

export const commandCodeAdapter: ProviderAdapter = {
  id: COMMANDCODE_PROVIDER_ID,
  matches: isCommandCodeProvider,
  async resolveAuth(ctx, model) {
    return resolveApiKeyAuth(ctx, model);
  },
  buildRequest: (apiKey) => ({
    url: COMMANDCODE_CREDITS_URL,
    headers: { Authorization: `Bearer ${apiKey}` },
  }),
  async parse({ payload, auth, options, signal }: ProviderParseContext) {
    const subscriptionPayload = await fetchJsonBestEffort(COMMANDCODE_SUBSCRIPTIONS_URL, {
      headers: { Authorization: `Bearer ${auth.apiKey}` },
      signal,
    });
    return parseCommandCodeWindows(payload, subscriptionPayload, options);
  },
};
