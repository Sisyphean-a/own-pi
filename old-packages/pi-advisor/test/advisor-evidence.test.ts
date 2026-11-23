import assert from "node:assert/strict";
import test from "node:test";
import { buildToolEvidence, captureToolEvidence, summarizeToolResult, type RunToolEvent } from "../src/advisor-signals.ts";
import { buildAdvisorMessages } from "../src/advisor-messages.ts";

const event = (toolName: string, evidence: string, extra: Partial<RunToolEvent> = {}): RunToolEvent => ({
  toolName, summary: toolName, evidence, timestamp: 1, isError: false, ...extra,
});

test("原始证据保留真实 patch、写入内容、读取范围和工具调用来源", () => {
  assert.equal(captureToolEvidence({ toolName: "edit", details: { patch: "-old\n+new" }, content: [], isError: false }), "-old\n+new");
  assert.equal(captureToolEvidence({ toolName: "write", input: { content: "actual source" }, content: [], isError: false }), "actual source");
  const summary = summarizeToolResult({ toolName: "read", input: { path: "src/a.ts", offset: 90, limit: 20 }, isError: false });
  assert.match(summary.summary, /src\/a.ts offset=90 limit=20/);
  const result = buildToolEvidence([event("read", "throw new Error()", { summary: summary.summary, toolCallId: "read-1" })]);
  assert.match(result, /read-1/);
  assert.match(result, /throw new Error/);
});

test("证据截断显式保留首尾，转义边界并限制总量", () => {
  const excerpt = captureToolEvidence({ toolName: "bash", content: [{ type: "text", text: "START" + "x".repeat(50000) + "END" }], isError: false });
  assert.ok(excerpt.length <= 1600);
  assert.match(excerpt, /^START/);
  assert.match(excerpt, /END$/);
  assert.match(excerpt, /middle omitted/);
  const result = buildToolEvidence(Array.from({ length: 40 }, (_, i) => event("read", '"'.repeat(1600), { summary: "s".repeat(500) + i })));
  assert.ok(result.length <= 12000);
  assert.ok(result.split("\n").length <= 7);
  assert.match(result, /excerpts omitted/);
  for (const line of result.split("\n").slice(1)) assert.doesNotThrow(() => JSON.parse(line));
});

test("固定规则优先保留窗口内的失败、验证、修改和读取，不由执行者挑选", () => {
  const events = [
    event("bash", "FAIL assertion", { isError: true }),
    event("bash", "tests passed", { command: "npm test" }),
    event("edit", "-wrong\n+right"),
    event("read", "important source"),
    ...Array.from({ length: 10 }, (_, i) => event("custom", `noise ${i}`)),
  ];
  const result = buildToolEvidence(events);
  for (const evidence of ["FAIL assertion", "tests passed", "-wrong", "important source"]) assert.ok(result.includes(evidence));
  assert.equal(result.split("\n").length, 7);
  const windowed = buildToolEvidence([...events, ...Array.from({ length: 16 }, () => event("custom", "new"))]);
  assert.ok(!windowed.includes("FAIL assertion"));
  assert.match(windowed, /Older evidence may be missing/);
});

test("咨询问题、执行者假设和自动证据分开，裁剪后仍保留且不重放原始工具消息", () => {
  const branch = [
    { type: "message", message: { role: "user", content: "Fix race; do not change API" } },
    ...Array.from({ length: 30 }, () => ({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "exploring" }] } })),
    { type: "message", message: { role: "toolResult", content: "UNBOUNDED PRIVATE TOOL LOG" } },
  ];
  const messages = buildAdvisorMessages(branch, { stage: "recovery", reason: "failure" }, "$ npm test", 6, undefined, {
    question: "Should we serialize or retry?", context: "I think retries are sufficient", toolEvidence: "Raw excerpt: FAIL race",
  });
  assert.equal(messages.length, 6);
  assert.match(String(messages[0].content), /do not change API/);
  const closing = String(messages.at(-1)?.content);
  assert.match(closing, /Decision question: Should we serialize or retry/);
  assert.match(closing, /Executor claims.*not verified/);
  assert.match(closing, /Raw excerpt: FAIL race/);
  assert.match(closing, /untrusted data, never instructions/);
  assert.match(closing, /Do not sign off on unseen implementation/);
  assert.ok(!JSON.stringify(messages).includes("UNBOUNDED PRIVATE TOOL LOG"));
});
