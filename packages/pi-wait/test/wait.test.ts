import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activateWaitExtension,
  parseWaitTime,
  type WaitRuntime,
} from "../src/wait.ts";

test("parses supported wait times and rejects ambiguous dates", () => {
  const now = new Date(2026, 7, 30, 8, 0, 0).getTime();
  assert.equal(parseWaitTime("1h30m", now), now + 5_400_000);
  assert.equal(parseWaitTime("2小时后", now), now + 7_200_000);
  assert.equal(parseWaitTime("09:30", now), new Date(2026, 7, 30, 9, 30).getTime());
  assert.equal(
    parseWaitTime("2026-08-31 09:30", now),
    new Date(2026, 7, 31, 9, 30).getTime(),
  );
  assert.throws(() => parseWaitTime("2026-02-31 09:30", now), /时间格式无效/);
  assert.throws(() => parseWaitTime("08\/31\/2026 09:30", now), /无法识别时间/);
});

function createHarness() {
  let now = 1_000_000;
  let nextId = 0;
  const timers: Array<{ callback: () => void; dueAt: number; cleared: boolean }> = [];
  const handlers = new Map<string, (...args: any[]) => any>();
  const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
  const sent: Array<{ content: unknown; options: unknown }> = [];
  const notifications: string[] = [];
  let sendError: Error | undefined;

  const runtime: WaitRuntime = {
    now: () => now,
    createId: () => `task-${++nextId}`,
    setTimer(callback, delayMs) {
      const timer = { callback, dueAt: now + delayMs, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer(handle) {
      (handle as (typeof timers)[number]).cleared = true;
    },
  };
  const pi = {
    on(name: string, handler: (...args: any[]) => any) {
      handlers.set(name, handler);
    },
    registerCommand(name: string, options: { handler: (args: string, ctx: any) => Promise<void> }) {
      commands.set(name, options.handler);
    },
    sendUserMessage(content: unknown, options?: unknown) {
      if (sendError) {
        const error = sendError;
        sendError = undefined;
        throw error;
      }
      sent.push({ content, options });
    },
  };
  const ctx = {
    hasUI: true,
    ui: {
      setStatus() {},
      notify(message: string) {
        notifications.push(message);
      },
    },
  };

  activateWaitExtension(pi as never, runtime);
  return {
    ctx,
    handlers,
    commands,
    sent,
    timers,
    notifications,
    setNow(value: number) {
      now = value;
    },
    advance(ms: number) {
      now += ms;
      for (const timer of timers.filter((item) => !item.cleared && item.dueAt <= now)) {
        timer.cleared = true;
        timer.callback();
      }
    },
    rejectNextSend(error: Error) {
      sendError = error;
    },
  };
}

test("captures ordinary input without an AI call and sends only when due", async () => {
  const harness = createHarness();
  await harness.handlers.get("session_start")?.({}, harness.ctx);
  await harness.commands.get("wait")?.("10m", harness.ctx);
  const result = await harness.handlers.get("input")?.(
    { source: "interactive", text: "run the tests", images: undefined },
    harness.ctx,
  );

  assert.deepEqual(result, { action: "handled" });
  assert.equal(harness.sent.length, 0, "capturing a task must not call the AI");
  harness.advance(599_999);
  assert.equal(harness.sent.length, 0);
  harness.advance(1);
  assert.deepEqual(harness.sent, [
    {
      content: "run the tests",
      options: { deliverAs: "followUp", expandPromptTemplates: true },
    },
  ]);
});

test("keeps slash commands local until due and expands them only on dispatch", async () => {
  const harness = createHarness();
  await harness.handlers.get("session_start")?.({}, harness.ctx);
  await harness.commands.get("wait")?.("1m -- /review src/index.ts", harness.ctx);
  assert.equal(harness.sent.length, 0);

  harness.advance(60_000);
  assert.deepEqual(harness.sent, [
    {
      content: "/review src/index.ts",
      options: { deliverAs: "followUp", expandPromptTemplates: true },
    },
  ]);
});

test("dispatches when command and session lifecycle handlers receive different context objects", async () => {
  const harness = createHarness();
  const sessionContext = { ...harness.ctx };
  const commandContext = { ...harness.ctx };
  await harness.handlers.get("session_start")?.({}, sessionContext);
  await harness.commands.get("wait")?.("1m -- context-safe", commandContext);

  harness.advance(60_000);
  assert.deepEqual(harness.sent.map((item) => item.content), ["context-safe"]);
});

test("cancels captured and scheduled tasks", async () => {
  const harness = createHarness();
  await harness.handlers.get("session_start")?.({}, harness.ctx);

  await harness.commands.get("wait")?.("1m", harness.ctx);
  await harness.commands.get("wait")?.("cancel", harness.ctx);
  const uncaptured = await harness.handlers.get("input")?.(
    { source: "interactive", text: "send now", images: undefined },
    harness.ctx,
  );
  assert.deepEqual(uncaptured, { action: "continue" });

  await harness.commands.get("wait")?.("1m -- never send", harness.ctx);
  await harness.commands.get("wait")?.("cancel task-1", harness.ctx);
  harness.advance(60_000);
  assert.deepEqual(harness.sent, []);
});

test("clears pending tasks on shutdown and ignores late timer callbacks", async () => {
  const harness = createHarness();
  await harness.handlers.get("session_start")?.({}, harness.ctx);
  await harness.commands.get("wait")?.("1m -- never cross sessions", harness.ctx);
  const lateCallback = harness.timers.at(-1)?.callback;

  await harness.handlers.get("session_shutdown")?.({ reason: "new" }, harness.ctx);
  harness.advance(60_000);
  lateCallback?.();
  assert.deepEqual(harness.sent, []);
});

test("retries after a synchronous Pi rejection without sending early", async () => {
  const harness = createHarness();
  await harness.handlers.get("session_start")?.({}, harness.ctx);
  await harness.commands.get("wait")?.("1m -- retry me", harness.ctx);
  harness.rejectNextSend(new Error("busy"));

  harness.advance(60_000);
  assert.deepEqual(harness.sent, []);
  assert.ok(harness.notifications.some((message) => message.includes("30 秒后重试")));

  harness.advance(29_999);
  assert.deepEqual(harness.sent, []);
  harness.advance(1);
  assert.deepEqual(harness.sent.map((item) => item.content), ["retry me"]);
});
