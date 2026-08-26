import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const CODEX_PROVIDER_ID = "openai-codex";
const CODEX_USAGE_STATUS_ID = "lean-codex-usage";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_USAGE_REFRESH_MS = 5 * 60 * 1000;
const CODEX_USAGE_TIMEOUT_MS = 10_000;

type CodexUsageController = {
  clear(ctx: ExtensionContext): void;
  refresh(ctx: ExtensionContext): Promise<void>;
};

type CodexUsage = {
  fiveHour?: number;
  weekly?: number;
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

function getCodexUsage(payload: unknown): CodexUsage | undefined {
  const rateLimit = asRecord(asRecord(payload).rate_limit);
  const usage: CodexUsage = {
    fiveHour: getWindowRemainingPercent(rateLimit.primary_window),
    weekly: getWindowRemainingPercent(rateLimit.secondary_window),
  };
  return usage.fiveHour === undefined && usage.weekly === undefined ? undefined : usage;
}

function formatCodexUsage(usage: CodexUsage): string {
  const windows: string[] = [];
  if (usage.fiveHour !== undefined) windows.push(`${usage.fiveHour}%`);
  if (usage.weekly !== undefined) windows.push(`${usage.weekly}%`);
  return `codex [${windows.join(" | ")}]`;
}

async function fetchCodexUsage(ctx: ExtensionContext): Promise<CodexUsage | undefined> {
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
    const response = await fetch(CODEX_USAGE_URL, { headers, signal: controller.signal });
    if (!response.ok) return undefined;
    return getCodexUsage(await response.json());
  } finally {
    clearTimeout(timeout);
  }
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
      if (request !== requestId || !isCtxActive(ctx) || ctx.model?.provider !== CODEX_PROVIDER_ID) return;
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
      if (ctx.model?.provider !== CODEX_PROVIDER_ID) {
        clear(ctx);
        return;
      }

      const usage = await fetchCodexUsage(ctx);
      if (request !== requestId || ctx.model?.provider !== CODEX_PROVIDER_ID) return;
      const value = usage === undefined
        ? undefined
        : ctx.ui.theme.fg("dim", formatCodexUsage(usage));
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
