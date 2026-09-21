/**
 * 可滚动标签页：行号、vim 风格滚动、实时搜索、剪贴板复制。
 *
 * Flow: 渲染时先按显示宽度把逻辑行拆成视觉行，再按滚动偏移取窗口；
 * 搜索匹配按逻辑行记录，滚动时换算回视觉行。
 *
 * Rule: 折行只在逻辑行内容或内宽变化时重算，并按块惰性建立；
 * 滚动、搜索高亮和翻页只付出可见行数的代价。
 */

import { copyToClipboard as copyTextToClipboard } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, sliceByColumn, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { UiTheme, WidthUtils } from "../overlay-frame.ts";

export interface ScrollableTabOptions {
  rawText: string;
  displayLines: string[];
  theme: UiTheme;
  widthUtils: WidthUtils;
  contentHeight: number;
}

/** 一次建立视觉行的逻辑行数：块越大越省开销，越小越不容易在打开时卡顿。 */
const VISUAL_CHUNK_LINES = 2048;

type VisualChunk = {
  /** 该块内每条逻辑行对应的视觉行（逻辑行内容在构造后不变）。 */
  rows: string[][];
  /** 该块视觉行总数（含尚未生成的块，用行数上界初始化）。 */
  rowCount: number;
  /** 该块之前累计的视觉行数上界，用于定位。 */
  startRow: number;
};

/** 上界估算：每行至少一视觉行，折行后不会超过「可见宽度 + 1」行。 */
function estimateRowCount(displayLine: string, innerWidth: number, numWidth: number): number {
  const lineWidth = visibleWidth(displayLine);
  if (innerWidth <= 0 || lineWidth <= innerWidth) return 1;
  const contentMaxWidth = Math.max(1, innerWidth - (numWidth + 3));
  const contentWidth = lineWidth - (numWidth + 3);
  return Math.max(1, Math.ceil(contentWidth / contentMaxWidth) + 1);
}

/**
 * 按块惰性建立的视觉行索引，把 /context 的打开成本从「全部上下文文本」降到「可见范围」。
 *
 * Guarantee: 未生成的块只记行数上界；`totalRows` 或越界取行时才补齐后续块，
 * 补齐后上界被精确值替换。
 */
class VisualLineIndex {
  private chunks: VisualChunk[] = [];
  /** 已补齐的块数（前缀），其前的行数是精确值。 */
  private resolvedCount = 0;
  private builtTotal = 0;
  private lineCount = 0;
  private innerWidth = -1;
  private readonly lines: string[];
  private readonly theme: UiTheme;
  private readonly numWidthOf: () => number;

  constructor(lines: string[], theme: UiTheme) {
    this.lines = lines;
    this.theme = theme;
    this.numWidthOf = () => String(lines.length).length;
  }

  reset(innerWidth: number): void {
    const total = this.lines.length;
    const numWidth = this.numWidthOf();
    this.chunks = [];
    this.resolvedCount = 0;
    this.builtTotal = 0;
    this.lineCount = total;
    this.innerWidth = innerWidth;
    let startRow = 0;
    for (let start = 0; start < total; start += VISUAL_CHUNK_LINES) {
      const end = Math.min(start + VISUAL_CHUNK_LINES, total);
      let rowCount = 0;
      for (let i = start; i < end; i++) rowCount += estimateRowCount(this.lines[i]!, innerWidth, numWidth);
      this.chunks.push({ rows: [], rowCount, startRow });
      startRow += rowCount;
    }
  }

  /** 视觉行总数；必要时补齐尚未精确的块。 */
  totalRows(): number {
    while (this.resolvedCount < this.chunks.length) this.resolveChunk(this.resolvedCount);
    return this.builtTotal;
  }

  /** 取指定视觉行；超出范围返回 undefined。 */
  rowAt(rowIndex: number): { text: string; logicalIndex: number } | undefined {
    if (rowIndex < 0 || rowIndex >= this.upperBoundTotal()) return undefined;
    let chunkIndex = this.findChunk(rowIndex);
    if (chunkIndex < 0) return undefined;
    this.resolveChunk(chunkIndex);
    // 补齐后行数可能变小，重新定位一次。
    chunkIndex = this.findChunk(rowIndex);
    if (chunkIndex < 0) return undefined;
    const chunk = this.chunks[chunkIndex]!;
    let local = rowIndex - chunk.startRow;
    for (let i = 0; i < chunk.rows.length; i++) {
      const rows = chunk.rows[i]!;
      if (local < rows.length) {
        return { text: rows[local]!, logicalIndex: chunkIndex * VISUAL_CHUNK_LINES + i };
      }
      local -= rows.length;
    }
    return undefined;
  }

  /** 逻辑行对应的第一个视觉行下标；未命中返回 -1。 */
  firstRowOfLogical(logicalIndex: number): number {
    if (logicalIndex < 0 || logicalIndex >= this.lineCount) return -1;
    const chunkIndex = Math.floor(logicalIndex / VISUAL_CHUNK_LINES);
    this.resolveChunk(chunkIndex);
    const chunk = this.chunks[chunkIndex]!;
    let row = chunk.startRow;
    for (let i = 0; i < logicalIndex - chunkIndex * VISUAL_CHUNK_LINES; i++) row += chunk.rows[i]!.length;
    return row;
  }

  private upperBoundTotal(): number {
    const last = this.chunks[this.chunks.length - 1];
    return last ? last.startRow + last.rowCount : 0;
  }

  private findChunk(rowIndex: number): number {
    let low = 0;
    let high = this.chunks.length - 1;
    let found = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const chunk = this.chunks[mid]!;
      if (rowIndex < chunk.startRow) high = mid - 1;
      else if (rowIndex >= chunk.startRow + chunk.rowCount) low = mid + 1;
      else {
        found = mid;
        break;
      }
    }
    return found;
  }

  /** 建立单个块的精确视觉行，并把精确行数计入总数、修正后续块的起始行。 */
  private resolveChunk(chunkIndex: number): void {
    const chunk = this.chunks[chunkIndex];
    if (!chunk || chunk.rows.length > 0) return;
    const start = chunkIndex * VISUAL_CHUNK_LINES;
    const end = Math.min(start + VISUAL_CHUNK_LINES, this.lineCount);
    const rows: string[][] = [];
    let rowCount = 0;
    for (let i = start; i < end; i++) {
      const visualRows = this.wrapLine(i);
      rows.push(visualRows);
      rowCount += visualRows.length;
    }
    chunk.rows = rows;
    chunk.rowCount = rowCount;
    this.builtTotal += rowCount;
    if (chunkIndex === this.resolvedCount) this.resolvedCount++;
    this.rebaseFrom(chunkIndex + 1);
  }

  /** 按当前精确行数修正后续块的起始行。 */
  private rebaseFrom(chunkIndex: number): void {
    const previous = this.chunks[chunkIndex - 1];
    let cursor = previous ? previous.startRow + previous.rowCount : 0;
    for (let i = chunkIndex; i < this.chunks.length; i++) {
      this.chunks[i]!.startRow = cursor;
      cursor += this.chunks[i]!.rowCount;
    }
  }

  private wrapLine(logicalIndex: number): string[] {
    const displayLine = this.lines[logicalIndex]!;
    // 沿用 Pi 的显示宽度：`widthUtils.visibleWidth` 可能与渲染语义不一致。
    const lineWidth = visibleWidth(displayLine);
    if (lineWidth <= this.innerWidth) return [displayLine];

    const numWidth = this.numWidthOf();
    const prefixWidth = numWidth + 3;
    const contentMaxWidth = Math.max(1, this.innerWidth - prefixWidth);
    const origPrefix = sliceByColumn(displayLine, 0, prefixWidth);
    const content = sliceByColumn(displayLine, prefixWidth, lineWidth - prefixWidth);
    const wrapped = wrapTextWithAnsi(content, contentMaxWidth);
    const continuationPrefix = this.theme.fg("dim", " ".repeat(numWidth) + " · ");
    const rows: string[] = [];
    for (let w = 0; w < wrapped.length; w++) {
      rows.push(w === 0 ? origPrefix + wrapped[w]! : continuationPrefix + wrapped[w]!);
    }
    return rows;
  }
}

export class ScrollableTabContent {
  private scrollOffset = 0;
  private searchMode = false;
  private searchQuery = "";
  private searchMatches: number[] = [];
  /** 搜索命中行的集合视图：逐行判断是否命中，线性 `includes` 会随命中数放大成 O(命中数 × 行数)。 */
  private searchMatchSet = new Set<number>();
  private currentMatchIndex = -1;
  private copyFlash = false;
  private copyFlashTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * 视觉行索引：按块惰性建立，只在逻辑行内容失效或内宽变化时重建。
   *
   * Rule: 滚动、搜索高亮和翻页不改变折行结果，一律复用；否则每次按键的代价都是
   * O(全部上下文文本)，长会话下 /context 会卡到秒级。
   */
  private readonly visualIndex: VisualLineIndex;
  private visualWidth: number | null = null;
  /** `findMatches` 的行视图；`rawText` 在构造后不变，因此只切一次。 */
  private rawLines: string[] | undefined;
  private readonly opts: ScrollableTabOptions;
  readonly name: string;

  constructor(opts: ScrollableTabOptions, name: string = "") {
    this.opts = opts;
    this.name = name;
    this.visualIndex = new VisualLineIndex(opts.displayLines, opts.theme);
  }

  getAboveContentLine(_innerWidth: number): string | null {
    const th = this.opts.theme;
    if (this.searchMode) {
      return ` ${th.fg("accent", "/")} ${this.searchQuery}${th.fg("dim", "▏")}`;
    }
    if (this.searchMatches.length > 0) {
      return ` ${th.fg("accent", "/")} ${th.fg("text", this.searchQuery)} ${th.fg("dim", "—")} ${th.fg("accent", `${this.currentMatchIndex + 1}/${this.searchMatches.length}`)}`;
    }
    if (this.searchQuery.length > 0) {
      return ` ${th.fg("accent", "/")} ${th.fg("text", this.searchQuery)} ${th.fg("dim", "—")} ${th.fg("warning", "无匹配")}`;
    }
    return null;
  }

  getFooterLeft(): string {
    const th = this.opts.theme;
    const total = this.visualTotal();
    const maxScroll = Math.max(0, total - 1);
    const visibleEnd = Math.min(this.scrollOffset + 1, total);

    const scrollPercent =
      total === 0
        ? "全部"
        : this.scrollOffset === 0
          ? "顶部"
          : this.scrollOffset >= maxScroll
            ? "底部"
            : `${Math.round(((this.scrollOffset + 1) / total) * 100)}%`;

    let left = `${visibleEnd}/${total} [${scrollPercent}]`;
    if (this.copyFlash) {
      left += th.fg("success", " 已复制！");
    }
    return left;
  }

  readonly footerHints = "↑↓ 滚动 · / 搜索 · n/N 匹配 · y 复制";

  handleInput(data: string): boolean {
    return this.handleScrollKey(data);
  }

  renderContent(innerWidth: number, height: number): string[] {
    this.ensureVisualLines(innerWidth);
    const th = this.opts.theme;
    const lines: string[] = [];

    const maxScroll = Math.max(0, this.visualTotal() - height);
    this.scrollOffset = Math.min(this.scrollOffset, maxScroll);
    this.scrollOffset = Math.max(0, this.scrollOffset);

    for (let i = 0; i < height; i++) {
      const row = this.visualIndex.rowAt(this.scrollOffset + i);
      if (row) {
        let line = row.text;
        const logicalIdx = row.logicalIndex;
        const isCurrentMatch =
          this.searchMatches.length > 0 &&
          this.currentMatchIndex >= 0 &&
          this.searchMatches[this.currentMatchIndex] === logicalIdx;
        const isOtherMatch = !isCurrentMatch && this.searchMatchSet.has(logicalIdx);

        if (isCurrentMatch) {
          line = th.bg("selectedBg", line);
        } else if (isOtherMatch) {
          line = th.fg("warning", line);
        }

        lines.push(line);
      } else {
        lines.push(th.fg("dim", "~"));
      }
    }

    return lines;
  }

  invalidate(): void {
    this.visualWidth = null;
  }

  private getVisibleLines(): number {
    return this.opts.contentHeight;
  }

  /** 视觉行总数：未建立的部分按块惰性补齐。 */
  private visualTotal(): number {
    return this.visualIndex.totalRows();
  }

  /** 只在内容失效或内宽变化时重建视觉行索引；其余帧直接复用缓存。 */
  private ensureVisualLines(innerWidth: number): void {
    if (this.visualWidth === innerWidth) return;
    this.visualIndex.reset(innerWidth);
    this.visualWidth = innerWidth;
  }

  private handleSearchInput(data: string): boolean {
    if (!this.searchMode) return false;

    if (matchesKey(data, Key.escape)) {
      this.searchMode = false;
      this.searchQuery = "";
      this.searchMatches = [];
      this.searchMatchSet = new Set<number>();
      this.currentMatchIndex = -1;
      return true;
    }
    if (matchesKey(data, Key.enter)) {
      if (this.searchQuery.length > 0) {
        this.findMatches();
        if (this.searchMatches.length > 0) {
          this.currentMatchIndex = 0;
          this.scrollToMatch(this.getVisibleLines());
        }
      }
      this.searchMode = false;
      return true;
    }
    if (matchesKey(data, Key.backspace)) {
      this.searchQuery = this.searchQuery.slice(0, -1);
      this.findMatches();
      if (this.searchMatches.length > 0) {
        this.currentMatchIndex = 0;
        this.scrollToMatch(this.getVisibleLines());
      }
      return true;
    }
    if (data.length === 1 && data.charCodeAt(0) >= 32) {
      this.searchQuery += data;
      this.findMatches();
      if (this.searchMatches.length > 0) {
        this.currentMatchIndex = 0;
        this.scrollToMatch(this.getVisibleLines());
      }
      return true;
    }
    return true;
  }

  private handleScrollKey(data: string): boolean {
    if (this.handleSearchInput(data)) return true;

    const visibleLines = this.getVisibleLines();
    const maxOffset = Math.max(0, this.visualTotal() - visibleLines);

    if (matchesKey(data, Key.down) || data === "j") {
      this.scrollDown(1, maxOffset);
      return true;
    }
    if (matchesKey(data, Key.up) || data === "k") {
      this.scrollUp(1);
      return true;
    }
    if (matchesKey(data, Key.home) || data === "g") {
      this.scrollOffset = 0;
      return true;
    }
    if (matchesKey(data, Key.end) || data === "G") {
      this.scrollToBottom(maxOffset);
      return true;
    }
    if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("f"))) {
      this.scrollDown(visibleLines - 2, maxOffset);
      return true;
    }
    if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("b"))) {
      this.scrollUp(visibleLines - 2);
      return true;
    }
    if (matchesKey(data, Key.ctrl("d"))) {
      this.scrollDown(Math.floor(visibleLines / 2), maxOffset);
      return true;
    }
    if (matchesKey(data, Key.ctrl("u"))) {
      this.scrollUp(Math.floor(visibleLines / 2));
      return true;
    }
    if (data === "/") {
      this.searchMode = true;
      this.searchQuery = "";
      this.searchMatches = [];
      this.searchMatchSet = new Set<number>();
      this.currentMatchIndex = -1;
      return true;
    }
    if (data === "n") {
      this.nextMatch();
      return true;
    }
    if (data === "N") {
      this.prevMatch();
      return true;
    }
    if (data === "y") {
      void this.copyToClipboard();
      return true;
    }

    return false;
  }

  private findMatches(): void {
    const query = this.searchQuery.toLowerCase();
    this.searchMatches = [];
    this.searchMatchSet = new Set<number>();
    if (query.length === 0) {
      this.currentMatchIndex = -1;
      return;
    }
    // Rule: 文本在构造后不变，行视图只切一次；每个搜索按键的代价与行数线性相关，不再重复分配。
    this.rawLines ??= this.opts.rawText.split("\n");
    for (let i = 0; i < this.rawLines.length; i++) {
      if (this.rawLines[i]!.toLowerCase().includes(query)) {
        this.searchMatches.push(i);
        this.searchMatchSet.add(i);
      }
    }
  }

  private scrollToMatch(visibleLines: number): void {
    if (this.currentMatchIndex >= 0 && this.currentMatchIndex < this.searchMatches.length) {
      const logicalLine = this.searchMatches[this.currentMatchIndex]!;
      const targetLine = this.visualIndex.firstRowOfLogical(logicalLine);
      if (targetLine >= 0) {
        if (targetLine < this.scrollOffset || targetLine >= this.scrollOffset + visibleLines) {
          this.scrollOffset = Math.max(0, targetLine - Math.floor(visibleLines / 3));
        }
      }
    }
  }

  private nextMatch(): void {
    if (this.searchMatches.length === 0) return;
    this.currentMatchIndex = (this.currentMatchIndex + 1) % this.searchMatches.length;
    this.scrollToMatch(this.getVisibleLines());
  }

  private prevMatch(): void {
    if (this.searchMatches.length === 0) return;
    this.currentMatchIndex = (this.currentMatchIndex - 1 + this.searchMatches.length) % this.searchMatches.length;
    this.scrollToMatch(this.getVisibleLines());
  }

  private async copyToClipboard(): Promise<void> {
    this.copyFlash = true;
    try {
      await copyTextToClipboard(this.opts.rawText);
    } catch {
      // Failure: 剪贴板工具缺失时保持静默，不打断查看。
    }
    clearTimeout(this.copyFlashTimer);
    this.copyFlashTimer = setTimeout(() => {
      this.copyFlash = false;
    }, 1500);
  }

  private scrollDown(amount: number, maxOffset: number): void {
    this.scrollOffset = Math.min(this.scrollOffset + amount, maxOffset);
  }

  private scrollUp(amount: number): void {
    this.scrollOffset = Math.max(0, this.scrollOffset - amount);
  }

  private scrollToBottom(maxOffset: number): void {
    this.scrollOffset = Math.max(0, maxOffset);
  }
}
