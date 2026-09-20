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

export class QuickPanelEditor extends CustomEditor {
  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    private readonly openPanel: () => void,
  ) {
    super(tui, theme, keybindings);
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.ctrl("l"))) {
      this.openPanel();
      return;
    }

    super.handleInput(data);
  }
}
