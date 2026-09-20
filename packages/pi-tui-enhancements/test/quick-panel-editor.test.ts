import assert from "node:assert/strict";
import test from "node:test";

import { QuickPanelEditor } from "../src/panel/quick-panel-editor.ts";

type EditorArgs = ConstructorParameters<typeof QuickPanelEditor>;

/** 暴露 protected renderTopBorder，直接核验上边框内容。 */
class InspectableEditor extends QuickPanelEditor {
  exposeTopBorder(width: number): string {
    return this.renderTopBorder(width, 0);
  }
}

function createEditor(): InspectableEditor {
  const tui = { requestRender() {} } as unknown as EditorArgs[0];
  const theme = {
    borderColor: (text: string) => text,
    textColor: (text: string) => text,
  } as unknown as EditorArgs[1];
  const keybindings = {} as EditorArgs[2];
  return new InspectableEditor(tui, theme, keybindings, () => {});
}

test("draws the working status inside the input box top border", () => {
  const editor = createEditor();

  // Pi 只在编辑器同时满足这两个条件时才内嵌状态，否则回退为输入框上方的独立状态行。
  assert.equal(editor.embedWorkingStatus, true);
  assert.equal(typeof editor.setWorkingStatusIndicator, "function");

  editor.setWorkingStatusIndicator({
    kind: "working",
    renderInBorder: () => "⠋ working…",
    renderSpinnerInBorder: () => "⠋",
  } as unknown as Parameters<typeof editor.setWorkingStatusIndicator>[0]);

  const border = editor.exposeTopBorder(60);
  assert.ok(border.includes("working…"), `上边框应包含工作状态：${border}`);

  editor.setWorkingStatusIndicator(undefined);
  assert.equal(editor.exposeTopBorder(60).includes("working…"), false);
});
