import assert from "node:assert/strict";
import test from "node:test";
import {
  buildExecutorSignals,
  detectStage,
  isVerificationCommand,
  summarizeToolResult,
} from "../src/advisor-signals.ts";

test("recognizes verification commands by their leading pipeline segment", () => {
  assert.equal(isVerificationCommand("npm test && npm run lint"), true);
  assert.equal(isVerificationCommand("FOO=1 npx vitest run"), true);
  assert.equal(isVerificationCommand("cat tests/foo.test.ts"), false);
});

test("detects final-check after a mutation and verification command", () => {
  const events = [
    { toolName: "edit", summary: "edit src/app.ts", isError: false, timestamp: 1 },
    { toolName: "bash", command: "npm test", summary: "$ npm test", isError: false, timestamp: 2 },
  ];

  assert.equal(detectStage(events, 1).stage, "final-check");
  assert.deepEqual(buildExecutorSignals(events), {
    phase: "verifying",
    mutationsCount: 1,
    verificationCommands: ["npm test"],
    recentFailures: [],
  });
});

test("uses recent failures as recovery evidence", () => {
  const events = [
    { toolName: "bash", command: "npm test", summary: "$ npm test (exit 1)", isError: true, timestamp: 1 },
  ];

  assert.equal(detectStage(events, 1).stage, "recovery");
  assert.equal(buildExecutorSignals(events).phase, "stuck");
});

test("summarizes edit results without replaying the patch", () => {
  const result = summarizeToolResult({
    toolName: "edit",
    input: { path: "src/app.ts" },
    content: [{ type: "text", text: "full patch content" }],
    details: { patch: "--- old\n+++ new\n-old\n+new" },
    isError: false,
  });

  assert.equal(result.summary, "edit src/app.ts (+1/-1)");
});
