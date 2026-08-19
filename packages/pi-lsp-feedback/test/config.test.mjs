import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CONFIG_PATH, loadProjectConfiguration } from "../src/config.js";
import { BUILTIN_SERVERS } from "../src/servers.js";

const builtinIds = BUILTIN_SERVERS.map((server) => server.id);

async function workspaceWithConfig(contents) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-lsp-config-"));
  await mkdir(path.join(cwd, ".pi"), { recursive: true });
  await writeFile(path.join(cwd, CONFIG_PATH), contents);
  return cwd;
}

test("ignores project configuration for untrusted projects", async () => {
  const cwd = await workspaceWithConfig(
    JSON.stringify({ servers: { typescript: { enabled: false } } }),
  );
  const config = await loadProjectConfiguration(cwd, false);

  assert.deepEqual(config.issues, []);
  assert.deepEqual(config.servers.map((server) => server.id), builtinIds);
});

test("uses built-in servers when no configuration file exists", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-lsp-config-missing-"));
  const config = await loadProjectConfiguration(cwd, true);

  assert.deepEqual(config.issues, []);
  assert.deepEqual(config.servers.map((server) => server.id), builtinIds);
});

test("applies a valid trusted override", async () => {
  const cwd = await workspaceWithConfig(
    JSON.stringify({
      servers: {
        typescript: {
          command: "custom-ts",
          args: ["--stdio"],
          rootMarkers: ["tsconfig.json"],
          fallbackToWorkspace: true,
        },
      },
    }),
  );

  const config = await loadProjectConfiguration(cwd, true);
  assert.deepEqual(config.issues, []);

  const typescript = config.servers.find((server) => server.id === "typescript");
  assert.deepEqual(typescript.commands, [
    { command: "custom-ts", args: ["--stdio"], bundled: false },
  ]);
  assert.deepEqual(typescript.rootMarkers, ["tsconfig.json"]);
  assert.equal(typescript.fallbackToWorkspace, true);
});

test("removes a server enabled as false", async () => {
  const cwd = await workspaceWithConfig(
    JSON.stringify({ servers: { typescript: { enabled: false } } }),
  );
  const config = await loadProjectConfiguration(cwd, true);

  assert.deepEqual(config.issues, []);
  assert.ok(!config.servers.some((server) => server.id === "typescript"));
});

test("reports unknown servers and invalid override fields", async () => {
  const cwd = await workspaceWithConfig(
    JSON.stringify({
      servers: {
        typescript: {
          enabled: "yes",
          command: 42,
          args: ["ok", 3],
          rootMarkers: "package.json",
          fallbackToWorkspace: "no",
          typoField: true,
        },
        pyright: {},
      },
    }),
  );

  const config = await loadProjectConfiguration(cwd, true);
  const joined = config.issues.join("\n");

  assert.match(joined, /pyright: unknown server id/);
  assert.match(joined, /typescript: unknown field "typoField"/);
  assert.match(joined, /enabled must be a boolean/);
  assert.match(joined, /command must be a string/);
  assert.match(joined, /args must be an array of strings/);
  assert.match(joined, /rootMarkers must be an array of strings/);
  assert.match(joined, /fallbackToWorkspace must be a boolean/);

  const typescript = config.servers.find((server) => server.id === "typescript");
  assert.ok(typescript);
  assert.equal(typescript.commands.length, 1);
});

test("reports args without a command override", async () => {
  const cwd = await workspaceWithConfig(
    JSON.stringify({ servers: { python: { args: ["--stdio"] } } }),
  );
  const config = await loadProjectConfiguration(cwd, true);

  assert.match(config.issues.join("\n"), /args only applies together with command/);
});

test("reports unknown top-level configuration fields", async () => {
  const cwd = await workspaceWithConfig(JSON.stringify({ sovrers: {} }));
  const config = await loadProjectConfiguration(cwd, true);

  assert.match(config.issues.join("\n"), /unknown field "sovrers"/);
  assert.deepEqual(config.servers.map((server) => server.id), builtinIds);
});

test("keeps built-in servers when the configuration shape is invalid", async () => {
  const cwd = await workspaceWithConfig(JSON.stringify({ servers: [] }));
  const config = await loadProjectConfiguration(cwd, true);

  assert.match(config.issues.join("\n"), /servers must contain an object/);
  assert.deepEqual(config.servers.map((server) => server.id), builtinIds);
});

test("keeps built-in servers when JSON parsing fails", async () => {
  const cwd = await workspaceWithConfig("{ invalid json");
  const config = await loadProjectConfiguration(cwd, true);

  assert.equal(config.issues.length, 1);
  assert.deepEqual(config.servers.map((server) => server.id), builtinIds);
});