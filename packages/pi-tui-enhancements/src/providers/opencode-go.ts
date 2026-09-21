/**
 * OpenCode Go 官方 API key 额度适配器。
 *
 * Flow: `/zen/go/v1/usage` 一次请求，响应给 5 小时、周、月三个窗口的剩余百分比。
 * Rule: 重置时间是 ISO 字符串；缺少或无法解析时，requireResetAt 为真则整个窗口作废。
 */

import type { ProviderAdapter } from "./adapter.ts";
import { resolveApiKeyAuth } from "./fetch.ts";
import { asRecord, hasUsableWindows, isValidResetAt } from "./format.ts";
import {
  OPENCODE_GO_PROVIDER_ID,
  type ProviderUsageWindows,
  type UsageFetchOptions,
  type UsageWindow,
} from "./types.ts";

const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";

/** 响应里 percent 是已用百分比；resetsAt 是 ISO 字符串。 */
function getWindow(value: unknown, requireResetAt: boolean): UsageWindow | undefined {
  const window = asRecord(value);
  const percent = window.percent;
  if (typeof percent !== "number" || !Number.isFinite(percent)) return undefined;

  const remainingPercent = Math.round(100 - Math.min(100, Math.max(0, percent)));
  const resetsAt = window.resetsAt;
  if (typeof resetsAt !== "string" || resetsAt.length === 0) {
    return requireResetAt ? undefined : { remainingPercent };
  }

  const resetAt = Date.parse(resetsAt) / 1000;
  if (!Number.isFinite(resetAt) || resetAt <= 0 || !isValidResetAt(resetAt)) {
    return requireResetAt ? undefined : { remainingPercent };
  }
  return { remainingPercent, resetAt };
}

function parse(payload: unknown, options: UsageFetchOptions): ProviderUsageWindows | undefined {
  const usage = asRecord(asRecord(payload).usage);
  const requireResetAt = options.requireResetAt !== false;
  const windows: ProviderUsageWindows = {
    fiveHour: getWindow(usage.rolling, requireResetAt),
    weekly: getWindow(usage.weekly, requireResetAt),
    monthly: getWindow(usage.monthly, requireResetAt),
  };
  return hasUsableWindows(windows, options, ["fiveHour", "weekly", "monthly"]) ? windows : undefined;
}

export const openCodeGoAdapter: ProviderAdapter = {
  id: OPENCODE_GO_PROVIDER_ID,
  matches: (provider) => provider === OPENCODE_GO_PROVIDER_ID,
  async resolveAuth(ctx, model) {
    // 只认官方 API key，没有 OAuth 前置条件。
    return resolveApiKeyAuth(ctx, model);
  },
  buildRequest: (apiKey) => ({
    url: OPENCODE_GO_USAGE_URL,
    headers: { Authorization: `Bearer ${apiKey}` },
  }),
  async parse({ payload, options }) {
    return parse(payload, options);
  },
};
