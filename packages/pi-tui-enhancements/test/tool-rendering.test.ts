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
  assert.equal(formatOutputMetric(), "(out …)");
  assert.equal(formatOutputMetric(1), "(out 1 line)");
  assert.equal(formatOutputMetric(7), "(out 7 lines)");
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
