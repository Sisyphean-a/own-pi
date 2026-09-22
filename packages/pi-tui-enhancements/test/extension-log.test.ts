import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { logFailure } from "../src/extension-log.ts";

test("writes failures to a file without touching the terminal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-tui-enhancements-log-"));
  const logPath = join(directory, "nested", "errors.ndjson");
  const originalConsoleError = console.error;
  let consoleWrites = 0;
  console.error = () => {
    consoleWrites += 1;
  };

  try {
    logFailure("描述翻译", "400: invalid reasoning_effort", logPath);
    const entries = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].scope, "描述翻译");
    assert.equal(entries[0].message, "400: invalid reasoning_effort");
    assert.match(entries[0].ts, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(consoleWrites, 0);

    const unwritablePath = join(directory, "directory-as-log");
    await mkdir(unwritablePath);
    assert.doesNotThrow(() => logFailure("日志", "写入失败", unwritablePath));
    assert.equal(consoleWrites, 0);
  } finally {
    console.error = originalConsoleError;
    await rm(directory, { recursive: true, force: true });
  }
});
