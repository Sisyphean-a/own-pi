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
type ThinkingDisplayState = { automatic: boolean };
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
const LEGACY_THINKING_PATCH_V3 = Symbol.for("pi.lean-tool-display.thinking.v3");
const THINKING_PATCH = Symbol.for("pi.lean-tool-display.thinking.v4");
const THINKING_STATE = Symbol.for("pi.lean-tool-display.thinking-state.v2");
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

function withoutPastThinkingForDisplay(message: unknown, isStreaming: boolean): unknown {
  const record = asRecord(message);
  if (!Array.isArray(record.content)) return message;
  let lastNonThinking = -1;
  for (let index = record.content.length - 1; index >= 0; index--) {
    if (asRecord(record.content[index]).type !== "thinking") {
      lastNonThinking = index;
      break;
    }
  }
  const content = record.content.filter((block, index) =>
    asRecord(block).type !== "thinking" || (isStreaming && index > lastNonThinking));
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

  const state: ThinkingDisplayState = { automatic: true };
  prototype[THINKING_STATE] = state;
  return state;
}

function getThinkingLabel(automatic: boolean): string {
  return automatic ? "" : "Thinking...";
}

/**
 * Rule: 自动模式只显示流式消息末尾尚未接续正文或工具调用的思考；结束后全部隐藏。
 * Guarantee: 只过滤渲染副本，原始消息仍可通过快捷键展开，且不影响模型上下文。
 * Effect: Pi 广播 setHiddenThinkingLabel 时，用原始消息重建所有已渲染组件。
 */
export function installThinkingCollapse(): void {
  const prototype = AssistantMessageComponent.prototype as unknown as Patched<AssistantMessagePrototype>;
  const previousPatch = prototype[THINKING_PATCH] as ThinkingPatch | undefined;
  if (previousPatch) return;

  const legacyPatchV3 = prototype[LEGACY_THINKING_PATCH_V3] as ThinkingPatch | undefined;
  const legacyPatchV2 = prototype[LEGACY_THINKING_PATCH_V2] as ThinkingPatch | undefined;
  const legacyPatchV1 = prototype[LEGACY_THINKING_PATCH_V1] as
    | { originalUpdateContent?: AssistantMessagePrototype["updateContent"] }
    | undefined;
  const originalUpdateContent = legacyPatchV3?.originalUpdateContent
    ?? legacyPatchV2?.originalUpdateContent
    ?? legacyPatchV1?.originalUpdateContent
    ?? prototype.updateContent;
  const originalSetHiddenThinkingLabel = legacyPatchV3?.originalSetHiddenThinkingLabel
    ?? legacyPatchV2?.originalSetHiddenThinkingLabel
    ?? prototype.setHiddenThinkingLabel;

  prototype.updateContent = function updateLeanThinking(
    this: AssistantComponent,
    message: unknown,
    isStreaming?: boolean,
  ): void {
    const automatic = getThinkingState().automatic;
    this.hideThinkingBlock = false;
    originalUpdateContent.call(this,
      automatic ? withoutPastThinkingForDisplay(message, isStreaming ?? this.isStreaming) : message,
      isStreaming);
    // Guarantee: keep the unmodified source for theme invalidation and later expansion.
    this.lastMessage = message;
  };

  prototype.setHiddenThinkingLabel = function setLeanHiddenThinkingLabel(
    this: AssistantComponent,
    label: string,
  ): void {
    this.hiddenThinkingLabel = label;
    this.hideThinkingBlock = false;
    if (this.lastMessage) this.updateContent(this.lastMessage, this.isStreaming);
  };

  prototype[THINKING_PATCH] = {
    originalUpdateContent,
    originalSetHiddenThinkingLabel,
  } satisfies ThinkingPatch;
}

/** 同步自动隐藏或手动展开模式（会话开始或重载后）。 */
export function syncThinkingLabel(ctx: ThinkingLabelTarget): void {
  ctx.ui.setHiddenThinkingLabel(getThinkingLabel(getThinkingState().automatic));
}

/** 在自动显示当前思考与手动展开全部思考之间切换。 */
export function toggleThinking(ctx: ThinkingLabelTarget): void {
  const state = getThinkingState();
  state.automatic = !state.automatic;
  ctx.ui.setHiddenThinkingLabel(getThinkingLabel(state.automatic));
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
