import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { registerApiProvider, unregisterApiProviders } from "@earendil-works/pi-ai/compat";
import advisorExtension from "../src/advisor.ts";

// 使用本地假 provider 穿过真实 agent loop；不访问网络或生产配置。
test("真实工具入口按配置自动附证据，问题必填，失败仍记录和返回完整用量", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-advisor-consult-"));
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const configPath = join(dir, "advisor.json");
  const api = "advisor-test-api" as any;
  const model = { api, provider: "local-test", id: "advisor", reasoning: true } as any;
  const usage = { input: 10, output: 5, cacheRead: 20, cacheWrite: 4, totalTokens: 39,
    cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 } };
  const requests: any[] = [], entries: any[] = [], notifications: any[] = [];
  let response: Record<string, unknown> = {};
  const stream = ((_model: any, context: any) => {
    requests.push(context);
    const events = createAssistantMessageEventStream();
    const message = { role: "assistant", api, provider: model.provider, model: model.id,
      content: [{ type: "text", text: "On track: evidence reviewed" }], usage, stopReason: "stop", timestamp: Date.now(), ...response } as any;
    events.push({ type: "start", partial: message });
    if (message.stopReason === "error" || message.stopReason === "aborted") events.push({ type: "error", reason: message.stopReason, error: message });
    else events.push({ type: "done", reason: message.stopReason, message });
    return events;
  }) as any;
  registerApiProvider({ api, stream, streamSimple: stream }, "advisor-consult-test");
  try {
    let tool: any;
    const handlers = new Map<string, (...args: any[]) => any>();
    const pi = {
      on: (name: string, handler: any) => handlers.set(name, handler),
      registerTool: (value: any) => { tool = value; }, registerCommand() {},
      getActiveTools: () => ["advisor", "read", "bash"], getAllTools: () => [], setActiveTools() {},
      appendEntry: (type: string, data: any) => entries.push({ type, data }),
      events: { emit: (channel: string, data: any) => notifications.push({ channel, data }) },
    } as any;
    const ctx = {
      model: { provider: "executor", id: "worker" },
      modelRegistry: { find: () => model, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-only" }) },
      sessionManager: { getSessionId: () => "local-session", getBranch: () => [
        { type: "message", message: { role: "user", content: "Fix race without changing public API", timestamp: Date.now() } },
      ] },
      getSystemPrompt: () => "Executor instructions",
    } as any;
    await writeFile(configPath, JSON.stringify({ enabled: true, provider: model.provider, model: model.id }));
    advisorExtension(pi);
    await handlers.get("agent_start")?.();
    assert.ok(tool.parameters.required.includes("question"));
    const invalid = await tool.execute("missing", { question: "  " }, undefined, undefined, ctx);
    assert.equal(invalid.details.error, "missing_question");
    assert.equal(requests.length, 0);
    await handlers.get("tool_result")?.({ toolCallId: "read-secret", toolName: "read", input: { path: "source.ts" }, content: [{ type: "text", text: "RAW_SOURCE_OPT_IN_ONLY" }], isError: false });
    const first = await tool.execute("one", { question: "Serialize or retry?", context: "I think retries suffice" }, undefined, undefined, ctx);
    assert.equal(first.isError, false);
    assert.equal(first.details.callNumber, 1);
    assert.deepEqual(first.usage, usage);
    assert.equal(first.details.usage.cacheReadTokens, 20);
    assert.ok(!JSON.stringify(requests[0]).includes("RAW_SOURCE_OPT_IN_ONLY"));
    assert.match(JSON.stringify(requests[0]), /forwarding is disabled/);

    await writeFile(configPath, JSON.stringify({ enabled: true, provider: model.provider, model: model.id, includeToolEvidence: true }));
    await handlers.get("session_start")?.({}, ctx);
    await handlers.get("agent_start")?.();
    await handlers.get("tool_result")?.({ toolCallId: "read-allowed", toolName: "read", input: { path: "source.ts", offset: 10, limit: 5 }, content: [{ type: "text", text: "RAW_SOURCE_OPT_IN_ONLY" }], isError: false });
    await tool.execute("two", { question: "Is this lock sufficient?", context: "Hypothesis: yes", stage: "recovery" }, undefined, undefined, ctx);
    assert.match(JSON.stringify(requests[1]), /RAW_SOURCE_OPT_IN_ONLY/);
    assert.match(JSON.stringify(requests[1]), /read-allowed/);
    assert.match(JSON.stringify(requests[1]), /offset=10 limit=5/);
    assert.match(JSON.stringify(requests[1]), /Hypothesis: yes/);
    response = { stopReason: "length", content: [{ type: "text", text: "Unfinished advice" }] };
    const incomplete = await tool.execute("three", { question: "Any release blockers?", stage: "final-check" }, undefined, undefined, ctx);
    assert.equal(incomplete.isError, true);
    assert.match(incomplete.content[0].text, /incomplete/);
    assert.match(incomplete.content[0].text, /not a sign-off/);
    assert.deepEqual(incomplete.usage, usage);
    assert.equal(entries.length, 3);
    assert.equal(entries[2].data.stopReason, "length");
    assert.equal(entries[2].data.totalTokens, 39);
    assert.ok(entries[2].data.durationMs >= 0);
    assert.equal(notifications.length, 3);
    assert.ok(!JSON.stringify(notifications).includes("RAW_SOURCE_OPT_IN_ONLY"));
    assert.ok(!JSON.stringify(entries).includes("RAW_SOURCE_OPT_IN_ONLY"));

    response = { content: [], usage: undefined };
    const empty = await tool.execute("four", { question: "Can you judge this?" }, undefined, undefined, ctx);
    assert.equal(empty.details.error, "empty_response");
    assert.equal(entries.length, 4);
    assert.equal(empty.details.usage.inputTokens, undefined);

    await writeFile(configPath, JSON.stringify({ enabled: true, provider: model.provider, model: model.id, maxUsesPerRun: 1 }));
    await handlers.get("agent_start")?.();
    response = {};
    const parallel = await Promise.all([1, 2, 3].map((i) => tool.execute(`parallel-${i}`, { question: "Which fix is safer?" }, undefined, undefined, ctx)));
    assert.equal(parallel.filter((r) => r.details.error === "max_uses_exceeded").length, 2);
    assert.equal(parallel.find((r) => !r.details.error)?.details.callNumber, 1);
    assert.equal(requests.length, 5);
    assert.equal(entries.length, 5);
  } finally {
    unregisterApiProviders("advisor-consult-test");
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    await rm(dir, { recursive: true, force: true });
  }
});
