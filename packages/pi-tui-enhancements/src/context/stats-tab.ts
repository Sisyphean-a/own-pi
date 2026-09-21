/**
 * 统计标签页：token 分布网格 + 分类明细。
 *
 * Rule: 网格与明细都使用普通方块字符（█ / ■）着色，不依赖 Nerd Font 图标，避免终端字体缺失时显示为乱码。
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import { type ContextTokenBreakdown, formatTokens } from "./format.ts";
import type { UiTheme, WidthUtils } from "../overlay-frame.ts";

const GRID_WIDTH = 10;
const GRID_HEIGHT = 5;
const TOTAL_BLOCKS = GRID_WIDTH * GRID_HEIGHT; // 50 个方块，每块 2%

const ANSI_RESET = "\x1b[0m";
const ANSI_BOLD = "\x1b[1m";

function fg(hex: string, text: string): string {
  const normalized = hex.replace("#", "");
  const r = Number.parseInt(normalized.slice(0, 2), 16);
  const g = Number.parseInt(normalized.slice(2, 4), 16);
  const b = Number.parseInt(normalized.slice(4, 6), 16);
  return `\x1b[38;2;${r};${g};${b}m${text}${ANSI_RESET}`;
}

function bold(text: string): string {
  return `${ANSI_BOLD}${text}${ANSI_RESET}`;
}

export interface StatsModelInfo {
  name: string;
  contextWindow?: number;
}

interface Category {
  key: keyof Pick<
    ContextTokenBreakdown,
    "systemPrompt" | "systemTools" | "tools" | "skills" | "messages" | "safeAvailable" | "reserveTokens"
  >;
  label: string;
  value: number;
  hex: string;
}

const CATEGORY_META = {
  systemPrompt: { label: "系统提示词", hex: "#A78BFA" },
  systemTools: { label: "系统工具", hex: "#22D3EE" },
  tools: { label: "工具", hex: "#34D399" },
  skills: { label: "技能", hex: "#FBBF24" },
  messages: { label: "消息", hex: "#60A5FA" },
  safeAvailable: { label: "可用", hex: "#6B7280" },
  reserveTokens: { label: "自动压缩缓冲", hex: "#FB923C" },
} as const;

const SWATCH = "■";
const BLOCK = "█";
const LABEL_WIDTH = 21;
const MIN_LABEL_WIDTH = 8;
const TOKEN_WIDTH = 7;
const PERCENT_WIDTH = 8;

export class StatsTabContent {
  readonly name = "统计";
  readonly footerHints = "";
  private readonly breakdown: ContextTokenBreakdown | null;
  private readonly theme: UiTheme;
  private readonly widthUtils: WidthUtils;
  private readonly modelInfo: StatsModelInfo | undefined;

  constructor(
    breakdown: ContextTokenBreakdown | null,
    theme: UiTheme,
    widthUtils: WidthUtils,
    modelInfo?: StatsModelInfo,
  ) {
    this.breakdown = breakdown;
    this.theme = theme;
    this.widthUtils = widthUtils;
    this.modelInfo = modelInfo;
  }

  /** 统计页没有搜索栏，始终使用分隔线。 */
  getAboveContentLine(_innerWidth: number): string | null {
    return null;
  }

  getFooterLeft(): string {
    if (!this.breakdown) return "";
    const { total, contextWindow, percent, safeAvailable } = this.breakdown;
    return `${formatTokens(total)} / ${formatTokens(contextWindow)} (${percent.toFixed(1)}%) · 剩余安全 ${formatTokens(safeAvailable)}`;
  }

  /** 统计页没有键盘交互。 */
  handleInput(_data: string): boolean {
    return false;
  }

  invalidate(): void {}

  renderContent(innerWidth: number, height: number): string[] {
    const th = this.theme;

    if (!this.breakdown) {
      const lines: string[] = [
        "",
        `  ${th.fg("warning", "暂无上下文用量数据。")}`,
        `  ${th.fg("dim", "请先发送一条消息，再重新打开 /context。")}`,
      ];
      while (lines.length < height) lines.push("");
      return lines;
    }

    const { total, contextWindow, percent, reserveTokens, safeAvailable } = this.breakdown;
    const modelName = this.modelInfo?.name ?? "未知模型";
    const safeLeftText =
      safeAvailable > 0 ? `剩余安全 ${formatTokens(safeAvailable)}` : "已达自动压缩阈值";

    const categories = this.getCategories();
    const layout = this.resolveLayout(innerWidth);
    const breakdownLines = this.renderBreakdown(categories, layout.labelWidth, layout.showPercent);

    // Rule: 窄终端先去掉网格，再隐藏百分比，始终让每一行落在弹窗内而不被裁断。
    const headerCandidates = [
      `  ${bold(`${modelName} · ${formatTokens(total)}/${formatTokens(contextWindow)} token（${percent.toFixed(1)}%）`)} ${th.fg("dim", `· ${safeLeftText}`)}`,
      `  ${bold(`${modelName} · ${formatTokens(total)}/${formatTokens(contextWindow)} token（${percent.toFixed(1)}%）`)}`,
      `  ${bold(`${formatTokens(total)}/${formatTokens(contextWindow)} token（${percent.toFixed(1)}%）`)}`,
      `  ${bold(`${formatTokens(total)}/${formatTokens(contextWindow)} token`)}`,
    ];
    const headerLine =
      headerCandidates.find((candidate) => this.widthUtils.visibleWidth(candidate) <= innerWidth) ??
      headerCandidates[headerCandidates.length - 1]!;

    const lines: string[] = [headerLine, "", "", `  ${th.fg("dim", "按类别估算的占用")}`, ""];

    if (layout.showGrid) {
      const gridLines = this.renderGrid(categories);
      const gridVisW = gridLines.length > 0 ? visibleWidth(gridLines[0]!) : GRID_WIDTH * 2 - 1;
      const maxRows = Math.max(gridLines.length, breakdownLines.length);
      for (let i = 0; i < maxRows; i++) {
        const leftRaw = gridLines[i] ?? "";
        const pad = " ".repeat(Math.max(0, gridVisW - visibleWidth(leftRaw)));
        lines.push(`    ${leftRaw}${pad}    ${breakdownLines[i] ?? ""}`);
      }
    } else {
      for (const row of breakdownLines) lines.push(`    ${row}`);
    }

    lines.push("");
    if (safeAvailable <= 0) {
      lines.push(`  ${fg(CATEGORY_META.reserveTokens.hex, "正在使用自动压缩缓冲")}`);
    } else {
      lines.push(
        `  ${th.fg("dim", `累计 ${formatTokens(contextWindow - reserveTokens)} token 后开始自动压缩`)}`,
      );
    }

    while (lines.length < height) lines.push("");
    return lines.slice(0, height);
  }

  /** 根据可用宽度选择网格、标签宽度和百分比列，保证明细行不会被裁断。 */
  private resolveLayout(innerWidth: number): { showGrid: boolean; showPercent: boolean; labelWidth: number } {
    const indent = 4;
    const gridWidth = GRID_WIDTH * 2 - 1;
    const gridGap = 4;
    const fixed = 1 + 1 + 1 + TOKEN_WIDTH; // 色块、空格、标签后空格、token 列
    const available = innerWidth - indent;
    const showPercent = available >= fixed + MIN_LABEL_WIDTH + 1 + PERCENT_WIDTH;
    const showGrid =
      available >= gridGap + gridWidth + gridGap + fixed + LABEL_WIDTH + (showPercent ? 1 + PERCENT_WIDTH : 0);
    const labelWidth = Math.max(
      MIN_LABEL_WIDTH,
      Math.min(LABEL_WIDTH, available - fixed - (showPercent ? 1 + PERCENT_WIDTH : 0)),
    );
    return { showGrid, showPercent, labelWidth };
  }

  private getCategories(): Category[] {
    const b = this.breakdown!;
    return [
      this.category("systemPrompt", b.systemPrompt),
      this.category("systemTools", b.systemTools),
      this.category("tools", b.tools),
      this.category("skills", b.skills),
      this.category("messages", b.messages + b.other),
      this.category("safeAvailable", b.safeAvailable),
      this.category("reserveTokens", b.reserveTokens),
    ];
  }

  private category(key: Category["key"], value: number): Category {
    return { key, value, ...CATEGORY_META[key] };
  }

  private renderGrid(categories: Category[]): string[] {
    const blocks: string[] = [];
    const { contextWindow, reserveTokens } = this.breakdown!;
    const reserveBlockCount =
      reserveTokens > 0 ? Math.max(1, Math.round((reserveTokens / contextWindow) * TOTAL_BLOCKS)) : 0;
    const safeBlockCount = Math.max(0, TOTAL_BLOCKS - reserveBlockCount);
    const safeWindow = Math.max(1, contextWindow - reserveTokens);
    const safeCategories = categories.filter((cat) => cat.key !== "reserveTokens");

    for (const cat of safeCategories) {
      let count = Math.round((cat.value / safeWindow) * safeBlockCount);
      if (count === 0 && cat.value > 0) count = 1;
      for (let j = 0; j < count && blocks.length < safeBlockCount; j++) {
        blocks.push(fg(cat.hex, BLOCK));
      }
    }

    while (blocks.length < safeBlockCount) {
      blocks.push(fg(CATEGORY_META.safeAvailable.hex, BLOCK));
    }

    for (let i = 0; i < reserveBlockCount && blocks.length < TOTAL_BLOCKS; i++) {
      blocks.push(fg(CATEGORY_META.reserveTokens.hex, BLOCK));
    }

    const gridLines: string[] = [];
    for (let r = 0; r < GRID_HEIGHT; r++) {
      let row = "";
      for (let c = 0; c < GRID_WIDTH; c++) {
        row += blocks[r * GRID_WIDTH + c] ?? fg(CATEGORY_META.safeAvailable.hex, BLOCK);
        if (c < GRID_WIDTH - 1) row += " ";
      }
      gridLines.push(row);
    }
    return gridLines;
  }

  private renderBreakdown(categories: Category[], labelWidth: number, showPercent: boolean): string[] {
    const th = this.theme;
    const { contextWindow } = this.breakdown!;

    return categories.map((cat) => {
      const pct = contextWindow > 0 ? (cat.value / contextWindow) * 100 : 0;
      const swatch = fg(cat.hex, SWATCH);
      const label = fg(cat.hex, this.padLabel(cat.label, labelWidth));
      const tokens = fg(cat.hex, formatTokens(cat.value).padStart(TOKEN_WIDTH));
      if (!showPercent) return `${swatch} ${label} ${tokens}`;
      const percent = th.fg("dim", `(${pct.toFixed(1).padStart(5)}%)`);
      return `${swatch} ${label} ${tokens} ${percent}`;
    });
  }

  /** 中文标签按显示宽度补齐，避免用字符数计算导致的错位。 */
  private padLabel(label: string, width: number): string {
    const pad = Math.max(0, width - this.widthUtils.visibleWidth(label));
    return label + " ".repeat(pad);
  }
}
