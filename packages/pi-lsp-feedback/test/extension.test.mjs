import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import lspFeedbackExtension from "../extensions/index.js";

const fakeServer = path.join(import.meta.dirname, "fake-lsp.mjs");

test("injects diagnostics from a successful write at turn end", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "pi-lsp-extension-"));
  const filePath = path.join(workspace, "src", "sample.ts");
  await mkdir(path.join(workspace, ".pi"), { recursive: true });
  await mkdir(path.dirname(filePath), { recursive: true });
  await Promise.all([
    writeFile(path.join(workspace, "package.json"), "{}\n"),
    writeFile(filePath, "broken\n"),
    writeFile(
      path.join(workspace, ".pi", "lsp-feedback.json"),
      JSON.stringify({
        servers: {
          typescript: {
            command: process.execPath,
            args: [fakeServer],
            rootMarkers: ["package.json"],
          },
        },
      }),
    ),
  ]);

  const handlers = new Map();
  const messages = [];
  const pi = {
    on(name, handler) {
      handlers.set(name, handler);
    },
    registerCommand() {},
    sendMessage(message, options) {
      messages.push({ message, options });
    },
  };
  const ctx = {
    cwd: workspace,
    hasUI: false,
    signal: undefined,
    isProjectTrusted: () => true,
    ui: { setStatus() {}, notify() {} },
  };

  lspFeedbackExtension(pi);
  await handlers.get("session_start")({}, ctx);
  await handlers.get("tool_result")(
    {
      toolName: "write",
      input: { path: filePath },
      details: {},
      isError: false,
    },
    ctx,
  );
  handlers.get("turn_end")({}, ctx);

  assert.equal(messages.length, 1);
  assert.match(messages[0].message.content, /FAKE100/);
  assert.match(messages[0].message.content, /sample\.ts:1:1 error/);
  assert.deepEqual(messages[0].options, {
    deliverAs: "steer",
    triggerTurn: true,
  });

  await handlers.get("session_shutdown")({}, ctx);
});

test("does not inject an unconfirmed result without diagnostics", async (t) => {
  const previous = process.env.FAKE_PUSH_ONLY;
  process.env.FAKE_PUSH_ONLY = "1";
  t.after(() => {
    if (previous === undefined) delete process.env.FAKE_PUSH_ONLY;
    else process.env.FAKE_PUSH_ONLY = previous;
  });

  const workspace = await mkdtemp(path.join(os.tmpdir(), "pi-lsp-unconfirmed-"));
  const filePath = path.join(workspace, "src", "sample.ts");
  await mkdir(path.join(workspace, ".pi"), { recursive: true });
  await mkdir(path.dirname(filePath), { recursive: true });
  await Promise.all([
    writeFile(path.join(workspace, "package.json"), "{}\n"),
    writeFile(filePath, "clean\n"),
    writeFile(
      path.join(workspace, ".pi", "lsp-feedback.json"),
      JSON.stringify({
        servers: {
          typescript: {
            command: process.execPath,
            args: [fakeServer],
            rootMarkers: ["package.json"],
          },
        },
      }),
    ),
  ]);

  const handlers = new Map();
  const messages = [];
  const pi = {
    on(name, handler) {
      handlers.set(name, handler);
    },
    registerCommand() {},
    sendMessage(message) {
      messages.push(message);
    },
  };
  const ctx = {
    cwd: workspace,
    hasUI: false,
    signal: undefined,
    isProjectTrusted: () => true,
    ui: { setStatus() {}, notify() {} },
  };

  lspFeedbackExtension(pi);
  await handlers.get("session_start")({}, ctx);
  await handlers.get("tool_result")(
    {
      toolName: "write",
      input: { path: filePath },
      details: {},
      isError: false,
    },
    ctx,
  );
  handlers.get("turn_end")({}, ctx);

  assert.deepEqual(messages, []);

  await handlers.get("session_shutdown")({}, ctx);
});

test("does not inject an unavailable LSP state", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "pi-lsp-unavailable-"));
  const filePath = path.join(workspace, "src", "sample.ts");
  await mkdir(path.join(workspace, ".pi"), { recursive: true });
  await mkdir(path.dirname(filePath), { recursive: true });
  await Promise.all([
    writeFile(filePath, "clean\n"),
    writeFile(
      path.join(workspace, ".pi", "lsp-feedback.json"),
      JSON.stringify({
        servers: {
          typescript: {
            rootMarkers: ["missing-workspace-marker.json"],
            fallbackToWorkspace: false,
          },
        },
      }),
    ),
  ]);

  const handlers = new Map();
  const messages = [];
  const pi = {
    on(name, handler) {
      handlers.set(name, handler);
    },
    registerCommand() {},
    sendMessage(message) {
      messages.push(message);
    },
  };
  const ctx = {
    cwd: workspace,
    hasUI: false,
    signal: undefined,
    isProjectTrusted: () => true,
    ui: { setStatus() {}, notify() {} },
  };

  lspFeedbackExtension(pi);
  await handlers.get("session_start")({}, ctx);
  await handlers.get("tool_result")(
    {
      toolName: "write",
      input: { path: filePath },
      details: {},
      isError: false,
    },
    ctx,
  );
  handlers.get("turn_end")({}, ctx);

  assert.deepEqual(messages, []);

  await handlers.get("session_shutdown")({}, ctx);
});

test("silently ignores writes to unsupported file types", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "pi-lsp-unsupported-"));
  const filePath = path.join(workspace, "ticket.md");
  await writeFile(filePath, "# Ticket\n");

  const handlers = new Map();
  const messages = [];
  const statuses = [];
  const pi = {
    on(name, handler) {
      handlers.set(name, handler);
    },
    registerCommand() {},
    sendMessage(message) {
      messages.push(message);
    },
  };
  const ctx = {
    cwd: workspace,
    hasUI: true,
    signal: undefined,
    isProjectTrusted: () => true,
    ui: {
      setStatus(_key, value) {
        statuses.push(value);
      },
      notify() {},
    },
  };

  lspFeedbackExtension(pi);
  await handlers.get("session_start")({}, ctx);
  await handlers.get("tool_result")(
    {
      toolName: "write",
      input: { path: filePath },
      details: {},
      isError: false,
    },
    ctx,
  );
  handlers.get("turn_end")({}, ctx);

  assert.deepEqual(messages, []);
  assert.deepEqual(statuses, []);

  await handlers.get("session_shutdown")({}, ctx);
});
