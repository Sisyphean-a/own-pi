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

function createEditor(
  openPanel: () => void = () => {},
  openCommandPalette: (editor: QuickPanelEditor) => void = () => {},
): InspectableEditor {
  const tui = { requestRender() {} } as unknown as EditorArgs[0];
  const theme = {
    borderColor: (text: string) => text,
    textColor: (text: string) => text,
  } as unknown as EditorArgs[1];
  const keybindings = { matches: () => false } as unknown as EditorArgs[2];
  return new InspectableEditor(tui, theme, keybindings, openPanel, openCommandPalette);
}

function workingIndicator(): Parameters<InspectableEditor["setWorkingStatusIndicator"]>[0] {
  return {
    kind: "working",
    renderInBorder: (width: number) => "⠋ Working…".slice(0, Math.max(0, width)),
    renderSpinnerInBorder: (width: number) => "⠋".slice(0, Math.max(0, width)),
  } as unknown as Parameters<InspectableEditor["setWorkingStatusIndicator"]>[0];
}

test("opens the command palette for the legacy Ctrl+_ encoding of Ctrl+/", () => {
  let opened = 0;
  const editor = createEditor(() => {}, () => {
    opened += 1;
  });

  editor.handleInput("\x1f");
  editor.handleInput(String.fromCharCode(27) + "[47;5u");
  editor.handleInput(String.fromCharCode(27) + "[63;5u");

  assert.equal(opened, 3);
});

test("opens the custom command palette instead of native autocomplete for the first slash", () => {
  let opened = 0;
  const editor = createEditor(() => {}, () => {
    opened += 1;
  });

  editor.handleInput("/");

  assert.equal(opened, 1);
  assert.equal(editor.getText(), "");
});

test("submits a selected bare command through the editor handler", () => {
  const editor = createEditor();
  let submitted = "";
  editor.onSubmit = (text) => {
    submitted = text;
  };

  editor.submitCommand("resume");

  assert.equal(submitted, "/resume");
});

test("keeps slash input after the editor already contains text", () => {
  let opened = 0;
  const editor = createEditor(() => {}, () => {
    opened += 1;
  });
  editor.setText("draft");

  editor.handleInput("/");

  assert.equal(opened, 0);
  assert.equal(editor.getText(), "draft/");
});

test("draws the working status inside the input box top border", () => {
  const editor = createEditor();

  // Pi 只在编辑器同时满足这两个条件时才内嵌状态，否则回退为输入框上方的独立状态行。
  assert.equal(editor.embedWorkingStatus, true);
  assert.equal(typeof editor.setWorkingStatusIndicator, "function");

  editor.setWorkingStatusIndicator(workingIndicator());

  const border = editor.exposeTopBorder(60);
  assert.ok(border.includes("Working…"), `上边框应包含工作状态：${border}`);
  // 状态文本后面直接接边框横线：不再有额外的思考图标。
  assert.match(border, /⠋ Working… ─/);
  assert.doesNotMatch(border, /[✻✢✶✷✸]/);

  editor.setWorkingStatusIndicator(undefined);
  assert.equal(editor.exposeTopBorder(60).includes("Working…"), false);
});
