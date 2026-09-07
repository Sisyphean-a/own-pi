import assert from "node:assert/strict";
import test from "node:test";

import { isBuiltInTool, shouldCompact } from "../src/tool-policy.ts";

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
  assert.equal(shouldCompact({ toolName: "edit", toolDefinition: { label: "MCP: edit" } }), true);
});
