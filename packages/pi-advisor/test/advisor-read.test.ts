import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createReadTool } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { registerApiProvider, unregisterApiProviders } from "@earendil-works/pi-ai/compat";
import { createAdvisorReader, MAX_ADVISOR_READS } from "../src/advisor-read.ts";
import { MAX_ADVISOR_TURNS } from "../src/advisor-runner.ts";
import advisorExtension from "../src/advisor.ts";

const usage = { input: 10, output: 5, cacheRead: 20, cacheWrite: 4, totalTokens: 39,
  cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 } };
const call = (id: string, name = "read", args: any = { path: "logic.ts", offset: 2, limit: 1 }) => ({ type: "toolCall", id, name, arguments: args });
const advice = (text = "Course-correct: logic.ts returns false; fix the condition.") => ({ content: [{ type: "text", text }], stopReason: "stop" });

test("只读适配器限制并行读取、文本大小和图片，不吞掉主机错误", async () => {
  let calls = 0;
  const reader = createAdvisorReader(async (args) => {
    calls++;
    assert.equal(args.limit, 200);
    return { content: [{ type: "text", text: "x".repeat(30000) }], details: undefined, isError: true };
  });
  const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => reader.tool.execute(String(i), { path: "a.ts" })));
  assert.equal(calls, MAX_ADVISOR_READS);
  assert.equal(results.filter((r) => r.status === "rejected").length, 12 - MAX_ADVISOR_READS);
  for (const result of results) if (result.status === "fulfilled") {
    assert.equal(result.value.isError, true);
    const text = (result.value.content[0] as any).text;
    assert.ok(text.length <= 12000);
    assert.match(text, /truncated/);
  }
  const image = createAdvisorReader(async () => ({ content: [{ type: "image", data: "PRIVATE_IMAGE", mimeType: "image/png" }], details: undefined }));
  const rejected = await image.tool.execute("image", { path: "a.png" });
  assert.equal(rejected.isError, true);
  assert.ok(!JSON.stringify(rejected).includes("PRIVATE_IMAGE"));
});

test("顾问真实多轮读取后给出判断，主机拦截和工具白名单有效，预算保留最终回答并累加所有用量", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-advisor-read-"));
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const api = "advisor-read-test-api" as any;
  const model = { api, provider: "local-test", id: "advisor", reasoning: true } as any;
  const source = "export function check() {\n  return false;\n}\n";
  const requests: any[] = [], nested: any[] = [], entries: any[] = [], notifications: any[] = [];
  let denied = false;
  let respond: (context: any, turn: number) => any = () => advice();
  const stream = ((_model: any, context: any) => {
    requests.push(context);
    const reply = respond(context, requests.length);
    const message = { role: "assistant", api, provider: model.provider, model: model.id,
      usage, timestamp: Date.now(), ...reply } as any;
    const events = createAssistantMessageEventStream();
    events.push({ type: "start", partial: message });
    events.push({ type: "done", reason: message.stopReason, message });
    return events;
  }) as any;
  registerApiProvider({ api, stream, streamSimple: stream }, "advisor-read-test");
  try {
    await writeFile(join(dir, "logic.ts"), source);
    await writeFile(join(dir, "advisor.json"), JSON.stringify({ enabled: true, provider: model.provider, model: model.id, maxUsesPerRun: 10 }));
    let tool: any;
    const handlers = new Map<string, (...args: any[]) => any>();
    const pi = {
      on: (name: string, handler: any) => handlers.set(name, handler),
      registerTool: (value: any) => { tool = value; }, registerCommand() {},
      getActiveTools: () => ["advisor", "read", "write", "bash"], getAllTools: () => [], setActiveTools() {},
      appendEntry: (type: string, data: any) => entries.push({ type, data }),
      events: { emit: (channel: string, data: any) => notifications.push({ channel, data }) },
    } as any;
    const nativeRead = createReadTool(dir);
    const ctx = {
      cwd: dir, tools: [nativeRead], model: { provider: "executor", id: "worker" },
      modelRegistry: { find: () => model, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-only" }) },
      sessionManager: { getSessionId: () => "local-read-session", getBranch: () => [
        { type: "message", message: { role: "user", content: "Check logic.ts; do not modify it", timestamp: Date.now() } },
      ] },
      getSystemPrompt: () => "Executor instructions",
      async executeTool(name: string, args: any, options: any) {
        assert.equal(name, "read");
        assert.ok(options.signal instanceof AbortSignal);
        nested.push({ name, args });
        const result = denied ? { content: [{ type: "text", text: "Host permission denied" }], details: undefined, isError: false }
          : await nativeRead.execute(`nested-${nested.length}`, args, options.signal);
        return { toolCall: call("nested", name, args), result, isError: denied || result.isError === true };
      },
    } as any;
    advisorExtension(pi);
    await handlers.get("agent_start")?.();
    const consult = async () => {
      requests.length = 0; nested.length = 0; notifications.length = 0;
      return tool.execute("consult", { question: "Does logic.ts satisfy the requirement?", context: "File: logic.ts. Executor hypothesis: check returns true." }, undefined, undefined, ctx);
    };

    respond = (context, turn) => {
      if (turn === 1) {
        assert.deepEqual(getCurrentTools(context.messages).map((t) => t.name), ["read"]);
        return { content: [call("read-1")], stopReason: "toolUse" };
      }
      const read = context.messages.find((m: any) => m.role === "toolResult");
      assert.match(JSON.stringify(read.content), /return false/);
      return advice();
    };
    const first = await consult();
    assert.equal(first.isError, false);
    assert.match(first.content[0].text, /returns false/);
    assert.equal(nested.length, 1);
    assert.deepEqual(nested[0].args, { path: "logic.ts", offset: 2, limit: 1 });
    assert.equal(first.details.usage.modelRequests, 2);
    assert.equal(first.details.usage.readCalls, 1);
    assert.equal(first.usage.input, 20);
    assert.equal(first.usage.totalTokens, 78);
    assert.equal(first.usage.cost.total, 20);
    assert.equal(notifications.length, 2);
    assert.equal(notifications.reduce((total, event) => total + event.data.usage.totalTokens, 0), 78);
    assert.ok(!JSON.stringify(notifications).includes("return false"));
    assert.equal(entries.at(-1).data.totalTokens, 78);

    denied = true;
    respond = (context, turn) => {
      if (turn === 1) return { content: [call("blocked")], stopReason: "toolUse" };
      const read = context.messages.find((m: any) => m.role === "toolResult");
      assert.equal(read.isError, true);
      assert.match(JSON.stringify(read.content), /Host permission denied/);
      return advice("Not done yet: host denied file access; cannot verify this condition.");
    };
    await consult();
    assert.equal(nested.length, 1);
    denied = false;

    respond = (context, turn) => {
      if (turn === 1) return { content: [call("write-attempt", "write", { path: "logic.ts", content: "modified" }), call("shell-attempt", "bash", { command: "echo modified" })], stopReason: "toolUse" };
      assert.equal(context.messages.filter((m: any) => m.role === "toolResult" && m.isError).length, 2);
      return advice("Course-correct: commands and modifications are unavailable.");
    };
    await consult();
    assert.equal(nested.length, 0);
    assert.equal(await readFile(join(dir, "logic.ts"), "utf8"), source);

    respond = (context, turn) => {
      if (turn === 1) return { content: [call("oversized", "read", { path: "logic.ts", limit: 10000 })], stopReason: "toolUse" };
      assert.equal(context.messages.find((m: any) => m.role === "toolResult").isError, true);
      return advice("Not done yet: use a valid bounded line range.");
    };
    await consult();
    assert.equal(nested.length, 0);

    respond = (context, turn) => {
      if (turn === 1) return { content: Array.from({ length: 12 }, (_, i) => call(`batch-${i}`)), stopReason: "toolUse" };
      assert.deepEqual(getCurrentTools(context.messages), []);
      assert.match(getCurrentSystemPrompt(context.messages), /Reading phase is over/);
      return advice("Course-correct: evidence is sufficient; no additional reads needed.");
    };
    const limited = await consult();
    assert.equal(limited.isError, false);
    assert.equal(limited.details.usage.readCalls, MAX_ADVISOR_READS);
    assert.equal(limited.details.usage.modelRequests, 2);
    assert.equal(nested.length, MAX_ADVISOR_READS);

    respond = (context, turn) => {
      if (turn < MAX_ADVISOR_TURNS) return { content: [call(`turn-${turn}`)], stopReason: "toolUse" };
      assert.deepEqual(getCurrentTools(context.messages), []);
      return advice();
    };
    const turns = await consult();
    assert.equal(turns.isError, false);
    assert.equal(turns.details.usage.modelRequests, MAX_ADVISOR_TURNS);
    assert.equal(turns.details.usage.readCalls, MAX_ADVISOR_TURNS - 1);
    assert.equal(turns.usage.totalTokens, MAX_ADVISOR_TURNS * 39);
    assert.equal(notifications.length, MAX_ADVISOR_TURNS);

    respond = (_context, turn) => turn === 1 ? { content: [call("unknown-usage")], stopReason: "toolUse", usage: undefined } : advice();
    const unknown = await consult();
    assert.equal(unknown.details.usage.inputTokens, undefined);
    assert.equal(unknown.usage, undefined);
  } finally {
    unregisterApiProviders("advisor-read-test");
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    await rm(dir, { recursive: true, force: true });
  }
});
