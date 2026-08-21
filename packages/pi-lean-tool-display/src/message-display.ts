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
type UserMessagePatch = { originalRender: UserMessagePrototype["render"] };
type ThinkingPatch = {
  originalUpdateContent: AssistantMessagePrototype["updateContent"];
  originalSetHiddenThinkingLabel: AssistantMessagePrototype["setHiddenThinkingLabel"];
};

const LEGACY_USER_PATCH = Symbol.for("pi.lean-tool-display.user-message.v1");
const USER_PATCH = Symbol.for("pi.lean-tool-display.user-message.v2");
const LEGACY_THINKING_PATCH = Symbol.for("pi.lean-tool-display.thinking.v1");
const THINKING_PATCH = Symbol.for("pi.lean-tool-display.thinking.v2");
const THINKING_STATE = Symbol.for("pi.lean-tool-display.thinking-state.v1");
const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const OSC133_PATTERN = /\x1b\]133;[ABC](?:\x07|\x1b\\)/g;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stripControlSequences(line: string): string {
  return line.replace(OSC133_PATTERN, "").replace(ANSI_PATTERN, "");
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

  prototype.render = function renderLeanUserMessage(this: UserMessageComponent, width: number): string[] {
    const theme = (globalThis as { __piLeanTheme?: Theme }).__piLeanTheme;
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

export function getThinkingState(): ThinkingDisplayState {
  const prototype = AssistantMessageComponent.prototype as unknown as Patched<AssistantMessagePrototype>;
  const existing = prototype[THINKING_STATE] as ThinkingDisplayState | undefined;
  if (existing) return existing;

  const state: ThinkingDisplayState = { collapsed: true };
  prototype[THINKING_STATE] = state;
  return state;
}

export function getThinkingLabel(collapsed: boolean): string {
  return collapsed ? "Thinking... (Ctrl+Shift+T expand)" : "Thinking...";
}

/**
 * Effect: makes the display-only thinking preference apply to historical and streaming assistant rows.
 * Guarantee: the original message remains intact for context and can be shown again without data loss.
 *
 * Effect: pi 的 setHiddenThinkingLabel 会被 interactive mode 广播到所有已渲染消息组件,
 * 在此同步 hideThinkingBlock,使 toggle 即时展开/折叠历史消息,而不只改变标签文本。
 */
export function installThinkingCollapse(): void {
  const prototype = AssistantMessageComponent.prototype as unknown as Patched<AssistantMessagePrototype>;
  const previousPatch = prototype[THINKING_PATCH] as ThinkingPatch | undefined;
  if (previousPatch) return;

  const legacyPatch = prototype[LEGACY_THINKING_PATCH] as
    | { originalUpdateContent?: AssistantMessagePrototype["updateContent"] }
    | undefined;
  const originalUpdateContent = legacyPatch?.originalUpdateContent ?? prototype.updateContent;
  const originalSetHiddenThinkingLabel = prototype.setHiddenThinkingLabel;

  prototype.updateContent = function updateLeanThinking(
    this: AssistantComponent,
    message: unknown,
    isStreaming?: boolean,
  ): void {
    this.hideThinkingBlock = getThinkingState().collapsed;
    originalUpdateContent.call(this, message, isStreaming);
  };

  prototype.setHiddenThinkingLabel = function setLeanHiddenThinkingLabel(
    this: AssistantComponent,
    label: string,
  ): void {
    this.hideThinkingBlock = getThinkingState().collapsed;
    originalSetHiddenThinkingLabel.call(this, label);
  };

  prototype[THINKING_PATCH] = {
    originalUpdateContent,
    originalSetHiddenThinkingLabel,
  } satisfies ThinkingPatch;
}

export function setThinkingCollapsed(
  ctx: { ui: { setHiddenThinkingLabel(label?: string): void } },
  collapsed: boolean,
): void {
  getThinkingState().collapsed = collapsed;
  ctx.ui.setHiddenThinkingLabel(getThinkingLabel(collapsed));
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
