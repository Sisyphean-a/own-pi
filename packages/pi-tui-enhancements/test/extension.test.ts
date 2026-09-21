import assert from "node:assert/strict";
import test from "node:test";

import piTuiEnhancements from "../extensions/index.ts";

test("package entry exposes one default factory", () => {
  assert.equal(typeof piTuiEnhancements, "function");
});

test("package entry wires display, panel and context without throwing", async () => {
  const events = new Set<string>();
  const commands = new Set<string>();
  const pi = {
    on(name: string) {
      events.add(name);
    },
    registerCommand(name: string) {
      commands.add(name);
    },
    registerShortcut() {},
    getActiveTools() {
      return [];
    },
    getAllTools() {
      return [];
    },
    getCommands() {
      return [];
    },
  };

  await assert.doesNotReject(() => piTuiEnhancements(pi as never));
});
