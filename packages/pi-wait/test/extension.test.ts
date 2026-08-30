import assert from "node:assert/strict";
import { test } from "node:test";
import piWait from "../extensions/index.ts";

test("loads as a non-fatal Pi extension", async () => {
  const events = new Set<string>();
  const commands = new Set<string>();
  const pi = {
    on(name: string) {
      events.add(name);
    },
    registerCommand(name: string) {
      commands.add(name);
    },
  };

  await assert.doesNotReject(() => piWait(pi as never));
  assert.ok(events.has("session_start"));
  assert.ok(events.has("session_shutdown"));
  assert.ok(events.has("input"));
  assert.ok(commands.has("wait"));
});
