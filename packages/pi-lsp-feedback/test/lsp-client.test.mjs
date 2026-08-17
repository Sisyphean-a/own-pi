import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LspClient } from "../src/lsp-client.js";

const fakeServer = path.join(import.meta.dirname, "fake-lsp.mjs");

async function startClient(env = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-lsp-feedback-"));
  return LspClient.start({
    command: process.execPath,
    args: [fakeServer],
    root,
    serverId: "fake",
    initializationOptions: undefined,
    env,
  });
}

test("returns confirmed pull diagnostics for the current document", async (t) => {
  const client = await startClient();
  t.after(() => client.close());

  const broken = await client.checkDocument(
    path.join(client.root, "sample.ts"),
    "broken",
    "typescript",
  );
  assert.equal(broken.status, "confirmed");
  assert.deepEqual(
    broken.diagnostics.map((diagnostic) => diagnostic.code),
    ["FAKE100"],
  );

  const clean = await client.checkDocument(
    path.join(client.root, "sample.ts"),
    "clean",
    "typescript",
  );
  assert.equal(clean.status, "confirmed");
  assert.deepEqual(clean.diagnostics, []);
});

test("does not call a versionless push publication confirmed", async (t) => {
  const previous = process.env.FAKE_PUSH_ONLY;
  process.env.FAKE_PUSH_ONLY = "1";
  t.after(() => {
    if (previous === undefined) delete process.env.FAKE_PUSH_ONLY;
    else process.env.FAKE_PUSH_ONLY = previous;
  });

  const client = await startClient();
  t.after(() => client.close());
  const outcome = await client.checkDocument(
    path.join(client.root, "sample.ts"),
    "broken",
    "typescript",
  );

  assert.equal(outcome.status, "unconfirmed");
  assert.deepEqual(
    outcome.diagnostics.map((diagnostic) => diagnostic.code),
    ["FAKE100"],
  );
});
