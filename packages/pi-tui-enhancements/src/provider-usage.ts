import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const CODEX_PROVIDER_ID = "openai-codex";
export const OPENCODE_GO_PROVIDER_ID = "opencode-go";
export const TUI_PROVIDER_USAGE_STATUS_ID = "tui-provider-usage";

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const CODEX_USAGE_REFRESH_MS = 5 * 60 * 1000;
const CODEX_USAGE_TIMEOUT_MS = 10_000;
const CODEX_AUTH_CLAIM = "https://api.openai.com/auth";

type JsonObject = Record<string, unknown>;

export type CodexUsageWindow = {
  remainingPercent: number;
  resetAt?: number;
};

// Compact footer usage can render a partial response while the detailed panel
// only displays a response when all provider windows are present.
export type CodexUsage = {
  fiveHour?: CodexUsageWindow;
  weekly?: CodexUsageWindow;
};

export type OpenCodeGoUsage = {
  fiveHour?: CodexUsageWindow;
  weekly?: CodexUsageWindow;
  monthly?: CodexUsageWindow;
};

export type ProviderUsage =
  | { provider: typeof CODEX_PROVIDER_ID; usage: CodexUsage }
  | { provider: typeof OPENCODE_GO_PROVIDER_ID; usage: OpenCodeGoUsage };

export type ProviderUsageController = {
  clear(ctx: ExtensionContext): void;
  refresh(ctx: ExtensionContext): Promise<void>;
};

export type ProviderUsageFetchOptions = {
  allowPartial?: boolean;
  requireResetAt?: boolean;
};

function asRecord(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function decodeBase64Url(value: string): string | undefined {
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    return atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  } catch {
    return undefined;
  }
}

function getCodexAccountId(accessToken: string): string | undefined {
  const parts = accessToken.split(".");
  if (parts.length !== 3) return undefined;
  const payloadPart = parts[1];
  if (!payloadPart) return undefined;

  const decoded = decodeBase64Url(payloadPart);
  if (!decoded) return undefined;

  try {
    const payload = asRecord(JSON.parse(decoded));
    const auth = asRecord(payload[CODEX_AUTH_CLAIM]);
    return typeof auth.chatgpt_account_id === "string" && auth.chatgpt_account_id.length > 0
      ? auth.chatgpt_account_id
      : undefined;
  } catch {
    return undefined;
  }
}

function isValidResetAt(resetAt: number): boolean {
  const milliseconds = resetAt * 1000;
  return Number.isFinite(milliseconds) && Number.isFinite(new Date(milliseconds).getTime());
}

function getWindow(value: unknown, requireResetAt: boolean): CodexUsageWindow | undefined {
  const window = asRecord(value);
  const usedPercent = window.used_percent;
  const resetAt = window.reset_at;
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) return undefined;
  if (typeof resetAt !== "number" || !Number.isFinite(resetAt) || resetAt <= 0 || !isValidResetAt(resetAt)) {
    if (requireResetAt) return undefined;
    return {
      remainingPercent: Math.round(100 - Math.min(100, Math.max(0, usedPercent))),
    };
  }

  return {
    remainingPercent: Math.round(100 - Math.min(100, Math.max(0, usedPercent))),
    resetAt,
  };
}

function parseCodexUsage(payload: unknown, options: ProviderUsageFetchOptions): CodexUsage | undefined {
  const rateLimit = asRecord(asRecord(payload).rate_limit);
  const fiveHour = getWindow(rateLimit.primary_window, options.requireResetAt !== false);
  const weekly = getWindow(rateLimit.secondary_window, options.requireResetAt !== false);
  if (!options.allowPartial && (!fiveHour || !weekly)) return undefined;
  if (!fiveHour && !weekly) return undefined;
  return { fiveHour, weekly };
}

function getOpenCodeGoWindow(value: unknown, requireResetAt: boolean): CodexUsageWindow | undefined {
  const window = asRecord(value);
  const percent = window.percent;
  const resetsAt = window.resetsAt;
  if (typeof percent !== "number" || !Number.isFinite(percent)) return undefined;
  if (typeof resetsAt !== "string" || resetsAt.length === 0) {
    if (requireResetAt) return undefined;
    return {
      remainingPercent: Math.round(100 - Math.min(100, Math.max(0, percent))),
    };
  }

  const resetAt = Date.parse(resetsAt) / 1000;
  if (!Number.isFinite(resetAt) || resetAt <= 0 || !isValidResetAt(resetAt)) {
    if (requireResetAt) return undefined;
    return {
      remainingPercent: Math.round(100 - Math.min(100, Math.max(0, percent))),
    };
  }

  return {
    remainingPercent: Math.round(100 - Math.min(100, Math.max(0, percent))),
    resetAt,
  };
}

function parseOpenCodeGoUsage(payload: unknown, options: ProviderUsageFetchOptions): OpenCodeGoUsage | undefined {
  const usage = asRecord(asRecord(payload).usage);
  const requireResetAt = options.requireResetAt !== false;
  const fiveHour = getOpenCodeGoWindow(usage.rolling, requireResetAt);
  const weekly = getOpenCodeGoWindow(usage.weekly, requireResetAt);
  const monthly = getOpenCodeGoWindow(usage.monthly, requireResetAt);
  if (!options.allowPartial && (!fiveHour || !weekly || !monthly)) return undefined;
  if (!fiveHour && !weekly && !monthly) return undefined;
  return { fiveHour, weekly, monthly };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function formatResetAt(resetAt: number, kind: "time" | "date"): string | undefined {
  if (!isValidResetAt(resetAt)) return undefined;
  const date = new Date(resetAt * 1000);
  return kind === "time"
    ? `${pad(date.getHours())}:${pad(date.getMinutes())}`
    : `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatWindow(window: CodexUsageWindow | undefined, resetKind: "time" | "date"): string | undefined {
  if (!window || window.resetAt === undefined) return undefined;
  const reset = formatResetAt(window.resetAt, resetKind);
  return reset === undefined ? undefined : `[ ${window.remainingPercent}%  ${reset} ]`;
}

export function formatCodexUsage(usage: CodexUsage): string {
  const windows = [
    formatWindow(usage.fiveHour, "time"),
    formatWindow(usage.weekly, "date"),
  ].filter((window): window is string => window !== undefined);
  return windows.length > 0 ? `codex ${windows.join(" ")}` : "";
}

export function formatOpenCodeGoUsage(usage: OpenCodeGoUsage): string {
  const windows = [
    formatWindow(usage.fiveHour, "time"),
    formatWindow(usage.weekly, "date"),
    formatWindow(usage.monthly, "date"),
  ].filter((window): window is string => window !== undefined);
  return windows.length > 0 ? `opencode-go ${windows.join(" ")}` : "";
}

export function formatProviderUsage(usage: ProviderUsage): string {
  return usage.provider === CODEX_PROVIDER_ID
    ? formatCodexUsage(usage.usage)
    : formatOpenCodeGoUsage(usage.usage);
}

function compactPercent(window: CodexUsageWindow | undefined): string | undefined {
  return window ? `${window.remainingPercent}%` : undefined;
}

export function formatCompactProviderUsage(usage: ProviderUsage): string {
  const windows = usage.provider === CODEX_PROVIDER_ID
    ? [compactPercent(usage.usage.fiveHour), compactPercent(usage.usage.weekly)]
    : [
      compactPercent(usage.usage.fiveHour),
      compactPercent(usage.usage.weekly),
      compactPercent(usage.usage.monthly),
    ];
  const values = windows.filter((window): window is string => window !== undefined);
  const label = usage.provider === CODEX_PROVIDER_ID ? "codex" : "opencode-go";
  return `${label} [${values.join("|")}]`;
}

function getFetchOptions(options?: ProviderUsageFetchOptions): ProviderUsageFetchOptions {
  return options ?? {};
}

export async function fetchCodexUsage(
  ctx: ExtensionContext,
  signal?: AbortSignal,
  options?: ProviderUsageFetchOptions,
): Promise<CodexUsage | undefined> {
  if (signal?.aborted) return undefined;

  const model = ctx.model;
  if (model?.provider !== CODEX_PROVIDER_ID) return undefined;
  if (typeof ctx.modelRegistry.isUsingOAuth !== "function" || !ctx.modelRegistry.isUsingOAuth(model)) {
    return undefined;
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || typeof auth.apiKey !== "string" || auth.apiKey.length === 0) return undefined;

  const accountId = getCodexAccountId(auth.apiKey);
  if (!accountId || signal?.aborted) return undefined;

  // Security: only send the official OAuth token and account identity to the
  // fixed official endpoint; provider-specific custom headers are not portable.
  const headers = {
    Authorization: `Bearer ${auth.apiKey}`,
    "chatgpt-account-id": accountId,
    originator: "pi",
  };
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  const timeout = setTimeout(abort, CODEX_USAGE_TIMEOUT_MS);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetch(CODEX_USAGE_URL, {
      headers,
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok) return undefined;
    return parseCodexUsage(await response.json(), getFetchOptions(options));
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

export async function fetchOpenCodeGoUsage(
  ctx: ExtensionContext,
  signal?: AbortSignal,
  options?: ProviderUsageFetchOptions,
): Promise<OpenCodeGoUsage | undefined> {
  if (signal?.aborted) return undefined;

  const model = ctx.model;
  if (model?.provider !== OPENCODE_GO_PROVIDER_ID) return undefined;

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || typeof auth.apiKey !== "string" || auth.apiKey.length === 0) return undefined;
  if (signal?.aborted) return undefined;

  const controller = new AbortController();
  const abort = (): void => controller.abort();
  const timeout = setTimeout(abort, CODEX_USAGE_TIMEOUT_MS);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetch(OPENCODE_GO_USAGE_URL, {
      headers: { Authorization: `Bearer ${auth.apiKey}` },
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok) return undefined;
    return parseOpenCodeGoUsage(await response.json(), getFetchOptions(options));
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

export async function fetchProviderUsage(
  ctx: ExtensionContext,
  signal?: AbortSignal,
  options?: ProviderUsageFetchOptions,
): Promise<ProviderUsage | undefined> {
  if (ctx.model?.provider === CODEX_PROVIDER_ID) {
    const usage = await fetchCodexUsage(ctx, signal, options);
    return usage ? { provider: CODEX_PROVIDER_ID, usage } : undefined;
  }
  if (ctx.model?.provider === OPENCODE_GO_PROVIDER_ID) {
    const usage = await fetchOpenCodeGoUsage(ctx, signal, options);
    return usage ? { provider: OPENCODE_GO_PROVIDER_ID, usage } : undefined;
  }
  return undefined;
}

// Flow: 先失效本地状态（requestId/timer），再 best-effort 清理 UI。
// 会话替换或 reload 后 ctx 已失效，UI 调用可能抛错，不能影响停止轮询。
export function createProviderUsageController(): ProviderUsageController {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let requestId = 0;

  const stop = (): void => {
    requestId++;
    if (timer) clearTimeout(timer);
    timer = undefined;
  };

  const isCtxActive = (ctx: ExtensionContext): boolean => {
    try {
      void ctx.mode;
      return true;
    } catch {
      return false;
    }
  };

  const isUsageProvider = (provider: unknown): provider is ProviderUsage["provider"] =>
    provider === CODEX_PROVIDER_ID || provider === OPENCODE_GO_PROVIDER_ID;

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
      ctx.ui.setStatus(TUI_PROVIDER_USAGE_STATUS_ID, undefined);
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

      const usage = await fetchProviderUsage(ctx, undefined, { allowPartial: true, requireResetAt: false });
      if (request !== requestId || ctx.model?.provider !== provider) return;
      const value = usage === undefined
        ? undefined
        : ctx.ui.theme.fg("dim", formatCompactProviderUsage(usage));
      ctx.ui.setStatus(TUI_PROVIDER_USAGE_STATUS_ID, value);
    } catch {
      // Failure: ctx 失效（stale）时永久停止；网络等瞬时错误清空状态后由 finally 重排重试。
      if (!isCtxActive(ctx)) {
        stop();
        return;
      }
      if (request === requestId) {
        try {
          ctx.ui.setStatus(TUI_PROVIDER_USAGE_STATUS_ID, undefined);
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
