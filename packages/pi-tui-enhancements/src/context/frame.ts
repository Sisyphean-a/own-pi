/**
 * 上下文查看弹窗的边框与宽度安全排版。
 *
 * Rule: 每一行先按显示宽度裁剪再补齐空格，中文字符、长路径或 ANSI 颜色都不会撑破边框导致换行错位。
 */

export type UiTheme = {
  bold(text: string): string;
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
};

export type WidthUtils = {
  visibleWidth(text: string): number;
  truncateToWidth(text: string, width: number, ellipsis?: string): string;
};

export const MAX_CONTENT_HEIGHT = 28;
export const MIN_CONTENT_HEIGHT = 4;
/** 顶框、标题、标签栏、分隔线、内容分隔线、页脚、底框。 */
export const FRAME_CHROME_HEIGHT = 7;

/** 与快捷面板一致的 80%/70% 覆盖层尺寸，并按终端行数换算可用内容高度。 */
export const OVERLAY_OPTIONS = {
  overlay: true,
  overlayOptions: {
    width: "80%" as const,
    minWidth: 64,
    maxHeight: "70%" as const,
    margin: 1,
  },
};

export function overlayContentHeight(terminalRows: number): number {
  const maxHeight = Math.max(1, Math.min(Math.floor(terminalRows * 0.7), terminalRows - 2));
  return Math.max(MIN_CONTENT_HEIGHT, Math.min(MAX_CONTENT_HEIGHT, maxHeight - FRAME_CHROME_HEIGHT));
}

/** Guarantee: 返回值恰好占 innerWidth 列，超出部分被裁剪而不是折行。 */
export function frameRow(content: string, innerWidth: number, theme: UiTheme, widthUtils: WidthUtils): string {
  const clipped = widthUtils.truncateToWidth(content, Math.max(0, innerWidth), "");
  const padding = " ".repeat(Math.max(0, innerWidth - widthUtils.visibleWidth(clipped)));
  return theme.fg("border", "│") + clipped + padding + theme.fg("border", "│");
}

export function frameTop(innerWidth: number, theme: UiTheme): string {
  return theme.fg("border", `╭${"─".repeat(Math.max(0, innerWidth))}╮`);
}

export function frameSeparator(innerWidth: number, theme: UiTheme): string {
  return theme.fg("border", `├${"─".repeat(Math.max(0, innerWidth))}┤`);
}

export function frameBottom(innerWidth: number, theme: UiTheme): string {
  return theme.fg("border", `╰${"─".repeat(Math.max(0, innerWidth))}╯`);
}
