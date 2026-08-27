import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const CODEX_PROVIDER_ID = "openai-codex";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_USAGE_TIMEOUT_MS = 10_000;
const CODEX_AUTH_CLAIM = "https://api.openai.com/auth";

export type CodexUsageWindow = {
  remainingPercent: number;
  resetAt: number;
};

export type CodexUsage = {
  fiveHour: CodexUsageWindow;
  weekly: CodexUsageWindow;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
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

function getWindow(value: unknown): CodexUsageWindow | undefined {
  const window = asRecord(value);
  const usedPercent = window.used_percent;
  const resetAt = window.reset_at;
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) return undefined;
  if (typeof resetAt !== "number" || !Number.isFinite(resetAt) || resetAt <= 0 || !isValidResetAt(resetAt)) {
    return undefined;
  }

  return {
    remainingPercent: Math.round(100 - Math.min(100, Math.max(0, usedPercent))),
    resetAt,
  };
}

function parseCodexUsage(payload: unknown): CodexUsage | undefined {
  const rateLimit = asRecord(asRecord(payload).rate_limit);
  const fiveHour = getWindow(rateLimit.primary_window);
  const weekly = getWindow(rateLimit.secondary_window);
  if (!fiveHour || !weekly) return undefined;
  return { fiveHour, weekly };
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

function formatWindow(window: CodexUsageWindow, resetKind: "time" | "date"): string | undefined {
  const reset = formatResetAt(window.resetAt, resetKind);
  return reset === undefined ? undefined : `[ ${window.remainingPercent}%  ${reset} ]`;
}

export function formatCodexUsage(usage: CodexUsage): string {
  const fiveHour = formatWindow(usage.fiveHour, "time");
  const weekly = formatWindow(usage.weekly, "date");
  return fiveHour && weekly ? `codex ${fiveHour} ${weekly}` : "";
}

export async function fetchCodexUsage(
  ctx: ExtensionContext,
  signal?: AbortSignal,
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
    return parseCodexUsage(await response.json());
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}
