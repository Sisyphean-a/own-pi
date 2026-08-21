import assert from "node:assert/strict";
import { test } from "node:test";
import piOptimization from "../extensions/index.ts";

test("loads both optimizations as independent, non-fatal features", async () => {
  const events = new Set<string>();
  const commands = new Set<string>();
  const pi = {
    on(name: string) {
      events.add(name);
    },
    registerCommand(name: string) {
      commands.add(name);
    },
    getAllTools() {
      return [];
    },
    getActiveTools() {
      return [];
    },
    setActiveTools() {},
  };

  await assert.doesNotReject(() => piOptimization(pi as never));
  assert.ok(events.has("tool_call"));
  assert.ok(events.has("user_bash"));
  assert.ok(events.has("session_start"));
  assert.ok(events.has("model_select"));
  assert.ok(events.has("before_agent_start"));
  assert.deepEqual([...commands].sort(), ["nulfix", "vision-mcp"]);
});

test("factory remains safe when optional capability methods are absent", async () => {
  const pi = {
    on() {},
    registerCommand() {},
  };

  await assert.doesNotReject(() => piOptimization(pi as never));
});
