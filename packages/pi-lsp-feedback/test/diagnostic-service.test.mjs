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
} from "../src/servers.js";

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

test("reports an unavailable server instead of a false clean result", async (t) => {
  const workspace = await mkdtemp(
    path.join(os.tmpdir(), "pi-lsp-missing-server-"),
  );
  const filePath = path.join(workspace, "sample.ts");
  await Promise.all([
    writeFile(path.join(workspace, "package.json"), "{}\n"),
    writeFile(filePath, "const value = 1;\n"),
  ]);

  const service = new DiagnosticService({
    workspaceRoot: workspace,
    overrides: {
      typescript: {
        command: "pi-lsp-feedback-command-that-does-not-exist",
        args: [],
        rootMarkers: ["package.json"],
      },
    },
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
  ]);

  const service = new DiagnosticService({ workspaceRoot: workspace });
  t.after(() => service.close());

  const outcome = await service.checkFile(filePath);
  assert.equal(outcome.status, "unconfirmed");
  assert.equal(outcome.serverId, "typescript");
  assert.deepEqual(
    outcome.diagnostics.map((diagnostic) => diagnostic.code),
    [2322],
  );
});

test("runs a configured TypeScript language server and returns its diagnostics", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "pi-lsp-service-"));
  const filePath = path.join(workspace, "src", "sample.ts");
  await mkdir(path.dirname(filePath), { recursive: true });
  await Promise.all([
    writeFile(path.join(workspace, "package.json"), "{}\n"),
    writeFile(filePath, "broken\n"),
  ]);

  const service = new DiagnosticService({
    workspaceRoot: workspace,
    overrides: {
      typescript: {
        command: process.execPath,
        args: [fakeServer],
        rootMarkers: ["package.json"],
      },
    },
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
    overrides: {
      go: {
        command: "pi-lsp-feedback-command-that-does-not-exist",
        args: [],
      },
    },
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
    overrides: {
      go: {
        command: "pi-lsp-feedback-command-that-does-not-exist",
        args: [],
      },
    },
  });
  t.after(() => untrustedService.close());
  const untrustedOutcome = await untrustedService.checkFile(filePath);
  assert.equal(untrustedOutcome.status, "unavailable");
  assert.match(untrustedOutcome.reason, /requires a trusted project/);
});
