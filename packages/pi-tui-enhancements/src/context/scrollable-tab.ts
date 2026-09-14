/**
 * 可滚动标签页：行号、vim 风格滚动、实时搜索、剪贴板复制。
 *
 * Flow: 渲染时先按显示宽度把逻辑行拆成视觉行，再按滚动偏移取窗口；
 * 搜索匹配按逻辑行记录，滚动时换算回视觉行。
 */

import { copyToClipboard as copyTextToClipboard } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, sliceByColumn, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { UiTheme, WidthUtils } from "./frame.ts";

export interface ScrollableTabOptions {
  rawText: string;
  displayLines: string[];
  theme: UiTheme;
  widthUtils: WidthUtils;
  contentHeight: number;
}

export class ScrollableTabContent {
  private scrollOffset = 0;
  private searchMode = false;
  private searchQuery = "";
  private searchMatches: number[] = [];
  private currentMatchIndex = -1;
  private copyFlash = false;
  private copyFlashTimer: ReturnType<typeof setTimeout> | undefined;
  private visualLines: string[] = [];
  private visualToLogical: number[] = [];
  private visualTotal = 0;
  private readonly opts: ScrollableTabOptions;
  readonly name: string;

  constructor(opts: ScrollableTabOptions, name: string = "") {
    this.opts = opts;
    this.name = name;
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
    const total = this.visualTotal > 0 ? this.visualTotal : this.opts.displayLines.length;
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
    this.buildVisualLines(innerWidth);
    const th = this.opts.theme;
    const lines: string[] = [];

    const maxScroll = Math.max(0, this.visualTotal - height);
    this.scrollOffset = Math.min(this.scrollOffset, maxScroll);
    this.scrollOffset = Math.max(0, this.scrollOffset);

    for (let i = 0; i < height; i++) {
      const lineIdx = this.scrollOffset + i;
      if (lineIdx < this.visualTotal) {
        let line = this.visualLines[lineIdx]!;

        const logicalIdx = this.visualToLogical[lineIdx]!;
        const isCurrentMatch =
          this.searchMatches.length > 0 &&
          this.currentMatchIndex >= 0 &&
          this.searchMatches[this.currentMatchIndex] === logicalIdx;
        const isOtherMatch =
          this.searchMatches.length > 0 && this.searchMatches.includes(logicalIdx) && !isCurrentMatch;

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
    this.visualLines = [];
    this.visualToLogical = [];
    this.visualTotal = 0;
  }

  private getVisibleLines(): number {
    return this.opts.contentHeight;
  }

  /** 把逻辑行按显示宽度拆成视觉行，续行使用对齐的占位前缀。 */
  private buildVisualLines(innerWidth: number): void {
    const th = this.opts.theme;
    const total = this.opts.displayLines.length;
    const numWidth = String(total).length;
    const prefixWidth = numWidth + 3;
    const continuationPrefix = th.fg("dim", " ".repeat(numWidth) + " · ");

    this.visualLines = [];
    this.visualToLogical = [];

    for (let logicalIdx = 0; logicalIdx < total; logicalIdx++) {
      const displayLine = this.opts.displayLines[logicalIdx]!;
      const lineWidth = visibleWidth(displayLine);

      if (lineWidth <= innerWidth) {
        this.visualLines.push(displayLine);
        this.visualToLogical.push(logicalIdx);
        continue;
      }

      const contentMaxWidth = Math.max(1, innerWidth - prefixWidth);
      const origPrefix = sliceByColumn(displayLine, 0, prefixWidth);
      const content = sliceByColumn(displayLine, prefixWidth, lineWidth - prefixWidth);
      const wrapped = wrapTextWithAnsi(content, contentMaxWidth);

      for (let w = 0; w < wrapped.length; w++) {
        this.visualLines.push(w === 0 ? origPrefix + wrapped[w]! : continuationPrefix + wrapped[w]!);
        this.visualToLogical.push(logicalIdx);
      }
    }

    this.visualTotal = this.visualLines.length;
  }

  private handleSearchInput(data: string): boolean {
    if (!this.searchMode) return false;

    if (matchesKey(data, Key.escape)) {
      this.searchMode = false;
      this.searchQuery = "";
      this.searchMatches = [];
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
    const maxOffset = Math.max(0, this.visualTotal - visibleLines);

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
    const rawLines = this.opts.rawText.split("\n");
    this.searchMatches = [];
    if (query.length === 0) {
      this.currentMatchIndex = -1;
      return;
    }
    for (let i = 0; i < rawLines.length; i++) {
      if (rawLines[i]!.toLowerCase().includes(query)) {
        this.searchMatches.push(i);
      }
    }
  }

  private scrollToMatch(visibleLines: number): void {
    if (this.currentMatchIndex >= 0 && this.currentMatchIndex < this.searchMatches.length) {
      const logicalLine = this.searchMatches[this.currentMatchIndex]!;
      const targetLine = this.visualToLogical.indexOf(logicalLine);
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
