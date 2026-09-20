import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TUI_PROVIDER_USAGE_STATUS_ID } from "../provider-usage.ts";

type ThemeLike = {
  fg(color: string, text: string): string;
};

type FooterDataLike = {
  getGitBranch(): string | null;
  getExtensionStatuses(): ReadonlyMap<string, string>;
  getAvailableProviderCount(): number;
  onBranchChange(callback: () => void): () => void;
};

type TuiLike = {
  requestRender(): void;
};

type WidthUtils = {
  visibleWidth(text: string): number;
  truncateToWidth(text: string, width: number, ellipsis?: string): string;
};

type UsageTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  latestCacheHitRate?: number;
};

/**
 * footer 的 usage 增量缓存。
 *
 * Rule: 会话条目只在末尾追加，因此已累计的 usage 永不失效；只有条目数量变化或前缀身份改变
 * （reload、分支切换、压缩重写）才整体重算。footer 每次重绘都调用 render，逐帧全量求和会让
 * 每帧成本随会话长度增长。
 */
type UsageMemo = UsageTotals & {
  count: number;
  first: unknown;
};

function emptyUsageMemo(): UsageMemo {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, count: 0, first: undefined };
}

type StatPart = {
  text: string;
  tone: "thinkingLow" | "thinkingMedium" | "accent" | "warning" | "error";
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function addUsage(totals: UsageTotals, value: unknown): void {
  const usage = asRecord(value);
  totals.input += finiteNumber(usage.input);
  totals.output += finiteNumber(usage.output);
  totals.cacheRead += finiteNumber(usage.cacheRead);
  totals.cacheWrite += finiteNumber(usage.cacheWrite);
}

/** 把一条会话条目累加进 totals；返回它是否贡献了 usage。 */
function addEntryUsage(totals: UsageTotals, value: unknown): boolean {
  const entry = asRecord(value);
  const message = asRecord(entry.message);
  const role = message.role;
  const usage = entry.type === "message" ? message.usage : entry.usage;
  const contributes =
    (entry.type === "message" && (role === "assistant" || role === "toolResult")) ||
    entry.type === "branch_summary" ||
    entry.type === "compaction";

  if (!contributes || !usage) return false;
  addUsage(totals, usage);

  if (entry.type === "message" && role === "assistant") {
    const current = asRecord(usage);
    const input = finiteNumber(current.input);
    const cacheRead = finiteNumber(current.cacheRead);
    const cacheWrite = finiteNumber(current.cacheWrite);
    const promptTokens = input + cacheRead + cacheWrite;
    // Effect: promptTokens 为 0 时清除字段而不是留 undefined，保持与全量重算逐字段同构。
    if (promptTokens > 0) totals.latestCacheHitRate = (cacheRead / promptTokens) * 100;
    else delete totals.latestCacheHitRate;
  }
  return true;
}

export function collectUsage(entries: readonly unknown[], memo?: UsageMemo): UsageTotals {
  const stablePrefix = memo !== undefined && entries.length >= memo.count && entries[0] === memo.first;
  const totals: UsageTotals = stablePrefix
    ? { input: memo.input, output: memo.output, cacheRead: memo.cacheRead, cacheWrite: memo.cacheWrite }
    : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  if (stablePrefix && memo.latestCacheHitRate !== undefined) {
    totals.latestCacheHitRate = memo.latestCacheHitRate;
  }

  for (let i = stablePrefix ? memo!.count : 0; i < entries.length; i++) {
    addEntryUsage(totals, entries[i]);
  }

  if (memo) {
    memo.input = totals.input;
    memo.output = totals.output;
    memo.cacheRead = totals.cacheRead;
    memo.cacheWrite = totals.cacheWrite;
    memo.latestCacheHitRate = totals.latestCacheHitRate;
    memo.count = entries.length;
    memo.first = entries[0];
  }
  return totals;
}

export function formatTokens(count: number): string {
  if (count < 1_000) return count.toString();
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

function workspaceName(cwd: string): string {
  const normalized = cwd.replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).at(-1) || cwd;
}

function sanitizeStatusText(text: string): string {
  return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function identityText(ctx: ExtensionContext, footerData: FooterDataLike): string {
  let identity = workspaceName(ctx.cwd);
  const branch = footerData.getGitBranch();
  if (branch) identity += ` (${branch})`;

  const getSessionName = (ctx.sessionManager as unknown as { getSessionName?: () => string | undefined }).getSessionName;
  const sessionName = getSessionName?.call(ctx.sessionManager);
  if (sessionName) identity += ` • ${sanitizeStatusText(sessionName)}`;
  return identity;
}

function statParts(ctx: ExtensionContext, usageMemo: UsageMemo): StatPart[] {
  const entries = ctx.sessionManager.getEntries() as readonly unknown[];
  const usage = collectUsage(entries, usageMemo);
  const parts: StatPart[] = [];

  if (usage.input) parts.push({ text: `↑${formatTokens(usage.input)}`, tone: "thinkingLow" });
  if (usage.output) parts.push({ text: `↓${formatTokens(usage.output)}`, tone: "thinkingLow" });
  if (usage.cacheWrite) parts.push({ text: `W${formatTokens(usage.cacheWrite)}`, tone: "thinkingMedium" });
  if ((usage.cacheRead > 0 || usage.cacheWrite > 0) && usage.latestCacheHitRate !== undefined) {
    parts.push({ text: `[${usage.latestCacheHitRate.toFixed(1)}%]`, tone: "accent" });
  }

  const contextUsage = ctx.getContextUsage();
  const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
  const percent = contextUsage?.percent;
  const contextText = percent === null
    ? `?/${formatTokens(contextWindow)}`
    : `${(percent ?? 0).toFixed(1)}%/${formatTokens(contextWindow)}`;
  parts.push({
    text: contextText,
    tone: (percent ?? 0) > 90 ? "error" : (percent ?? 0) > 70 ? "warning" : "thinkingMedium",
  });

  return parts;
}

function styleStats(parts: StatPart[], theme: ThemeLike): string {
  return parts.map((part) => theme.fg(part.tone, part.text)).join(theme.fg("dim", " "));
}

function rightText(ctx: ExtensionContext, includeProvider: boolean): string {
  const modelName = ctx.model?.id || "no-model";
  let value = modelName;
  if (ctx.model?.reasoning) {
    const thinkingLevel = ctx.thinkingLevel || "off";
    value = thinkingLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinkingLevel}`;
  }
  return includeProvider && ctx.model ? `(${ctx.model.provider}) ${value}` : value;
}

function rightCandidates(ctx: ExtensionContext, footerData: FooterDataLike): string[] {
  const base = rightText(ctx, false);
  return footerData.getAvailableProviderCount() > 1 && ctx.model
    ? [rightText(ctx, true), base]
    : [base];
}

function fittingRight(
  candidates: string[],
  leftWidth: number,
  width: number,
  visibleWidth: WidthUtils["visibleWidth"],
): string | undefined {
  return candidates.find((candidate) => leftWidth + 2 + visibleWidth(candidate) <= width);
}

function alignRight(
  left: string,
  right: string,
  width: number,
  theme: ThemeLike,
  widthUtils: WidthUtils,
): string {
  const ellipsis = theme.fg("dim", "...");
  const renderedLeft = left;
  const leftWidth = widthUtils.visibleWidth(renderedLeft);
  if (leftWidth >= width) return widthUtils.truncateToWidth(renderedLeft, width, ellipsis);

  const availableForRight = width - leftWidth - 2;
  if (availableForRight <= 0) return widthUtils.truncateToWidth(renderedLeft, width, ellipsis);

  const renderedRight = widthUtils.truncateToWidth(theme.fg("dim", right), availableForRight, "");
  const rightWidth = widthUtils.visibleWidth(renderedRight);
  const padding = " ".repeat(Math.max(2, width - leftWidth - rightWidth));
  return widthUtils.truncateToWidth(renderedLeft + padding + renderedRight, width);
}

function fittingSummary(
  leftCandidates: string[],
  rightCandidates: string[],
  width: number,
  visibleWidth: WidthUtils["visibleWidth"],
): { left: string; right: string } | undefined {
  for (const left of leftCandidates) {
    const right = fittingRight(rightCandidates, visibleWidth(left), width, visibleWidth);
    if (right !== undefined) return { left, right };
  }
  return undefined;
}

export function createCompactFooter(
  ctx: ExtensionContext,
  tui: TuiLike,
  theme: ThemeLike,
  footerData: FooterDataLike,
  widthUtils: WidthUtils,
) {
  const unsubscribeBranch = footerData.onBranchChange(() => tui.requestRender());
  // 每帧重绘复用同一份增量缓存，只有新条目才需要求和。
  const usageMemo = emptyUsageMemo();

  return {
    dispose() {
      unsubscribeBranch();
    },
    invalidate() {},
    render(width: number): string[] {
      if (width <= 0) return [];

      const identity = identityText(ctx, footerData);
      const stats = styleStats(statParts(ctx, usageMemo), theme);
      const identityStyled = theme.fg("dim", identity);
      const separator = theme.fg("dim", " | ");
      const combinedLeft = identityStyled + separator + stats;
      const candidates = rightCandidates(ctx, footerData);
      const oneLine = fittingSummary([combinedLeft], candidates, width, widthUtils.visibleWidth);
      const lines: string[] = [];

      if (oneLine) {
        lines.push(alignRight(oneLine.left, oneLine.right, width, theme, widthUtils));
      } else {
        lines.push(widthUtils.truncateToWidth(identityStyled, width, theme.fg("dim", "...")));
        const summaryLeft = stats;
        const secondLine = fittingSummary([summaryLeft], candidates, width, widthUtils.visibleWidth);
        const secondLineLeft = secondLine?.left ?? summaryLeft;
        const secondLineRight = secondLine?.right ?? candidates.at(-1) ?? "no-model";
        lines.push(alignRight(secondLineLeft, secondLineRight, width, theme, widthUtils));
      }

      const statuses = Array.from(footerData.getExtensionStatuses().entries())
        .sort(([a], [b]) => {
          const aPriority = a === TUI_PROVIDER_USAGE_STATUS_ID ? 0 : 1;
          const bPriority = b === TUI_PROVIDER_USAGE_STATUS_ID ? 0 : 1;
          return aPriority - bPriority || a.localeCompare(b);
        })
        .map(([, text]) => sanitizeStatusText(text))
        .filter(Boolean);
      if (statuses.length > 0) {
        lines.push(widthUtils.truncateToWidth(statuses.join(" "), width, theme.fg("dim", "...")));
      }

      return lines;
    },
  };
}
