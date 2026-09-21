/**
 * 一个额度 provider 的完整适配器契约。
 *
 * Rule: provider 的匹配、认证、请求和响应解析都归自己所有；provider-usage.ts 只做注册表、
 * 路由和轮询控制，不重复判断 provider 细节。
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ProviderUsageWindows, UsageAuth, UsageFetchOptions } from "./types.ts";

export type ProviderRequestSpec = { url: string; headers: Record<string, string> };

/** 解析阶段能看到本次请求的认证信息，Command Code 的第二次订阅请求需要复用同一个 key。 */
export type ProviderParseContext = {
  payload: unknown;
  auth: Extract<UsageAuth, { ok: true }>;
  options: UsageFetchOptions;
  signal?: AbortSignal;
};

export type ProviderAdapter = {
  /** 面板标签与 ProviderUsage 判别字段共用该 id。 */
  id: string;
  matches(provider: unknown): boolean;
  /** 依赖 ctx.model 的认证；失败返回 { ok: false }，调用方直接放弃本次取数。 */
  resolveAuth(ctx: ExtensionContext, model: unknown): Promise<UsageAuth>;
  /** 首个请求；可选数据由适配器在 parse 中自行 best-effort 获取。 */
  buildRequest(apiKey: string): ProviderRequestSpec;
  parse(context: ProviderParseContext): Promise<ProviderUsageWindows | undefined>;
};
