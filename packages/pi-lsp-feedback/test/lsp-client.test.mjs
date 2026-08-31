import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { LspClient } from "../src/lsp-client.js";

const fakeServer = path.join(import.meta.dirname, "fake-lsp.mjs");

async function startClient(env = {}, serverId = "fake", options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-lsp-feedback-"));
  return LspClient.start({
    command: process.execPath,
    args: [fakeServer],
    root,
    serverId,
    initializationOptions: undefined,
    env,
    ...options,
  });
}

test("does not send a queued check after it is cancelled", async (t) => {
  const client = await startClient();
  t.after(() => client.close());
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    client.checkDocument(
      path.join(client.root, "sample.ts"),
      "broken",
      "typescript",
      controller.signal,
    ),
    (error) => error?.name === "AbortError",
  );
  assert.equal(client.documents.size, 0);
});

test("bounds per-file state and evicts the least recently checked document", async (t) => {
  const client = await startClient({}, "fake", { maxTrackedDocuments: 1 });
  t.after(() => client.close());
  const firstPath = path.join(client.root, "first.ts");
  const secondPath = path.join(client.root, "second.ts");
  const firstRawUri = pathToFileURL(firstPath).href;
  const secondRawUri = pathToFileURL(secondPath).href;
  const firstUri = process.platform === "win32" ? firstRawUri.toLowerCase() : firstRawUri;
  const secondUri = process.platform === "win32" ? secondRawUri.toLowerCase() : secondRawUri;

  await client.checkDocument(firstPath, "clean", "typescript");
  const firstVersion = client.documents.get(firstUri).version;
  assert.equal("text" in client.documents.get(firstUri), false);

  await client.checkDocument(secondPath, "clean", "typescript");

  assert.equal(client.documents.size, 1);
  assert.equal(client.documents.has(firstUri), false);
  assert.equal(client.documents.has(secondUri), true);
  assert.equal(client.publications.has(firstUri), false);
  assert.equal(client.latestPublicationVersions.has(firstUri), false);
  assert.equal(client.typeScriptDiagnosticsAttempted.has(firstUri), false);
  assert.equal(client.documents.get(secondUri).version > firstVersion, true);

  const reopened = await client.checkDocument(firstPath, "broken", "typescript");
  assert.equal(reopened.status, "confirmed");
  assert.deepEqual(
    reopened.diagnostics.map((diagnostic) => diagnostic.code),
    ["FAKE100"],
  );
  assert.equal(client.documents.size, 1);
  assert.equal(client.documents.has(firstUri), true);
  assert.equal(client.documents.has(secondUri), false);
});

test("cancels an in-flight diagnostic request", async (t) => {
  const previousDelay = process.env.FAKE_DIAGNOSTIC_DELAY_MS;
  process.env.FAKE_DIAGNOSTIC_DELAY_MS = "1000";
  t.after(() => {
    if (previousDelay === undefined) delete process.env.FAKE_DIAGNOSTIC_DELAY_MS;
    else process.env.FAKE_DIAGNOSTIC_DELAY_MS = previousDelay;
  });

  const client = await startClient();
  t.after(() => client.close());
  const controller = new AbortController();
  const check = client.checkDocument(
    path.join(client.root, "sample.ts"),
    "broken",
    "typescript",
    controller.signal,
  );
  setTimeout(() => controller.abort(), 25);

  await assert.rejects(check, (error) => error?.name === "AbortError");
});

test("cancels initialization when the request signal aborts", async (t) => {
  const previousDelay = process.env.FAKE_INITIALIZE_DELAY_MS;
  process.env.FAKE_INITIALIZE_DELAY_MS = "1000";
  t.after(() => {
    if (previousDelay === undefined) delete process.env.FAKE_INITIALIZE_DELAY_MS;
    else process.env.FAKE_INITIALIZE_DELAY_MS = previousDelay;
  });

  const root = await mkdtemp(path.join(os.tmpdir(), "pi-lsp-feedback-"));
  const controller = new AbortController();
  const start = LspClient.start({
    command: process.execPath,
    args: [fakeServer],
    root,
    serverId: "fake",
    initializationOptions: undefined,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 25);

  await assert.rejects(start, (error) => error?.name === "AbortError");
});

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

test("accepts a fresh versionless push publication as confirmed", async (t) => {
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

  assert.equal(outcome.status, "confirmed");
  assert.deepEqual(
    outcome.diagnostics.map((diagnostic) => diagnostic.code),
    ["FAKE100"],
  );
});

test("waits for the current version after a stale push publication", async (t) => {
  const previousPushOnly = process.env.FAKE_PUSH_ONLY;
  const previousReorder = process.env.FAKE_VERSIONED_REORDER;
  process.env.FAKE_PUSH_ONLY = "1";
  process.env.FAKE_VERSIONED_REORDER = "1";
  t.after(() => {
    if (previousPushOnly === undefined) delete process.env.FAKE_PUSH_ONLY;
    else process.env.FAKE_PUSH_ONLY = previousPushOnly;
    if (previousReorder === undefined) delete process.env.FAKE_VERSIONED_REORDER;
    else process.env.FAKE_VERSIONED_REORDER = previousReorder;
  });

  const client = await startClient();
  t.after(() => client.close());
  const outcome = await client.checkDocument(
    path.join(client.root, "sample.ts"),
    "broken",
    "typescript",
  );

  assert.equal(outcome.status, "confirmed");
  assert.deepEqual(
    outcome.diagnostics.map((diagnostic) => diagnostic.code),
    ["FAKE100"],
  );
});

test("uses semantic diagnostics when TypeScript also advertises pull diagnostics", async (t) => {
  const previousCommand = process.env.FAKE_TS_SERVER_REQUEST;
  const previousPullEmpty = process.env.FAKE_PULL_EMPTY;
  process.env.FAKE_TS_SERVER_REQUEST = "1";
  process.env.FAKE_PULL_EMPTY = "1";
  t.after(() => {
    if (previousCommand === undefined) delete process.env.FAKE_TS_SERVER_REQUEST;
    else process.env.FAKE_TS_SERVER_REQUEST = previousCommand;
    if (previousPullEmpty === undefined) delete process.env.FAKE_PULL_EMPTY;
    else process.env.FAKE_PULL_EMPTY = previousPullEmpty;
  });

  const client = await startClient({}, "typescript");
  t.after(() => client.close());
  const outcome = await client.checkDocument(
    path.join(client.root, "sample.ts"),
    "broken",
    "typescript",
  );

  assert.equal(outcome.status, "confirmed");
  assert.deepEqual(
    outcome.diagnostics.map((diagnostic) => diagnostic.code),
    ["FAKE100"],
  );
});

test("does not reuse a cached stale publication while waiting", async (t) => {
  const client = await startClient();
  t.after(() => client.close());
  const filePath = path.join(client.root, "sample.ts");
  const rawUri = pathToFileURL(filePath).href;
  const uri = process.platform === "win32" ? rawUri.toLowerCase() : rawUri;

  client.recordPublication({ uri, version: 0, diagnostics: [] });
  const waiting = client.waitForPublication(uri, 1, 0, undefined, 1000);
  setTimeout(() => client.recordPublication({ uri, version: 1, diagnostics: [] }), 25);

  const publication = await waiting;
  assert.equal(publication.version, 1);
});

test("keeps a newer cached publication when an older one arrives", async (t) => {
  const client = await startClient();
  t.after(() => client.close());
  const filePath = path.join(client.root, "sample.ts");
  const rawUri = pathToFileURL(filePath).href;
  const uri = process.platform === "win32" ? rawUri.toLowerCase() : rawUri;

  client.recordPublication({
    uri,
    version: 1,
    diagnostics: [{ message: "current", code: 1 }],
  });
  client.recordPublication({ uri, version: 0, diagnostics: [] });

  const publication = await client.waitForPublication(uri, 1, 0, undefined, 1000);
  assert.equal(publication.version, 1);
  assert.equal(publication.diagnostics[0].message, "current");
});

test("does not let an older version replace a fresh versionless publication", async (t) => {
  const client = await startClient();
  t.after(() => client.close());
  const filePath = path.join(client.root, "sample.ts");
  const rawUri = pathToFileURL(filePath).href;
  const uri = process.platform === "win32" ? rawUri.toLowerCase() : rawUri;

  client.recordPublication({
    uri,
    version: 5,
    diagnostics: [{ message: "current", code: 5 }],
  });
  client.recordPublication({
    uri,
    diagnostics: [{ message: "versionless", code: 6 }],
  });
  client.recordPublication({
    uri,
    version: 4,
    diagnostics: [{ message: "old", code: 4 }],
  });

  const publication = client.publications.get(uri);
  assert.equal(publication.version, undefined);
  assert.equal(publication.diagnostics[0].message, "versionless");
});

test("answers optional client requests before collecting push diagnostics", async (t) => {
  const previousPushOnly = process.env.FAKE_PUSH_ONLY;
  const previousClientRequests = process.env.FAKE_REQUIRE_CLIENT_REQUESTS;
  process.env.FAKE_PUSH_ONLY = "1";
  process.env.FAKE_REQUIRE_CLIENT_REQUESTS = "1";
  t.after(() => {
    if (previousPushOnly === undefined) delete process.env.FAKE_PUSH_ONLY;
    else process.env.FAKE_PUSH_ONLY = previousPushOnly;
    if (previousClientRequests === undefined) delete process.env.FAKE_REQUIRE_CLIENT_REQUESTS;
    else process.env.FAKE_REQUIRE_CLIENT_REQUESTS = previousClientRequests;
  });

  const client = await startClient();
  t.after(() => client.close());
  const outcome = await client.checkDocument(
    path.join(client.root, "sample.ts"),
    "broken",
    "typescript",
  );

  assert.equal(outcome.status, "confirmed");
  assert.deepEqual(
    outcome.diagnostics.map((diagnostic) => diagnostic.code),
    ["FAKE100"],
  );
});

test("forces diagnostics for a cold TypeScript language server", async (t) => {
  const previousPushOnly = process.env.FAKE_PUSH_ONLY;
  const previousCommand = process.env.FAKE_TS_SERVER_REQUEST;
  const previousCommandOnly = process.env.FAKE_COMMAND_ONLY;
  const previousResponseOnly = process.env.FAKE_COMMAND_RESPONSE_ONLY;
  process.env.FAKE_PUSH_ONLY = "1";
  process.env.FAKE_TS_SERVER_REQUEST = "1";
  process.env.FAKE_COMMAND_ONLY = "1";
  process.env.FAKE_COMMAND_RESPONSE_ONLY = "1";
  t.after(() => {
    if (previousPushOnly === undefined) delete process.env.FAKE_PUSH_ONLY;
    else process.env.FAKE_PUSH_ONLY = previousPushOnly;
    if (previousCommand === undefined) delete process.env.FAKE_TS_SERVER_REQUEST;
    else process.env.FAKE_TS_SERVER_REQUEST = previousCommand;
    if (previousCommandOnly === undefined) delete process.env.FAKE_COMMAND_ONLY;
    else process.env.FAKE_COMMAND_ONLY = previousCommandOnly;
    if (previousResponseOnly === undefined) delete process.env.FAKE_COMMAND_RESPONSE_ONLY;
    else process.env.FAKE_COMMAND_RESPONSE_ONLY = previousResponseOnly;
  });

  const client = await startClient({}, "typescript");
  t.after(() => client.close());
  const outcome = await client.checkDocument(
    path.join(client.root, "sample.ts"),
    "broken",
    "typescript",
  );

  assert.equal(outcome.status, "confirmed");
  assert.deepEqual(
    outcome.diagnostics.map((diagnostic) => diagnostic.code),
    ["FAKE100"],
  );
});