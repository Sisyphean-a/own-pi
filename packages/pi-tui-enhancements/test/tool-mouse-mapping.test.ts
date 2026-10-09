import assert from "node:assert/strict";
import test from "node:test";

import {
  ToolExecutionComponent,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, MouseRegion, ScrollView, Text, VStack } from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { getLayoutBoxesAt, renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";

import {
  installContainerParentTracking,
  installToolRenderers,
} from "../src/display/tool-rendering.ts";

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const OSC133 = /\x1b\]133;[ABC](?:\x07|\x1b\\)/g;
const WIDTH = 100;

const strip = (line: string): string => line.replace(OSC133, "").replace(ANSI, "");
const ui = { requestRender() {} } as unknown as TUI;

interface ToolOptions {
  id: string;
  command: string;
  output: string;
}

interface TestTool extends Component {
  expanded: boolean;
  toolCallId: string;
  markExecutionStarted(): void;
  setArgsComplete(): void;
  updateResult(result: unknown, isPartial?: boolean): void;
}

function makeTool({ id, command, output }: ToolOptions): TestTool {
  const tool = new ToolExecutionComponent(
    "bash",
    id,
    { command },
    {},
    {},
    ui,
    process.cwd(),
  ) as unknown as TestTool;
  tool.markExecutionStarted();
  tool.setArgsComplete();
  tool.updateResult(
    { content: [{ type: "text", text: output }], isError: false, durationMs: 1 },
    false,
  );
  return tool;
}

function paintedLines(container: Container): string[] {
  return container.render(WIDTH).map(strip);
}

function clickRow(container: Container, row: number, paintedHeight: number): unknown {
  return (container as unknown as { handleMouse(event: Record<string, unknown>): unknown }).handleMouse({
    type: "click",
    button: "left",
    x: 4,
    y: row,
    width: WIDTH,
    height: paintedHeight,
    screenX: 4,
    screenY: row,
  });
}

function clickPainted(container: Container, needle: string): number {
  const lines = paintedLines(container);
  const row = lines.findIndex((line) => line.includes(needle));
  assert.notEqual(row, -1, `未找到绘制行：${needle}`);
  clickRow(container, row, lines.length);
  return row;
}

function expandedIds(tools: readonly TestTool[]): string[] {
  return tools.filter((tool) => tool.expanded).map((tool) => tool.toolCallId);
}

function buildChat(): { chat: Container; tools: [TestTool, TestTool, TestTool] } {
  const chat = new Container();
  const alpha = makeTool({ id: "a", command: "echo alpha", output: "alpha-one\nalpha-two" });
  const bravo = makeTool({ id: "b", command: "echo bravo", output: "bravo-one\nbravo-two" });
  const charlie = makeTool({ id: "c", command: "echo charlie", output: "charlie-one\ncharlie-two" });
  chat.addChild(alpha);
  chat.addChild(bravo);
  chat.addChild(charlie);
  return { chat, tools: [alpha, bravo, charlie] };
}

test("点击连续工具行时命中被点击的那个工具", () => {
  initTheme("dark");
  installToolRenderers();
  installContainerParentTracking();

  const { chat, tools } = buildChat();
  for (const needle of ["echo alpha", "echo bravo", "echo charlie"]) {
    for (const tool of tools) tool.expanded = false;
    clickPainted(chat, needle);
    const expected = needle.slice("echo ".length, "echo ".length + 1);
    assert.deepEqual(expandedIds(tools), [expected], `点击 ${needle} 应展开它自己`);
  }
});

test("展开某个工具后，其余工具行的命中不漂移", () => {
  initTheme("dark");
  installToolRenderers();
  installContainerParentTracking();

  const { chat, tools } = buildChat();
  const [alpha, bravo, charlie] = tools;

  clickPainted(chat, "echo bravo");
  assert.deepEqual(expandedIds(tools), ["b"], "点击 bravo 应展开 bravo");

  // bravo 展开后组内高度变化，charlie 的行下标整体下移。
  clickPainted(chat, "echo charlie");
  assert.deepEqual(expandedIds(tools), ["b", "c"], "bravo 展开时点击 charlie 仍应命中 charlie");

  clickPainted(chat, "echo bravo");
  assert.deepEqual(expandedIds(tools), ["c"], "再次点击 bravo 应只折叠 bravo");

  clickPainted(chat, "echo alpha");
  assert.deepEqual(expandedIds(tools), ["a", "c"], "alpha 行仍应命中 alpha");
  assert.equal(alpha.expanded, true);
});

test("工具组之后的非工具行不会命中组内工具", () => {
  initTheme("dark");
  installToolRenderers();
  installContainerParentTracking();

  const { chat, tools } = buildChat();
  let messageClicks = 0;
  chat.addChild(new MouseRegion(new Text("after-tools", 0, 0), () => {
    messageClicks++;
    return { handled: true };
  }));

  clickPainted(chat, "after-tools");
  assert.equal(messageClicks, 1, "工具组之后的消息行应命中该消息");
  assert.deepEqual(expandedIds(tools), [], "点击消息行不应展开任何工具");
});

test("工具组末尾的结构空行不展开组内工具", () => {
  initTheme("dark");
  installToolRenderers();
  installContainerParentTracking();

  const { chat, tools } = buildChat();
  const paintedHeight = paintedLines(chat).length;
  clickRow(chat, paintedHeight - 1, paintedHeight);
  assert.deepEqual(expandedIds(tools), [], "组末尾空行不应展开组内工具");
});

test("fullscreen 滚动视口偏移后点击仍命中被点击的工具", () => {
  initTheme("dark");
  installToolRenderers();
  installContainerParentTracking();

  const chat = new Container();
  const tools: TestTool[] = [];
  for (let index = 0; index < 10; index++) {
    const tool = makeTool({
      id: `t${index}`,
      command: `echo tool-${index}`,
      output: `output-${index}-one\noutput-${index}-two`,
    });
    tools.push(tool);
    chat.addChild(tool);
  }

  const scroll = new ScrollView(chat, { follow: "end", primary: true, overscroll: "chain", scrollbar: "auto" });
  const root = new VStack([{ component: scroll, basis: 0, grow: 1, shrink: 1, minSize: 1 }]);
  const viewportHeight = 12;
  const frame = renderLayoutFrame(root, WIDTH, viewportHeight, () => {});
  assert.ok(scroll.scrollTop > 0, "内容应超出视口并产生非零滚动偏移");

  const screen = frame.lines.map(strip);
  const visibleNeedle = [...screen].reverse().find((line) => /tool-\d/.test(line));
  assert.ok(visibleNeedle, "视口内应能看到至少一个工具标题");
  const screenRow = screen.indexOf(visibleNeedle!);
  const toolIndex = Number(/tool-(\d)/.exec(visibleNeedle!)![1]);
  const expectedId = `t${toolIndex}`;

  const event = {
    type: "click",
    button: "left",
    x: 4,
    y: screenRow,
    width: WIDTH,
    height: viewportHeight,
    screenX: 4,
    screenY: screenRow,
  };
  let handled = false;
  for (const box of getLayoutBoxesAt(frame, event.screenX, event.screenY)) {
    const result = (box.component as unknown as {
      handleMouse?: (event: Record<string, unknown>) => unknown;
    }).handleMouse?.({
      ...event,
      x: event.screenX - box.rect.x,
      y: event.screenY - box.rect.y,
      width: box.rect.width,
      height: box.rect.height,
    });
    if (result) {
      handled = true;
      break;
    }
  }

  assert.equal(handled, true, "点击应被命中的组件处理");
  assert.deepEqual(expandedIds(tools), [expectedId], `点击 ${visibleNeedle} 应展开 ${expectedId}`);
});
