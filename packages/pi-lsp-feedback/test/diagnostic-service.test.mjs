import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DiagnosticService } from "../src/diagnostic-service.js";
import {
  BUILTIN_SERVERS,
  commandCandidates,
  findTypeScriptSdk,
  findWorkspaceRoot,
  languageIdForFile,
  resolveServerOverrides,
} from "../src/servers.js";

const nodeTypesDir = (workspace) => path.join(workspace, "node_modules", "@types", "node");
const WITH_NODE_TYPES = { recursive: true };

const fakeServer = path.join(import.meta.dirname, "fake-lsp.mjs");

test("uses the nearest frontend package as the Vue root in a Wails workspace", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "pi-wails-root-"));
  const frontend = path.join(workspace, "frontend");
  const vueFile = path.join(frontend, "src", "App.vue");
  await mkdir(path.dirname(vueFile), { recursive: true });
  await Promise.all([
    writeFile(path.join(workspace, "go.mod"), "module example.test/app\n"),
    writeFile(path.join(frontend, "package.json"), "{}\n"),
    writeFile(vueFile, "<template />\n"),
  ]);

  const vue = BUILTIN_SERVERS.find((server) => server.id === "vue");
  assert.equal(findWorkspaceRoot(vueFile, workspace, vue), frontend);

  const go = BUILTIN_SERVERS.find((server) => server.id === "go");
  assert.equal(
    findWorkspaceRoot(path.join(workspace, "main.go"), workspace, go),
    workspace,
  );
});

test("uses React language IDs for TypeScript React files", () => {
  const typescript = BUILTIN_SERVERS.find((server) => server.id === "typescript");

  assert.equal(languageIdForFile(typescript, "src/App.tsx"), "typescriptreact");
  assert.equal(languageIdForFile(typescript, "src/App.jsx"), "javascriptreact");
  assert.equal(languageIdForFile(typescript, "src/main.ts"), "typescript");
});

test("reports an unavailable server instead of a false clean result", async (t) => {
  const workspace = await mkdtemp(
    path.join(os.tmpdir(), "pi-lsp-missing-server-"),
  );
  const filePath = path.join(workspace, "sample.ts");
  await Promise.all([
    writeFile(path.join(workspace, "package.json"), "{}\n"),
    writeFile(filePath, "const value = 1;\n"),
    mkdir(nodeTypesDir(workspace), WITH_NODE_TYPES),
  ]);

  const service = new DiagnosticService({
    workspaceRoot: workspace,
    servers: resolveServerOverrides({
      typescript: {
        command: "pi-lsp-feedback-command-that-does-not-exist",
        args: [],
        rootMarkers: ["package.json"],
      },
    }).servers,
  });
  t.after(() => service.close());

  const outcome = await service.checkFile(filePath);
  assert.equal(outcome.status, "unavailable");
  assert.match(outcome.reason, /could not start/);
});

test("uses package-bundled Node LSP binaries without project dependencies", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "pi-lsp-bundled-"));
  const bundledServerIds = new Set(["vue", "typescript", "python", "html"]);
  const bundledServers = BUILTIN_SERVERS
    .filter((server) => bundledServerIds.has(server.id))
    .map((server) => ({ server, command: server.commands[0] }));

  for (const { server, command } of bundledServers) {
    const [candidate] = commandCandidates(workspace, workspace, command.command);
    assert.ok(existsSync(candidate), `${server.id} must resolve to a Node executable`);
    assert.ok(existsSync(command.args[0]), `${server.id} must include its package-bundled entrypoint`);
  }

  const sdk = findTypeScriptSdk(workspace, workspace);
  assert.ok(sdk?.endsWith(path.join("node_modules", "typescript", "lib")));
});

test("reports diagnostics through the bundled TypeScript server", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "pi-lsp-bundled-typescript-"));
  const filePath = path.join(workspace, "sample.ts");
  await Promise.all([
    writeFile(path.join(workspace, "package.json"), "{}\n"),
    writeFile(filePath, "const value: string = 1;\n"),
    mkdir(nodeTypesDir(workspace), WITH_NODE_TYPES),
  ]);

  const service = new DiagnosticService({ workspaceRoot: workspace });
  t.after(() => service.close());

  const outcome = await service.checkFile(filePath);
  assert.equal(outcome.status, "confirmed");
  assert.equal(outcome.serverId, "typescript");
  assert.deepEqual(
    outcome.diagnostics.map((diagnostic) => diagnostic.code),
    [2322],
  );
});

test("reports diagnostics through the bundled Vue language server", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "pi-lsp-bundled-vue-"));
  const filePath = path.join(workspace, "src", "App.vue");
  await mkdir(path.dirname(filePath), { recursive: true });
  await Promise.all([
    writeFile(path.join(workspace, "package.json"), "{}\n"),
    writeFile(
      path.join(workspace, "tsconfig.json"),
      JSON.stringify({ include: ["src"] }),
    ),
    writeFile(filePath, "<template><main></template>\n"),
  ]);

  const service = new DiagnosticService({ workspaceRoot: workspace });
  t.after(() => service.close());

  const outcome = await service.checkFile(filePath);
  assert.equal(outcome.status, "confirmed");
  assert.equal(outcome.serverId, "vue");
  assert.ok(outcome.diagnostics.some((diagnostic) => diagnostic.code === 24));
});

test("reports TypeScript diagnostics through the Vue bridge", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "pi-lsp-bundled-vue-ts-"));
  const filePath = path.join(workspace, "src", "App.vue");
  await mkdir(path.dirname(filePath), { recursive: true });
  await Promise.all([
    writeFile(path.join(workspace, "package.json"), "{}\n"),
    writeFile(
      path.join(workspace, "tsconfig.json"),
      JSON.stringify({ include: ["src"] }),
    ),
    writeFile(
      filePath,
      "<script setup lang=\"ts\">\nconst value: string = 1;\n</script>\n<template><main /></template>\n",
    ),
  ]);

  const service = new DiagnosticService({ workspaceRoot: workspace });
  t.after(() => service.close());

  const outcome = await service.checkFile(filePath);
  assert.equal(outcome.status, "confirmed");
  assert.ok(outcome.diagnostics.some((diagnostic) => diagnostic.code === 2322));
});

test("parses bundled TypeScript React files as TSX", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "pi-lsp-bundled-tsx-"));
  const filePath = path.join(workspace, "src", "App.tsx");
  await mkdir(path.dirname(filePath), { recursive: true });
  await Promise.all([
    writeFile(path.join(workspace, "package.json"), "{}\n"),
    writeFile(
      path.join(workspace, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { jsx: "preserve", strict: true },
        include: ["src"],
      }),
    ),
    writeFile(
      filePath,
      "declare namespace JSX { interface IntrinsicElements { div: {}; } }\nconst element = <div />;\n",
    ),
    mkdir(nodeTypesDir(workspace), WITH_NODE_TYPES),
  ]);

  const service = new DiagnosticService({ workspaceRoot: workspace });
  t.after(() => service.close());

  const outcome = await service.checkFile(filePath);
  assert.equal(outcome.status, "confirmed");
  assert.deepEqual(outcome.diagnostics, []);
});

test("runs a configured TypeScript language server and returns its diagnostics", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "pi-lsp-service-"));
  const filePath = path.join(workspace, "src", "sample.ts");
  await mkdir(path.dirname(filePath), { recursive: true });
  await Promise.all([
    writeFile(path.join(workspace, "package.json"), "{}\n"),
    writeFile(filePath, "broken\n"),
    mkdir(nodeTypesDir(workspace), WITH_NODE_TYPES),
  ]);

  const service = new DiagnosticService({
    workspaceRoot: workspace,
    servers: resolveServerOverrides({
      typescript: {
        command: process.execPath,
        args: [fakeServer],
        rootMarkers: ["package.json"],
      },
    }).servers,
  });
  t.after(() => service.close());

  const outcome = await service.checkFile(filePath);
  assert.equal(outcome.status, "confirmed");
  assert.equal(outcome.serverId, "typescript");
  assert.equal(outcome.root, workspace);
  assert.deepEqual(
    outcome.diagnostics.map((diagnostic) => diagnostic.code),
    ["FAKE100"],
  );
});

test("discards diagnostics when the file changes during the check", async (t) => {
  const previousDelay = process.env.FAKE_DIAGNOSTIC_DELAY_MS;
  process.env.FAKE_DIAGNOSTIC_DELAY_MS = "100";
  t.after(() => {
    if (previousDelay === undefined) delete process.env.FAKE_DIAGNOSTIC_DELAY_MS;
    else process.env.FAKE_DIAGNOSTIC_DELAY_MS = previousDelay;
  });

  const workspace = await mkdtemp(path.join(os.tmpdir(), "pi-lsp-stale-check-"));
  const filePath = path.join(workspace, "src", "sample.ts");
  await mkdir(path.dirname(filePath), { recursive: true });
  await Promise.all([
    writeFile(path.join(workspace, "package.json"), "{}\n"),
    writeFile(filePath, "broken\n"),
    mkdir(nodeTypesDir(workspace), WITH_NODE_TYPES),
  ]);

  const service = new DiagnosticService({
    workspaceRoot: workspace,
    servers: resolveServerOverrides({
      typescript: {
        command: process.execPath,
        args: [fakeServer],
        rootMarkers: ["package.json"],
      },
    }).servers,
  });
  t.after(() => service.close());

  const check = service.checkFile(filePath);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await writeFile(filePath, "clean\n");

  const outcome = await check;
  assert.equal(outcome.status, "unconfirmed");
  assert.deepEqual(outcome.diagnostics, []);
  assert.match(outcome.reason, /file changed while diagnostics were collected/);
});

test("installs gopls only for trusted projects when it is unavailable", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "pi-lsp-managed-go-"));
  const filePath = path.join(workspace, "main.go");
  await Promise.all([
    writeFile(path.join(workspace, "go.mod"), "module example.test/app\n"),
    writeFile(filePath, "package main\n"),
  ]);

  let installAttempts = 0;
  const service = new DiagnosticService({
    workspaceRoot: workspace,
    allowManagedInstall: true,
    managedInstaller: async (serverId) => {
      installAttempts += 1;
      assert.equal(serverId, "gopls");
      return false;
    },
    servers: resolveServerOverrides({
      go: {
        command: "pi-lsp-feedback-command-that-does-not-exist",
        args: [],
      },
    }).servers,
  });
  t.after(() => service.close());

  const outcome = await service.checkFile(filePath);
  assert.equal(outcome.status, "unavailable");
  assert.equal(installAttempts, 1);

  const repeatedOutcome = await service.checkFile(filePath);
  assert.equal(repeatedOutcome.status, "unavailable");
  assert.equal(installAttempts, 1);

  const untrustedService = new DiagnosticService({
    workspaceRoot: workspace,
    managedInstaller: async () => {
      throw new Error("untrusted project must not install gopls");
    },
    servers: resolveServerOverrides({
      go: {
        command: "pi-lsp-feedback-command-that-does-not-exist",
        args: [],
      },
    }).servers,
  });
  t.after(() => untrustedService.close());
  const untrustedOutcome = await untrustedService.checkFile(filePath);
  assert.equal(untrustedOutcome.status, "unavailable");
  assert.match(untrustedOutcome.reason, /requires a trusted project/);
});

test("silences TypeScript checks when @types/node is not available", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "pi-lsp-no-nodetypes-"));
  const filePath = path.join(workspace, "sample.ts");
  await Promise.all([
    writeFile(path.join(workspace, "package.json"), "{}\n"),
    writeFile(filePath, "import { readFileSync } from \"node:fs\";\n"),
  ]);

  const service = new DiagnosticService({ workspaceRoot: workspace });
  t.after(() => service.close());

  const outcome = await service.checkFile(filePath);
  assert.equal(outcome.status, "unavailable");
  assert.match(outcome.reason, /@types\/node/);
});
