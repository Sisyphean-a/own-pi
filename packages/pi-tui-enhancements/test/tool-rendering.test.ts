import assert from "node:assert/strict";
import test from "node:test";

import {
  canJoinToolGroup,
  compactToolFrame,
  countTextLines,
  firstLinePreview,
  formatCommandInputMetric,
  formatOutputMetric,
  getCollapsedContentLineLimit,
  isBuiltInTool,
  isCommandInputActive,
  shouldCompact,
} from "../src/display/tool-policy.ts";
import { formatCompactCallLine } from "../src/display/tool-rendering.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

test("recognizes Pi's current built-in renderer shape and preserves native edit rendering", () => {
  const edit = {
    toolName: "edit",
    toolDefinition: {},
  };

  assert.equal(isBuiltInTool(edit), true);
  assert.equal(shouldCompact(edit), false);
});

test("keeps legacy built-in markers and compact built-in tools compatible", () => {
  assert.equal(isBuiltInTool({ toolName: "edit", builtInToolDefinition: {} }), true);
  assert.equal(shouldCompact({ toolName: "grep", toolDefinition: {} }), true);
  assert.equal(shouldCompact({ toolName: "powershell", toolDefinition: {} }), true);
  assert.equal(shouldCompact({ toolName: "edit", toolDefinition: { label: "MCP: edit" } }), true);
});

test("clips collapsed group rows to one content line and leaves edit and write alone", () => {
  assert.equal(getCollapsedContentLineLimit({ toolName: "bash", toolDefinition: {}, expanded: false }), 1);
  assert.equal(getCollapsedContentLineLimit({ toolName: "read", toolDefinition: {} }), 1);
  assert.equal(getCollapsedContentLineLimit({ toolName: "mcp_search", toolDefinition: { label: "MCP: search" } }), 1);
  assert.equal(getCollapsedContentLineLimit({ toolName: "edit", toolDefinition: {}, expanded: false }), undefined);
  assert.equal(getCollapsedContentLineLimit({ toolName: "write", toolDefinition: {}, expanded: false }), undefined);
});

test("leaves expanded tool rows unclamped so Ctrl+O shows full output", () => {
  assert.equal(getCollapsedContentLineLimit({ toolName: "bash", toolDefinition: {}, expanded: true }), undefined);
  assert.equal(getCollapsedContentLineLimit({ toolName: "edit", toolDefinition: {}, expanded: true }), undefined);
});

test("keeps edit and write out of tool groups", () => {
  assert.equal(canJoinToolGroup({ toolName: "bash" }), true);
  assert.equal(canJoinToolGroup({ toolName: "edit" }), false);
  assert.equal(canJoinToolGroup({ toolName: "write" }), false);
});

test("shows only the active command or output line metric", () => {
  assert.deepEqual(firstLinePreview("echo one\necho two\n"), {
    text: "echo one …",
    lineCount: 2,
  });
  assert.equal(countTextLines("first\nsecond\n"), 2);
  assert.equal(formatCommandInputMetric(1), "");
  assert.equal(formatCommandInputMetric(2), "(2 lines)");
  assert.equal(formatOutputMetric(), "");
  assert.equal(formatOutputMetric(1), "(1 line)");
  assert.equal(formatOutputMetric(7), "(7 lines)");
  assert.equal(isCommandInputActive({}), true);
  assert.equal(isCommandInputActive({ argsComplete: true }), false);
  assert.equal(isCommandInputActive({ executionStarted: true }), false);
  assert.equal(isCommandInputActive({ isPartial: false }), false);
});

test("keeps collapsed tool height stable when streamed text ends with a newline", () => {
  const completeLine = compactToolFrame(["", "", "$ echo one", ""], false, 1);
  const trailingStreamLine = compactToolFrame(["", "", "$ echo one", "", ""], false, 1);
  const nextLineStarted = compactToolFrame(["", "", "$ echo one", "echo two", ""], false, 1);

  assert.deepEqual(trailingStreamLine, completeLine);
  assert.deepEqual(nextLineStarted, completeLine);
  assert.equal(completeLine.length, 4);
});

test("keeps the tool row background intact when a collapsed command is truncated", () => {
  const command = "\x1b[38;2;138;190;183mrg -n 还款处理中与还款失败 packages docs -3 && echo done\x1b[39m";
  const suffix = "\x1b[38;2;128;128;128m (2 lines)\x1b[39m";

  const [short] = formatCompactCallLine(command, suffix, 40);
  assert.equal(short.includes("\x1b[0m"), false, "行内不能出现完整 SGR reset，否则会打断工具行背景");
  assert.ok(visibleWidth(short) <= 40);
  assert.ok(short.endsWith(suffix));
  assert.ok(short.includes("…"));

  const [fits] = formatCompactCallLine(command, suffix, 200);
  assert.equal(fits, command + suffix);

  const [tiny] = formatCompactCallLine(command, suffix, 12);
  assert.equal(tiny.includes("\x1b[0m"), false);
  assert.ok(visibleWidth(tiny) <= 12);
});
