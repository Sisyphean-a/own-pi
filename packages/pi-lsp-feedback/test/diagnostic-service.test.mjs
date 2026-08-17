import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DiagnosticService } from "../src/diagnostic-service.js";
import { BUILTIN_SERVERS, findWorkspaceRoot } from "../src/servers.js";

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
