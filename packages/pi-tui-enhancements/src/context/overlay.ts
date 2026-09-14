/**
 * 带标签栏的上下文查看弹窗。
 *
 * Flow: 顶部标题与标签栏、内容区、页脚共用同一个宽度安全的边框排版；
 * 内容行先裁剪再补齐，任何超宽文本都不会把边框挤到下一行。
 */

import { Key, matchesKey } from "@earendil-works/pi-tui";
import { frameBottom, frameRow, frameSeparator, frameTop, type UiTheme, type WidthUtils } from "./frame.ts";

/**
 * 每个标签页的输入契约：`handleInput` 返回 true 表示按键已被消费，
 * 外层不再处理（例如搜索模式下 Escape 只退出搜索而不关闭弹窗）。
 */
export interface TabContent {
  readonly name: string;
  getAboveContentLine(innerWidth: number): string | null;
  renderContent(innerWidth: number, height: number): string[];
  getFooterLeft(): string;
  readonly footerHints: string;
  handleInput(data: string): boolean;
  invalidate(): void;
}

export interface TabbedOverlayOptions {
  title: string;
  subtitle: string;
  tabs: TabContent[];
  theme: UiTheme;
  widthUtils: WidthUtils;
  contentHeight: number;
  done: () => void;
}

export class TabbedOverlay {
  private activeTabIndex = 0;
  private readonly opts: TabbedOverlayOptions;

  constructor(opts: TabbedOverlayOptions) {
    this.opts = opts;
  }

  private get activeTab(): TabContent {
    return this.opts.tabs[this.activeTabIndex]!;
  }

  handleInput(data: string): void {
    // Tab / Shift+Tab 始终用于切换标签页，不交给内容区处理。
    if (matchesKey(data, Key.tab)) {
      this.activeTabIndex = (this.activeTabIndex + 1) % this.opts.tabs.length;
      return;
    }
    if (matchesKey(data, Key.shift("tab"))) {
      this.activeTabIndex = (this.activeTabIndex - 1 + this.opts.tabs.length) % this.opts.tabs.length;
      return;
    }

    const consumed = this.activeTab.handleInput(data);
    if (consumed) return;

    if (matchesKey(data, Key.escape) || data === "q") {
      this.opts.done();
    }
  }

  render(width: number): string[] {
    const th = this.opts.theme;
    const widthUtils = this.opts.widthUtils;
    const innerW = Math.max(1, width - 2);
    const contentHeight = this.opts.contentHeight;
    const lines: string[] = [];

    lines.push(frameTop(innerW, th));
    lines.push(frameRow(this.titleLine(), innerW, th, widthUtils));
    lines.push(frameRow(this.tabBar(), innerW, th, widthUtils));

    const aboveLine = this.activeTab.getAboveContentLine(innerW);
    if (aboveLine !== null) {
      lines.push(frameRow(` ${aboveLine}`, innerW, th, widthUtils));
    } else {
      lines.push(frameSeparator(innerW, th));
    }

    const contentLines = this.activeTab.renderContent(innerW, contentHeight);
    for (let i = 0; i < contentHeight; i++) {
      const line = i < contentLines.length ? contentLines[i]! : th.fg("dim", "~");
      lines.push(frameRow(line, innerW, th, widthUtils));
    }

    lines.push(frameSeparator(innerW, th));
    lines.push(frameRow(this.footerLine(innerW), innerW, th, widthUtils));
    lines.push(frameBottom(innerW, th));

    return lines;
  }

  invalidate(): void {
    for (const tab of this.opts.tabs) {
      tab.invalidate();
    }
  }

  private titleLine(): string {
    const th = this.opts.theme;
    return ` ${th.fg("accent", th.bold(this.opts.title))}  ${th.fg("dim", `(${this.opts.subtitle})`)}`;
  }

  private tabBar(): string {
    const th = this.opts.theme;
    let tabBar = " ";
    for (let i = 0; i < this.opts.tabs.length; i++) {
      const tab = this.opts.tabs[i]!;
      if (i === this.activeTabIndex) {
        tabBar += th.fg("accent", th.bold(`[${tab.name}]`));
      } else {
        tabBar += th.fg("muted", `[${tab.name}]`);
      }
      if (i < this.opts.tabs.length - 1) tabBar += " ";
    }
    return tabBar;
  }

  /** Rule: 页脚从完整提示开始逐级降级，避免在窄弹窗里把提示词裁成半截。 */
  private footerLine(innerWidth: number): string {
    const th = this.opts.theme;
    const footerLeft = this.activeTab.getFooterLeft();
    const hints = ["Tab 切换", this.activeTab.footerHints, "q 关闭"].filter(Boolean).join(" · ");
    const candidates = [
      footerLeft ? `${th.fg("dim", ` ${footerLeft}  `)}${th.fg("dim", hints)}` : th.fg("dim", hints),
      th.fg("dim", hints),
      th.fg("dim", ["Tab 切换", "q 关闭"].join(" · ")),
      th.fg("dim", "q 关闭"),
    ];
    return (
      candidates.find((candidate) => this.opts.widthUtils.visibleWidth(candidate) <= innerWidth) ??
      candidates[candidates.length - 1]!
    );
  }
}
