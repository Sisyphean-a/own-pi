import assert from "node:assert/strict";
import test from "node:test";

import { QuickPanelEditor, type QuickPanelEditorExtras } from "../src/panel/quick-panel-editor.ts";
import { bindThinkingState, createThinkingState, type ThinkingState } from "../src/panel/thinking-state.ts";

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
  extras: QuickPanelEditorExtras = {},
): InspectableEditor {
  const tui = { requestRender() {} } as unknown as EditorArgs[0];
  const theme = {
    borderColor: (text: string) => text,
    textColor: (text: string) => text,
  } as unknown as EditorArgs[1];
  const keybindings = { matches: () => false } as unknown as EditorArgs[2];
  return new InspectableEditor(tui, theme, keybindings, openPanel, openCommandPalette, extras);
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

  editor.setWorkingStatusIndicator(undefined);
  assert.equal(editor.exposeTopBorder(60).includes("Working…"), false);
});

test("shows the animated thinking glyph only while the model is generating", () => {
  const thinking = createThinkingState();
  const editor = createEditor(() => {}, () => {}, { thinking });
  editor.setWorkingStatusIndicator(workingIndicator());

  const originalNow = Date.now;
  try {
    Date.now = () => 0;
    // 跑工具（thinking 未激活）时只剩 Working…，没有图标。
    assert.equal(editor.exposeTopBorder(60).includes("✻"), false);

    thinking.setActive(true);
    assert.match(editor.exposeTopBorder(60), /⠋ Working… ✻/);
    Date.now = () => 125;
    assert.match(editor.exposeTopBorder(60), /⠋ Working… ✢/);

    // 同一帧同一时刻下，思考结束立刻恢复为纯状态文本。
    thinking.setActive(false);
    assert.doesNotMatch(editor.exposeTopBorder(60), /[✻✢✶✷✸]/);
  } finally {
    Date.now = originalNow;
  }

  // 没有注入状态时视为不在思考，不显示图标。
  const plain = createEditor();
  plain.setWorkingStatusIndicator(workingIndicator());
  assert.equal(plain.exposeTopBorder(60).includes("✻"), false);
});

test("colors the thinking glyph with the editor border color of the current thinking level", () => {
  const thinking = createThinkingState();
  thinking.setActive(true);
  const tui = { requestRender() {} } as unknown as EditorArgs[0];
  const theme = {
    borderColor: (text: string) => `<level>${text}</level>`,
    textColor: (text: string) => text,
  } as unknown as EditorArgs[1];
  const editor = new InspectableEditor(tui, theme, {} as unknown as EditorArgs[2], () => {}, () => {}, { thinking });
  editor.setWorkingStatusIndicator(workingIndicator());

  const originalNow = Date.now;
  try {
    Date.now = () => 0;
    // 图标用当前思考等级色（= Pi 更新 editor.borderColor 的那份）；状态文本保持自己的颜色。
    assert.match(editor.exposeTopBorder(60), /⠋ Working… <level>✻<\/level>/);

    // Pi 在 thinking_level_changed 时原地改这个字段，颜色随之变化。
    editor.borderColor = (text: string) => `<xhigh>${text}</xhigh>`;
    assert.match(editor.exposeTopBorder(60), /<xhigh>✻<\/xhigh>/);
  } finally {
    Date.now = originalNow;
  }
});

test("keeps the glyph from overflowing narrow borders", () => {
  const thinking = createThinkingState();
  thinking.setActive(true);
  const editor = createEditor(() => {}, () => {}, { thinking });
  editor.setWorkingStatusIndicator(workingIndicator());

  for (const width of [40, 20, 12]) {
    const border = editor.exposeTopBorder(width).replace(/\x1b\[[0-9;]*m/g, "");
    assert.equal([...border].length, width, `宽度 ${width} 的上边框应正好占满 ${width} 列：${border}`);
  }
});

test("maps turn events to the thinking state", () => {
  const handlers = new Map<string, () => void>();
  const state: ThinkingState = createThinkingState();
  bindThinkingState({
    on(event, handler) {
      handlers.set(event, handler);
    },
  }, state);

  assert.deepEqual([...handlers.keys()].sort(), [
    "agent_settled",
    "session_shutdown",
    "tool_execution_start",
    "turn_end",
    "turn_start",
  ]);

  handlers.get("turn_start")?.();
  assert.equal(state.isActive(), true);
  for (const event of ["tool_execution_start", "turn_end", "agent_settled", "session_shutdown"]) {
    handlers.get("turn_start")?.();
    assert.equal(state.isActive(), true);
    handlers.get(event)?.();
    assert.equal(state.isActive(), false, `${event} 应结束思考状态`);
  }
});
