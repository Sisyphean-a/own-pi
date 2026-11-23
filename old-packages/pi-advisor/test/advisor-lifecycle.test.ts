import assert from "node:assert/strict";
import test from "node:test";
import advisorExtension from "../src/advisor.ts";

test("does not create a status-bar reminder after mutation tool results", async () => {
  const handlers = new Map<string, (event?: unknown) => Promise<void> | void>();
  let statusUpdates = 0;
  const pi = {
    on: (name: string, handler: (event?: unknown) => Promise<void> | void) => handlers.set(name, handler),
    registerTool: () => {},
    registerCommand: () => {},
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools: () => {},
    setStatus: () => {
      statusUpdates++;
    },
  } as any;

  advisorExtension(pi);
  await handlers.get("agent_start")?.();
  await handlers.get("tool_result")?.({
    toolName: "edit",
    input: { path: "src/example.ts" },
    content: [{ type: "text", text: "updated" }],
    details: { patch: "+new line" },
    isError: false,
  });

  assert.equal(statusUpdates, 0);
});
