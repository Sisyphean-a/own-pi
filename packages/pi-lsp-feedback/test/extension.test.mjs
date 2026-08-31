import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import lspFeedbackExtension from "../extensions/index.js";

const fakeServer = path.join(import.meta.dirname, "fake-lsp.mjs");

function turnEnd(...toolCallIds) {
  return { toolResults: toolCallIds.map((toolCallId) => ({ toolCallId })) };
}

test("injects diagnostics from a successful write at turn end", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "pi-lsp-extension-"));
  const filePath = path.join(workspace, "src", "sample.ts");
  await mkdir(path.join(workspace, ".pi"), { recursive: true });
  await mkdir(path.dirname(filePath), { recursive: true });
  await Promise.all([
    writeFile(path.join(workspace, "package.json"), "{}\n"),
    writeFile(filePath, "broken\n"),
    mkdir(path.join(workspace, "node_modules", "@types", "node"), { recursive: true }),
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
      toolCallId: "edit-1",
      input: { path: filePath },
      details: {},
      isError: false,
    },
    ctx,
  );
  handlers.get("turn_end")(turnEnd("edit-1"), ctx);

  assert.equal(messages.length, 1);
  assert.match(messages[0].message.content, /FAKE100/);
  assert.match(messages[0].message.content, /sample\.ts:1:1 error/);
  assert.deepEqual(messages[0].options, {
    deliverAs: "steer",
    triggerTurn: true,
  });

  await handlers.get("session_shutdown")({}, ctx);
});

test("suppresses a transient parser cascade until it repeats", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "pi-lsp-parser-cascade-"));
  const filePath = path.join(workspace, "src", "sample.ts");
  await mkdir(path.join(workspace, ".pi"), { recursive: true });
  await mkdir(path.dirname(filePath), { recursive: true });
  await Promise.all([
    writeFile(path.join(workspace, "package.json"), "{}\n"),
    writeFile(filePath, "parse-cascade\n"),
    mkdir(path.join(workspace, "node_modules", "@types", "node"), { recursive: true }),
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
  const edit = (toolCallId) =>
    handlers.get("tool_result")(
      {
        toolName: "write",
        toolCallId,
        input: { path: filePath },
        details: {},
        isError: false,
      },
      ctx,
    );

  await edit("edit-1");
  handlers.get("turn_end")(turnEnd("edit-1"), ctx);
  assert.deepEqual(messages, []);

  await edit("edit-2");
  handlers.get("turn_end")(turnEnd("edit-2"), ctx);
  assert.equal(messages.length, 1);
  assert.match(messages[0].message.content, /Type expected/);

  await writeFile(filePath, "clean\n");
  await edit("edit-3");
  handlers.get("turn_end")(turnEnd("edit-3"), ctx);
  assert.equal(messages.length, 1);

  await handlers.get("session_shutdown")({}, ctx);
});

test("suppresses unchanged diagnostics across turns and re-reports after a clean result", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "pi-lsp-diagnostic-dedupe-"));
  const filePath = path.join(workspace, "src", "sample.ts");
  await mkdir(path.join(workspace, ".pi"), { recursive: true });
  await mkdir(path.dirname(filePath), { recursive: true });
  await Promise.all([
    writeFile(path.join(workspace, "package.json"), "{}\n"),
    writeFile(filePath, "broken\n"),
    mkdir(path.join(workspace, "node_modules", "@types", "node"), { recursive: true }),
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
  const edit = (toolCallId) =>
    handlers.get("tool_result")(
      {
        toolName: "write",
        toolCallId,
        input: { path: filePath },
        details: {},
        isError: false,
      },
      ctx,
    );

  await edit("edit-1");
  await edit("edit-2");
  handlers.get("turn_end")(turnEnd("edit-1", "edit-2"), ctx);
  assert.equal(messages.length, 1);

  await edit("edit-3");
  handlers.get("turn_end")(turnEnd("edit-3"), ctx);
  assert.equal(messages.length, 1);

  await writeFile(filePath, "clean\n");
  await edit("edit-4");
  handlers.get("turn_end")(turnEnd("edit-4"), ctx);
  assert.equal(messages.length, 1);

  await writeFile(filePath, "broken\n");
  await edit("edit-5");
  handlers.get("turn_end")(turnEnd("edit-5"), ctx);
  assert.equal(messages.length, 2);

  await handlers.get("session_shutdown")({}, ctx);
});

test("does not carry a late diagnostic into a later turn", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "pi-lsp-late-result-"));
  const filePath = path.join(workspace, "src", "sample.ts");
  await mkdir(path.join(workspace, ".pi"), { recursive: true });
  await mkdir(path.dirname(filePath), { recursive: true });
  await Promise.all([
    writeFile(path.join(workspace, "package.json"), "{}\n"),
    writeFile(filePath, "broken\n"),
    mkdir(path.join(workspace, "node_modules", "@types", "node"), { recursive: true }),
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
  const lateCheck = handlers.get("tool_result")(
    {
      toolName: "write",
      toolCallId: "edit-1",
      input: { path: filePath },
      details: {},
      isError: false,
    },
    ctx,
  );

  handlers.get("turn_end")(turnEnd(), ctx);
  await lateCheck;
  handlers.get("turn_end")(turnEnd("bash-1"), ctx);
  assert.deepEqual(messages, []);

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
    mkdir(path.join(workspace, "node_modules", "@types", "node"), { recursive: true }),
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

test("injects diagnostics from a versionless push publication", async (t) => {
  const previous = process.env.FAKE_PUSH_ONLY;
  process.env.FAKE_PUSH_ONLY = "1";
  t.after(() => {
    if (previous === undefined) delete process.env.FAKE_PUSH_ONLY;
    else process.env.FAKE_PUSH_ONLY = previous;
  });

  const workspace = await mkdtemp(path.join(os.tmpdir(), "pi-lsp-versionless-push-"));
  const filePath = path.join(workspace, "src", "sample.ts");
  await mkdir(path.join(workspace, ".pi"), { recursive: true });
  await mkdir(path.dirname(filePath), { recursive: true });
  await Promise.all([
    writeFile(path.join(workspace, "package.json"), "{}\n"),
    writeFile(filePath, "broken\n"),
    mkdir(path.join(workspace, "node_modules", "@types", "node"), { recursive: true }),
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
    isProjectTrusted: () => true,
    ui: { setStatus() {}, notify() {} },
  };

  lspFeedbackExtension(pi);
  await handlers.get("session_start")({}, ctx);
  await handlers.get("tool_result")(
    {
      toolName: "write",
      toolCallId: "edit-1",
      input: { path: filePath },
      details: {},
      isError: false,
    },
    ctx,
  );
  handlers.get("turn_end")(turnEnd("edit-1"), ctx);

  assert.equal(messages.length, 1);
  assert.match(messages[0].message.content, /FAKE100/);
  assert.deepEqual(messages[0].options, {
    deliverAs: "steer",
    triggerTurn: true,
  });

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

test("warns about invalid project overrides at session start", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "pi-lsp-invalid-config-"));
  await mkdir(path.join(workspace, ".pi"), { recursive: true });
  await writeFile(
    path.join(workspace, ".pi", "lsp-feedback.json"),
    JSON.stringify({ servers: { typescript: { enabled: "yes" } } }),
  );

  const commands = new Map();
  const handlers = new Map();
  const notifications = [];
  const pi = {
    on(name, handler) {
      handlers.set(name, handler);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
    sendMessage() {},
  };
  const ctx = {
    cwd: workspace,
    hasUI: true,
    signal: undefined,
    isProjectTrusted: () => true,
    ui: {
      notify(message, kind) {
        notifications.push({ message, kind });
      },
      setStatus() {},
    },
  };

  lspFeedbackExtension(pi);
  await handlers.get("session_start")({}, ctx);

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].kind, "warning");
  assert.match(notifications[0].message, /enabled must be a boolean/);

  await commands.get("lsp-feedback-status").handler({}, ctx);
  assert.equal(notifications.length, 2);
  assert.match(notifications[1].message, /enabled must be a boolean/);

  await handlers.get("session_shutdown")({}, ctx);
});
