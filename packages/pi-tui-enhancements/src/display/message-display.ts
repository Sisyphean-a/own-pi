import {
  AssistantMessageComponent,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export type Theme = {
  bold(text: string): string;
  fg(color: string, text: string): string;
};

type Patched<T> = T & Record<PropertyKey, unknown>;
type AssistantComponent = {
  hideThinkingBlock: boolean;
  hiddenThinkingLabel: string;
  lastMessage?: unknown;
  isStreaming: boolean;
  updateContent(message: unknown, isStreaming?: boolean): void;
};
type AssistantMessagePrototype = {
  updateContent(this: AssistantComponent, message: unknown, isStreaming?: boolean): void;
  setHiddenThinkingLabel(this: AssistantComponent, label: string): void;
};
type UserMessagePrototype = {
  render(this: UserMessageComponent, width: number): string[];
};
type AssistantContent = { type?: string; thinking?: unknown };
export type AssistantMessage = { role?: unknown; content?: AssistantContent[]; api?: unknown };
type ThinkingDisplayState = { collapsed: boolean };
type ThinkingLabelTarget = { ui: { setHiddenThinkingLabel(label?: string): void } };
type ThemeCache = { __piTuiTheme?: Theme };
type UserMessagePatch = { originalRender: UserMessagePrototype["render"] };
type ThinkingPatch = {
  originalUpdateContent: AssistantMessagePrototype["updateContent"];
  originalSetHiddenThinkingLabel: AssistantMessagePrototype["setHiddenThinkingLabel"];
};

const LEGACY_USER_PATCH = Symbol.for("pi.lean-tool-display.user-message.v1");
const USER_PATCH = Symbol.for("pi.lean-tool-display.user-message.v2");
const LEGACY_THINKING_PATCH_V1 = Symbol.for("pi.lean-tool-display.thinking.v1");
const LEGACY_THINKING_PATCH_V2 = Symbol.for("pi.lean-tool-display.thinking.v2");
const THINKING_PATCH = Symbol.for("pi.lean-tool-display.thinking.v3");
const THINKING_STATE = Symbol.for("pi.lean-tool-display.thinking-state.v1");
const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const OSC133_PATTERN = /\x1b\]133;[ABC](?:\x07|\x1b\\)/g;

/**
 * 会话主题缓存：渲染补丁没有 ctx，只能从进程级缓存取当前主题。
 *
 * Rule: 只有本模块读写该缓存；会话开始时由 display 会话写入。
 */
export function setDisplayTheme(theme: Theme): void {
  (globalThis as ThemeCache).__piTuiTheme = theme;
}

function displayTheme(): Theme | undefined {
  return (globalThis as ThemeCache).__piTuiTheme;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stripControlSequences(line: string): string {
  return line.replace(OSC133_PATTERN, "").replace(ANSI_PATTERN, "");
}

function withoutThinkingForDisplay(message: unknown): unknown {
  const record = asRecord(message);
  if (!Array.isArray(record.content)) return message;
  const content = record.content.filter((block) => asRecord(block).type !== "thinking");
  return content.length === record.content.length ? message : { ...record, content };
}

function makeUserBorder(theme: Theme, width: number): string {
  const titleText = " user ";
  const title = theme.fg("accent", theme.bold(titleText));
  const fillWidth = Math.max(0, width - 2 - visibleWidth(titleText));
  return theme.fg("border", "╭") + title + theme.fg("border", `${"─".repeat(fillWidth)}╮`);
}

function frameUserMessage(lines: string[], width: number, theme: Theme): string[] {
  const contentWidth = Math.max(1, width - 4);
  const sourceLines = lines.map(stripControlSequences).filter((line) => line.trim().length > 0);
  const wrappedLines = (sourceLines.length > 0 ? sourceLines : [""])
    .flatMap((line) => wrapTextWithAnsi(line, contentWidth))
    .map((line) => truncateToWidth(line, contentWidth, ""));
  const frame = [makeUserBorder(theme, width)];

  for (const line of wrappedLines) {
    const text = truncateToWidth(line, contentWidth, "");
    const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(text)));
    frame.push(theme.fg("border", "│") + ` ${text}${padding} ` + theme.fg("border", "│"));
  }

  frame.push(theme.fg("border", `╰${"─".repeat(Math.max(0, width - 2))}╯`));
  return frame;
}

export function installCompactUserMessage(): void {
  const prototype = UserMessageComponent.prototype as unknown as Patched<UserMessagePrototype>;
  const previousPatch = prototype[USER_PATCH] as UserMessagePatch | undefined;
  if (!previousPatch && prototype[LEGACY_USER_PATCH]) return;
  const originalRender = previousPatch?.originalRender ?? prototype.render;

  prototype.render = function renderCompactUserMessage(this: UserMessageComponent, width: number): string[] {
    const theme = displayTheme();
    if (!theme || width < 12) return originalRender.call(this, width);

    const contentWidth = width - 4;
    const lines = originalRender.call(this, width - 2)
      .map(stripControlSequences)
      .filter((line) => line.trim().length > 0)
      .map((line) => truncateToWidth(line.slice(1), contentWidth, ""));
    return frameUserMessage(lines, width, theme);
  };
  prototype[USER_PATCH] = { originalRender } satisfies UserMessagePatch;
}

function getThinkingState(): ThinkingDisplayState {
  const prototype = AssistantMessageComponent.prototype as unknown as Patched<AssistantMessagePrototype>;
  const existing = prototype[THINKING_STATE] as ThinkingDisplayState | undefined;
  if (existing) return existing;

  const state: ThinkingDisplayState = { collapsed: true };
  prototype[THINKING_STATE] = state;
  return state;
}

function getThinkingLabel(collapsed: boolean): string {
  return collapsed ? "" : "Thinking...";
}

/**
 * Effect: collapsed thinking blocks are removed from historical and streaming assistant rows,
 * including the spacer that Pi normally keeps for a hidden label.
 * Guarantee: the original message remains intact for context and can be shown again without data loss.
 *
 * Effect: pi 的 setHiddenThinkingLabel 会被 interactive mode 广播到所有已渲染消息组件，
 * 在此同步显示状态并用原始消息重建内容，使 toggle 即时展开或彻底隐藏历史思考。
 */
export function installThinkingCollapse(): void {
  const prototype = AssistantMessageComponent.prototype as unknown as Patched<AssistantMessagePrototype>;
  const previousPatch = prototype[THINKING_PATCH] as ThinkingPatch | undefined;
  if (previousPatch) return;

  const legacyPatchV2 = prototype[LEGACY_THINKING_PATCH_V2] as ThinkingPatch | undefined;
  const legacyPatchV1 = prototype[LEGACY_THINKING_PATCH_V1] as
    | { originalUpdateContent?: AssistantMessagePrototype["updateContent"] }
    | undefined;
  const originalUpdateContent = legacyPatchV2?.originalUpdateContent
    ?? legacyPatchV1?.originalUpdateContent
    ?? prototype.updateContent;
  const originalSetHiddenThinkingLabel = legacyPatchV2?.originalSetHiddenThinkingLabel
    ?? prototype.setHiddenThinkingLabel;

  prototype.updateContent = function updateLeanThinking(
    this: AssistantComponent,
    message: unknown,
    isStreaming?: boolean,
  ): void {
    const collapsed = getThinkingState().collapsed;
    this.hideThinkingBlock = collapsed;
    originalUpdateContent.call(this, collapsed ? withoutThinkingForDisplay(message) : message, isStreaming);
    // Guarantee: keep the unmodified source for theme invalidation and later expansion.
    this.lastMessage = message;
  };

  prototype.setHiddenThinkingLabel = function setLeanHiddenThinkingLabel(
    this: AssistantComponent,
    label: string,
  ): void {
    this.hiddenThinkingLabel = label;
    this.hideThinkingBlock = getThinkingState().collapsed;
    if (this.lastMessage) this.updateContent(this.lastMessage, this.isStreaming);
  };

  prototype[THINKING_PATCH] = {
    originalUpdateContent,
    originalSetHiddenThinkingLabel,
  } satisfies ThinkingPatch;
}

/** 把当前折叠状态同步到 Pi 的隐藏思考标签（会话开始或重载后）。 */
export function syncThinkingLabel(ctx: ThinkingLabelTarget): void {
  ctx.ui.setHiddenThinkingLabel(getThinkingLabel(getThinkingState().collapsed));
}

/** 切换思考折叠：状态与动作同属本模块，调用方不用自己取状态再取反。 */
export function toggleThinking(ctx: ThinkingLabelTarget): void {
  const state = getThinkingState();
  state.collapsed = !state.collapsed;
  ctx.ui.setHiddenThinkingLabel(getThinkingLabel(state.collapsed));
}

export function isAssistantMessage(value: unknown): value is AssistantMessage {
  return Boolean(value && typeof value === "object" && asRecord(value).role === "assistant");
}

export function labelThinking(message: AssistantMessage, theme: Theme): void {
  for (const block of message.content ?? []) {
    if (block.type !== "thinking" || typeof block.thinking !== "string") continue;
    const plain = block.thinking.replace(ANSI_PATTERN, "").replace(/^Thinking:\s*/i, "").trim();
    if (plain) {
      block.thinking = `${theme.fg("accent", "Thinking:")} ${theme.fg("thinkingText", plain)}`;
    }
  }
}

export function sanitizeThinking<T>(messages: T[]): T[] {
  return messages.map((message) => {
    if (!isAssistantMessage(message)) return message;
    const content = (message.content ?? []).map((block) => {
      if (block.type !== "thinking" || typeof block.thinking !== "string") return block;
      return {
        ...block,
        thinking: block.thinking.replace(ANSI_PATTERN, "").replace(/^Thinking:\s*/i, "").trim(),
      };
    });
    return { ...message, content } as T;
  });
}
