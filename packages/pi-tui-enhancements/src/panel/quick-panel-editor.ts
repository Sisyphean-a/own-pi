import {
  CustomEditor,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  type EditorTheme,
  Key,
  matchesKey,
  type TUI,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { isCommandPaletteShortcut } from "./command-palette.ts";
import type { ThinkingState } from "./thinking-state.ts";

type BorderStatusIndicator = NonNullable<Parameters<CustomEditor["setWorkingStatusIndicator"]>[0]>;
type Paint = (text: string) => string;

/** 编辑器可选注入：`thinking` 决定呼吸图标是否出现（缺省视为不在思考）。 */
export type QuickPanelEditorExtras = {
  thinking?: ThinkingState;
};

// Rule: 内嵌的工作状态后面跟着一个无文案的呼吸图标，仅在模型生成（思考）期间显示。
// 帧索引由渲染时刻推导，重绘沿用 Pi Loader 自身的帧计时器（默认 80ms，每帧会 requestRender），
// 因此本扩展不额外持有定时器，状态清除时自然停帧。
// Effect: 字形颜色直接读 `editor.borderColor`——Pi 在 `thinking_level_changed` 时原地更新它
// （与输入框边框、Pi 自带 spinner 同源），所以图标自动跟随当前思考等级，无需自己跟踪等级。
const THINKING_GLYPHS = ["✻", "✢", "✶", "✷", "✸", "✷", "✶", "✢"] as const;
const FRAME_INTERVAL_MS = 125;
/** 空格 + 字形占用的固定列数。 */
const GLYPH_CELLS = 2;

function thinkingGlyph(nowMs: number, paint: Paint): string {
  const index = Math.floor(nowMs / FRAME_INTERVAL_MS) % THINKING_GLYPHS.length;
  return paint(THINKING_GLYPHS[index < 0 ? index + THINKING_GLYPHS.length : index]);
}

// Guarantee: 图标先占 2 列再交给 Pi 排版，整行不会超出给定宽度；状态文本为空或图标放不下时
// 保持原样，让 CustomEditor 继续走它自己的回退分支。
function withThinkingGlyph(
  indicator: BorderStatusIndicator,
  paint: Paint,
  thinking?: ThinkingState,
): BorderStatusIndicator {
  const appendGlyph = (text: string, width: number): string => {
    if (text.length === 0 || !thinking?.isActive()) return text;
    const glyph = ` ${thinkingGlyph(Date.now(), paint)}`;
    return visibleWidth(text) + visibleWidth(glyph) <= width ? text + glyph : text;
  };
  const wrapper = Object.create(indicator) as BorderStatusIndicator;
  wrapper.renderInBorder = (width: number) =>
    appendGlyph(indicator.renderInBorder(Math.max(1, width - GLYPH_CELLS)), width);
  wrapper.renderSpinnerInBorder = (width: number) =>
    appendGlyph(indicator.renderSpinnerInBorder(Math.max(1, width - GLYPH_CELLS)), width);
  return wrapper;
}

export class QuickPanelEditor extends CustomEditor {
  // 显式字段而非参数属性：node --test 的 TS 剥离不支持参数属性（Pi 运行时用 jiti，两者都可）。
  private readonly openPanel: () => void;
  private readonly openCommandPalette: (editor: QuickPanelEditor) => void;
  private readonly thinking?: ThinkingState;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    openPanel: () => void,
    openCommandPalette: (editor: QuickPanelEditor) => void = () => {},
    extras: QuickPanelEditorExtras = {},
  ) {
    // Rule: 启用 embedWorkingStatus 后，Pi 把 working、重试、压缩等状态画进输入框上边框，
    // 不再另起一行独立状态行；Pi 只在编辑器暴露 embedWorkingStatus === true 且实现
    // setWorkingStatusIndicator 时才走内嵌路径，否则回退到输入框上方的独立状态行。
    super(tui, theme, keybindings, { embedWorkingStatus: true });
    this.openPanel = openPanel;
    this.openCommandPalette = openCommandPalette;
    this.thinking = extras.thinking;
  }

  // Effect: Pi 设置内嵌状态时包一层，让上边框在状态文本后多出一个呼吸图标。
  setWorkingStatusIndicator(indicator?: BorderStatusIndicator): void {
    // 每帧读 `this.borderColor`，因此思考等级变化（Pi 原地改这个字段）会立刻反映到图标颜色。
    const paint: Paint = (text) => (this.borderColor ?? ((value: string) => value))(text);
    super.setWorkingStatusIndicator(indicator ? withThinkingGlyph(indicator, paint, this.thinking) : undefined);
  }

  submitCommand(command: string): void {
    const name = command.trim().replace(/^\/+/, "");
    if (!name) return;

    const text = `/${name}`;
    // Effect: 复用 Pi 已绑定的提交处理器，不复制内置命令逻辑；先清空编辑器与 Enter 提交流程一致。
    this.setText("");
    this.onSubmit?.(text);
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.ctrl("l"))) {
      this.openPanel();
      return;
    }

    if (isCommandPaletteShortcut(data)) {
      this.openCommandPalette(this);
      return;
    }

    // 首字符 `/` 由自定义命令面板接管，避免 Pi 原生 autocomplete 栏先出现。
    if (this.getText().length === 0 && matchesKey(data, Key.slash)) {
      this.openCommandPalette(this);
      return;
    }

    super.handleInput(data);
  }
}
