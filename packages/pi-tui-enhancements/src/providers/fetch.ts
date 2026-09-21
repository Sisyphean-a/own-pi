/**
 * provider 取数与认证的共用骨架。
 *
 * Rule: 超时、外部中止转发和“响应不是 2xx 就放弃”对所有 provider 相同，集中在这里；
 * 每个适配器只负责自己的认证方式、请求头、请求体和响应解析。
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** 单次 usage 请求的超时；所有 provider 共用。 */
export const USAGE_TIMEOUT_MS = 10_000;

export type UsageAuth = { ok: true; apiKey: string } | { ok: false };

export async function resolveApiKeyAuth(
  ctx: ExtensionContext,
  model: unknown,
): Promise<UsageAuth> {
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(
    model as Parameters<ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"]>[0],
  );
  return auth.ok && typeof auth.apiKey === "string" && auth.apiKey.length > 0
    ? { ok: true, apiKey: auth.apiKey }
    : { ok: false };
}

/**
 * 在外部中止信号下带超时地请求 JSON。
 *
 * Guarantee: 外部信号中止时向调用方抛出中止错误；超时由内部 controller 中止请求；
 * 非 2xx 返回 undefined；返回前移除外部监听并清除定时器。
 */
export async function fetchJson(
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal },
): Promise<unknown | undefined> {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  const timeout = setTimeout(abort, USAGE_TIMEOUT_MS);
  init.signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetch(url, {
      headers: init.headers,
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok) return undefined;
    return await response.json();
  } finally {
    clearTimeout(timeout);
    init.signal?.removeEventListener("abort", abort);
  }
}

/**
 * best-effort 请求：失败（非 2xx、网络错误、解析错误）或外部已中止时返回 undefined，不抛错。
 * 用于可选的第二段数据，例如套餐订阅。
 */
export async function fetchJsonBestEffort(
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal },
): Promise<unknown | undefined> {
  if (init.signal?.aborted) return undefined;
  try {
    return await fetchJson(url, init);
  } catch {
    return undefined;
  }
}
