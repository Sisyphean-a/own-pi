/**
 * Codex 官方 OAuth 额度适配器。
 *
 * Flow: `wham/usage` 一次请求；认证必须是官方 OAuth，且 token 里带 chatgpt_account_id。
 * Rule: 只向固定官方端点发送该 token 与账号身份，provider 自定义请求头不外传。
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ProviderAdapter } from "./adapter.ts";
import { fetchJson, resolveApiKeyAuth } from "./fetch.ts";
import type { UsageAuth } from "./types.ts";
import { asRecord, hasUsableWindows, normalizePercentWindow } from "./format.ts";
import {
  CODEX_PROVIDER_ID,
  type ProviderUsageWindows,
  type UsageFetchOptions,
} from "./types.ts";

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_AUTH_CLAIM = "https://api.openai.com/auth";

function decodeBase64Url(value: string): string | undefined {
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    return atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  } catch {
    return undefined;
  }
}

export function getCodexAccountId(accessToken: string): string | undefined {
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

async function resolveAuth(ctx: ExtensionContext, model: unknown): Promise<UsageAuth> {
  const modelLike = model as { provider?: unknown } | undefined;
  if (modelLike?.provider !== CODEX_PROVIDER_ID) return { ok: false };
  if (typeof ctx.modelRegistry.isUsingOAuth !== "function" || !ctx.modelRegistry.isUsingOAuth(modelLike as never)) {
    return { ok: false };
  }
  const auth = await resolveApiKeyAuth(ctx, model);
  if (!auth.ok) return { ok: false };
  return getCodexAccountId(auth.apiKey) === undefined ? { ok: false } : auth;
}

function parse(payload: unknown, options: UsageFetchOptions): ProviderUsageWindows | undefined {
  const rateLimit = asRecord(asRecord(payload).rate_limit);
  const requireResetAt = options.requireResetAt !== false;
  const fiveHour = normalizePercentWindow(rateLimit.primary_window, requireResetAt);
  const weekly = normalizePercentWindow(rateLimit.secondary_window, requireResetAt);
  if (!fiveHour && !weekly) return undefined;

  const windows: ProviderUsageWindows = { fiveHour, weekly };
  return hasUsableWindows(windows, options, ["fiveHour", "weekly"]) ? windows : undefined;
}

export const codexAdapter: ProviderAdapter = {
  id: CODEX_PROVIDER_ID,
  matches: (provider) => provider === CODEX_PROVIDER_ID,
  resolveAuth,
  buildRequest: (apiKey) => ({
    url: CODEX_USAGE_URL,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "chatgpt-account-id": getCodexAccountId(apiKey)!,
      originator: "pi",
    },
  }),
  async parse({ payload, options }) {
    return parse(payload, options);
  },
};
