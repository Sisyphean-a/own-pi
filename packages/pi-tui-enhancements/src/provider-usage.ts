/**
 * Pi 额度显示的公开入口：路由到 provider 适配器，并把结果发布到状态栏。
 *
 * Flow: `fetchProviderUsage` 按当前模型选适配器，认证后只发适配器声明的请求；
 * `createProviderUsageController` 负责刷新调度、stale ctx 防护和状态清理。
 * Rule: provider 细节（端点、认证、请求头、解析、套餐表）全部属于 src/providers/ 下的适配器，
 * 本文件不判断具体 provider，只消费 ProviderAdapter 契约。
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ProviderAdapter } from "./providers/adapter.ts";
import { fetchJson } from "./providers/fetch.ts";
import { formatUsageCompact, formatUsageDetail } from "./providers/format.ts";
import { commandCodeAdapter } from "./providers/command-code.ts";
import { codexAdapter } from "./providers/codex.ts";
import { openCodeGoAdapter } from "./providers/opencode-go.ts";
import { findProviderAdapter } from "./providers/registry.ts";
import {
  CODEX_PROVIDER_ID,
  COMMANDCODE_PROVIDER_ID,
  OPENCODE_GO_PROVIDER_ID,
  TUI_PROVIDER_USAGE_STATUS_ID,
  type ProviderUsageWindows,
  type UsageFetchOptions,
} from "./providers/types.ts";

export {
  CODEX_PROVIDER_ID,
  COMMANDCODE_PROVIDER_ID,
  OPENCODE_GO_PROVIDER_ID,
  TUI_PROVIDER_USAGE_STATUS_ID,
  type ProviderUsageWindows,
  type UsageFetchOptions,
  type UsageWindow,
  type WindowKind,
} from "./providers/types.ts";

export { isCommandCodeProvider } from "./providers/command-code.ts";

/** 三个 provider 的额度窗口形状相同；判别字段是 provider，窗口语义由适配器负责。 */
export type ProviderUsage = { provider: string; usage: ProviderUsageWindows };

export type ProviderUsageController = {
  clear(ctx: ExtensionContext): void;
  refresh(ctx: ExtensionContext): Promise<void>;
};

/** 刷新间隔：5 分钟。 */
const USAGE_REFRESH_MS = 5 * 60 * 1000;

async function fetchProviderWindows(
  adapter: ProviderAdapter,
  ctx: ExtensionContext,
  signal?: AbortSignal,
  options: UsageFetchOptions = {},
): Promise<ProviderUsageWindows | undefined> {
  if (signal?.aborted) return undefined;

  // Rule: 认证失败不发请求；外部中止在认证期间发生时立即放弃。
  const auth = await adapter.resolveAuth(ctx, ctx.model);
  if (!auth.ok || signal?.aborted) return undefined;

  const request = adapter.buildRequest(auth.apiKey);
  const payload = await fetchJson(request.url, { headers: request.headers, signal });
  if (payload === undefined) return undefined;

  return adapter.parse({ payload, auth, options, signal });
}

// Flow: 先按模型选适配器，再把适配器的认证与首个请求交给同一个取数骨架。
export async function fetchProviderUsage(
  ctx: ExtensionContext,
  signal?: AbortSignal,
  options: UsageFetchOptions = {},
): Promise<ProviderUsage | undefined> {
  const adapter = findProviderAdapter(ctx.model?.provider);
  if (!adapter) return undefined;
  const usage = await fetchProviderWindows(adapter, ctx, signal, options);
  return usage === undefined ? undefined : { provider: adapter.id, usage };
}

/** 单 provider 取数入口，测试直接使用；调用方走 fetchProviderUsage。 */
export function fetchCodexUsage(
  ctx: ExtensionContext,
  signal?: AbortSignal,
  options: UsageFetchOptions = {},
): Promise<ProviderUsageWindows | undefined> {
  return fetchProviderWindows(codexAdapter, ctx, signal, options);
}

export function fetchOpenCodeGoUsage(
  ctx: ExtensionContext,
  signal?: AbortSignal,
  options: UsageFetchOptions = {},
): Promise<ProviderUsageWindows | undefined> {
  return fetchProviderWindows(openCodeGoAdapter, ctx, signal, options);
}

export function fetchCommandCodeUsage(
  ctx: ExtensionContext,
  signal?: AbortSignal,
  options: UsageFetchOptions = {},
): Promise<ProviderUsageWindows | undefined> {
  return fetchProviderWindows(commandCodeAdapter, ctx, signal, options);
}

export function formatCodexUsage(usage: ProviderUsageWindows): string {
  return formatUsageDetail("codex", usage);
}

export function formatOpenCodeGoUsage(usage: ProviderUsageWindows): string {
  return formatUsageDetail(OPENCODE_GO_PROVIDER_ID, usage);
}

export function formatCommandCodeUsage(usage: ProviderUsageWindows): string {
  return formatUsageDetail(COMMANDCODE_PROVIDER_ID, usage);
}

export function formatProviderUsage(usage: ProviderUsage): string {
  if (usage.provider === CODEX_PROVIDER_ID) return formatCodexUsage(usage.usage);
  if (usage.provider === OPENCODE_GO_PROVIDER_ID) return formatOpenCodeGoUsage(usage.usage);
  return formatCommandCodeUsage(usage.usage);
}

export function formatCompactProviderUsage(usage: ProviderUsage): string {
  if (usage.provider === CODEX_PROVIDER_ID) return formatUsageCompact("codex", usage.usage);
  return formatUsageCompact(usage.provider, usage.usage);
}

/**
 * 轮询控制器：refresh 永不向调用方抛错。
 *
 * Rule: 定时器回调里的 rejection 会变成 uncaughtException，因此这里吞掉瞬时错误并重排；
 * ctx 失效（会话替换或 reload）时永久停止轮询，不再触碰该 ctx。
 * Guarantee: 清理先失效 requestId 再 best-effort 清理 UI，UI 抛错不影响停止轮询。
 */
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

  const isUsageProvider = (provider: unknown): boolean => findProviderAdapter(provider) !== undefined;

  const scheduleRefresh = (ctx: ExtensionContext, request: number): void => {
    try {
      if (request !== requestId || !isCtxActive(ctx) || !isUsageProvider(ctx.model?.provider)) return;
      timer = setTimeout(() => {
        timer = undefined;
        void refresh(ctx);
      }, USAGE_REFRESH_MS);
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

  const refresh = async (ctx: ExtensionContext): Promise<void> => {
    // Rule: 手动刷新或切换模型会替换待执行的定时器，避免重复轮询。
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
      // Failure: ctx 失效时永久停止；网络等瞬时错误清空状态后由 finally 重排重试。
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
