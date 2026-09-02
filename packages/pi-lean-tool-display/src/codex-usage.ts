import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const CODEX_PROVIDER_ID = "openai-codex";
export const OPENCODE_GO_PROVIDER_ID = "opencode-go";
const CODEX_USAGE_STATUS_ID = "lean-codex-usage";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const CODEX_USAGE_REFRESH_MS = 5 * 60 * 1000;
const CODEX_USAGE_TIMEOUT_MS = 10_000;

type CodexUsageController = {
  clear(ctx: ExtensionContext): void;
  refresh(ctx: ExtensionContext): Promise<void>;
};

type ProviderUsageValues = {
  fiveHour?: number;
  weekly?: number;
  monthly?: number;
};

type ProviderUsage = {
  provider: typeof CODEX_PROVIDER_ID | typeof OPENCODE_GO_PROVIDER_ID;
  usage: ProviderUsageValues;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function getHeader(headers: Record<string, string>, name: string): string | undefined {
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry?.[1];
}

// Guarantee: 不抛错。stale ctx 的任何属性访问都会抛 assertActive 错误，
// 这里用轻量 getter 探测当前 ctx 是否仍有效。
function isCtxActive(ctx: ExtensionContext): boolean {
  try {
    void ctx.mode;
    return true;
  } catch {
    return false;
  }
}

function getWindowRemainingPercent(value: unknown): number | undefined {
  const usedPercent = asRecord(value).used_percent;
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) return undefined;
  return Math.round(100 - Math.min(100, Math.max(0, usedPercent)));
}

function getCodexUsage(payload: unknown): ProviderUsageValues | undefined {
  const rateLimit = asRecord(asRecord(payload).rate_limit);
  const usage: ProviderUsageValues = {
    fiveHour: getWindowRemainingPercent(rateLimit.primary_window),
    weekly: getWindowRemainingPercent(rateLimit.secondary_window),
  };
  return usage.fiveHour === undefined && usage.weekly === undefined ? undefined : usage;
}

function getOpenCodeGoUsage(payload: unknown): ProviderUsageValues | undefined {
  const usagePayload = asRecord(asRecord(payload).usage);
  const getPercent = (value: unknown): number | undefined => {
    const percent = asRecord(value).percent;
    if (typeof percent !== "number" || !Number.isFinite(percent)) return undefined;
    return Math.round(100 - Math.min(100, Math.max(0, percent)));
  };
  const usage: ProviderUsageValues = {
    fiveHour: getPercent(usagePayload.rolling),
    weekly: getPercent(usagePayload.weekly),
    monthly: getPercent(usagePayload.monthly),
  };
  return usage.fiveHour === undefined && usage.weekly === undefined && usage.monthly === undefined
    ? undefined
    : usage;
}

function isUsageProvider(provider: unknown): provider is ProviderUsage["provider"] {
  return provider === CODEX_PROVIDER_ID || provider === OPENCODE_GO_PROVIDER_ID;
}

function formatProviderUsage(value: ProviderUsage): string {
  const windows: string[] = [];
  if (value.usage.fiveHour !== undefined) windows.push(`${value.usage.fiveHour}%`);
  if (value.usage.weekly !== undefined) windows.push(`${value.usage.weekly}%`);
  if (value.usage.monthly !== undefined) windows.push(`${value.usage.monthly}%`);
  const label = value.provider === CODEX_PROVIDER_ID ? "codex" : "opencode-go";
  return `${label} [${windows.join("|")}]`;
}

async function fetchCodexUsage(ctx: ExtensionContext): Promise<ProviderUsageValues | undefined> {
  if (ctx.model?.provider !== CODEX_PROVIDER_ID) return undefined;

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
  if (!auth.ok) return undefined;

  const headers = { ...(auth.headers ?? {}) } as Record<string, string>;
  if (!getHeader(headers, "Authorization") && auth.apiKey) {
    headers.Authorization = `Bearer ${auth.apiKey}`;
  }
  if (!getHeader(headers, "Authorization")) return undefined;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CODEX_USAGE_TIMEOUT_MS);
  try {
    const response = await fetch(CODEX_USAGE_URL, { headers, signal: controller.signal, redirect: "error" });
    if (!response.ok) return undefined;
    return getCodexUsage(await response.json());
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchOpenCodeGoUsage(ctx: ExtensionContext): Promise<ProviderUsageValues | undefined> {
  if (ctx.model?.provider !== OPENCODE_GO_PROVIDER_ID) return undefined;

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
  if (!auth.ok) return undefined;

  const headers = { ...(auth.headers ?? {}) } as Record<string, string>;
  const authorization = auth.apiKey
    ? `Bearer ${auth.apiKey}`
    : getHeader(headers, "Authorization");
  if (!authorization) return undefined;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CODEX_USAGE_TIMEOUT_MS);
  try {
    const response = await fetch(OPENCODE_GO_USAGE_URL, {
      headers: { Authorization: authorization },
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok) return undefined;
    return getOpenCodeGoUsage(await response.json());
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchProviderUsage(ctx: ExtensionContext): Promise<ProviderUsage | undefined> {
  const provider = ctx.model?.provider;
  if (provider === CODEX_PROVIDER_ID) {
    const usage = await fetchCodexUsage(ctx);
    return usage ? { provider, usage } : undefined;
  }
  if (provider === OPENCODE_GO_PROVIDER_ID) {
    const usage = await fetchOpenCodeGoUsage(ctx);
    return usage ? { provider, usage } : undefined;
  }
  return undefined;
}

export function createCodexUsageController(): CodexUsageController {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let requestId = 0;

  // Flow: 先失效本地状态（requestId/timer），再 best-effort 清理 UI。
  // 会话替换或 reload 后 ctx 已失效，UI 调用可能抛错，不能影响停止轮询。
  const stop = (): void => {
    requestId++;
    if (timer) clearTimeout(timer);
    timer = undefined;
  };

  const scheduleRefresh = (ctx: ExtensionContext, request: number): void => {
    try {
      if (request !== requestId || !isCtxActive(ctx) || !isUsageProvider(ctx.model?.provider)) return;
      timer = setTimeout(() => {
        timer = undefined;
        void refresh(ctx);
      }, CODEX_USAGE_REFRESH_MS);
    } catch {
      // Guarantee: stale context cannot turn finalization into an unhandled rejection.
      stop();
    }
  };

  const clear = (ctx: ExtensionContext): void => {
    stop();
    try {
      ctx.ui.setStatus(CODEX_USAGE_STATUS_ID, undefined);
    } catch {
      // ctx 已失效，忽略 UI 清理。
    }
  };

  // Rule: 定时器回调里的 promise rejection 会变成 uncaughtException 把 pi 带崩，
  // 因此 refresh 绝不向上抛错；ctx 失效时永久停止轮询，其他瞬时错误下轮重试。
  const refresh = async (ctx: ExtensionContext): Promise<void> => {
    // Rule: a manual refresh/model change replaces the pending timer, preventing duplicate polling.
    if (timer) clearTimeout(timer);
    timer = undefined;
    const request = ++requestId;
    try {
      const provider = ctx.model?.provider;
      if (!isUsageProvider(provider)) {
        clear(ctx);
        return;
      }

      const usage = await fetchProviderUsage(ctx);
      if (request !== requestId || ctx.model?.provider !== provider) return;
      const value = usage === undefined
        ? undefined
        : ctx.ui.theme.fg("dim", formatProviderUsage(usage));
      ctx.ui.setStatus(CODEX_USAGE_STATUS_ID, value);
    } catch {
      // Failure: ctx 失效（stale）时永久停止；网络等瞬时错误清空状态后由 finally 重排重试。
      if (!isCtxActive(ctx)) {
        stop();
        return;
      }
      if (request === requestId) {
        try {
          ctx.ui.setStatus(CODEX_USAGE_STATUS_ID, undefined);
        } catch {
          // 忽略 UI 清理失败。
        }
      }
    } finally {
      scheduleRefresh(ctx, request);
    }
  };

  return { clear, refresh };
}
