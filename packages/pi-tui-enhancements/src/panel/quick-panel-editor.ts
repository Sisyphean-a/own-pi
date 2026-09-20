import {
  CustomEditor,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  type EditorTheme,
  Key,
  matchesKey,
  type TUI,
} from "@earendil-works/pi-tui";
import { isCommandPaletteShortcut } from "./command-palette.ts";

export class QuickPanelEditor extends CustomEditor {
  // 显式字段而非参数属性：node --test 的 TS 剥离不支持参数属性（Pi 运行时用 jiti，两者都可）。
  private readonly openPanel: () => void;
  private readonly openCommandPalette: (editor: QuickPanelEditor) => void;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    openPanel: () => void,
    openCommandPalette: (editor: QuickPanelEditor) => void = () => {},
  ) {
    // Rule: 启用 embedWorkingStatus 后，Pi 把 working、重试、压缩等状态画进输入框上边框，
    // 不再另起一行独立状态行；Pi 只在编辑器暴露 embedWorkingStatus === true 且实现
    // setWorkingStatusIndicator 时才走内嵌路径，否则回退到输入框上方的独立状态行。
    super(tui, theme, keybindings, { embedWorkingStatus: true });
    this.openPanel = openPanel;
    this.openCommandPalette = openCommandPalette;
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
