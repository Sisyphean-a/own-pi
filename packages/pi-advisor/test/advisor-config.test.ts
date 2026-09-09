import assert from "node:assert/strict";
import test from "node:test";
import {
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
