import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadAdvisorConfig,
  normalizeSkipWhenCurrentModel,
  shouldSkipAdvisorForCurrentModel,
} from "../src/advisor-config.ts";

test("matches configured provider/model patterns without conflating providers", () => {
  const model = { provider: "openai-codex", id: "gpt-5.6-sol" } as any;

  assert.equal(shouldSkipAdvisorForCurrentModel(model, ["openai-codex/gpt-5.6-sol"]), true);
  assert.equal(shouldSkipAdvisorForCurrentModel(model, ["anthropic/gpt-5.6-sol"]), false);
  assert.equal(shouldSkipAdvisorForCurrentModel(model, ["openai-codex/*"]), true);
  assert.equal(shouldSkipAdvisorForCurrentModel(model, ["gpt-5.*"]), true);
  assert.equal(shouldSkipAdvisorForCurrentModel(model, ["openai-codex/gpt-5.5-sol"]), false);
});

test("normalizes comma-separated skip patterns and removes duplicates", () => {
  assert.deepEqual(
    normalizeSkipWhenCurrentModel([" openai-codex/gpt-5.6-sol ", "", "openai-codex/gpt-5.6-sol"]),
    ["openai-codex/gpt-5.6-sol"],
  );
  assert.deepEqual(
    normalizeSkipWhenCurrentModel("openai-codex/gpt-5.6-sol, gpt-5.7-sol"),
    ["openai-codex/gpt-5.6-sol", "gpt-5.7-sol"],
  );
});

test("证据转发默认关闭，超时配置只接受可用的整数范围", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-advisor-config-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    assert.equal(loadAdvisorConfig().includeToolEvidence, false);
    assert.equal(loadAdvisorConfig().timeoutMs, 60000);
    for (const timeoutMs of [0, -1, 1.5, 999, 2147483648, "5000"]) {
      await writeFile(join(dir, "advisor.json"), JSON.stringify({ timeoutMs, includeToolEvidence: "true" }));
      assert.equal(loadAdvisorConfig().timeoutMs, 60000);
      assert.equal(loadAdvisorConfig().includeToolEvidence, false);
    }
    await writeFile(join(dir, "advisor.json"), JSON.stringify({ timeoutMs: 5000, includeToolEvidence: true }));
    assert.equal(loadAdvisorConfig().timeoutMs, 5000);
    assert.equal(loadAdvisorConfig().includeToolEvidence, true);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
