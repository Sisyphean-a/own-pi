import assert from "node:assert/strict";
import test from "node:test";

import { canJoinToolGroup, getCollapsedContentLineLimit, isBuiltInTool, shouldCompact } from "../src/display/tool-policy.ts";

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
