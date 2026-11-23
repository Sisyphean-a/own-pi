import assert from "node:assert/strict";
import test from "node:test";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { runAdvisor } from "../src/advisor-runner.ts";

const usage = { input: 10, output: 5, cacheRead: 20, cacheWrite: 4, cacheWrite1h: 2, reasoning: 3, totalTokens: 39,
  cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 } };
const answer = (overrides: Record<string, unknown> = {}) => ({
  role: "assistant", provider: "test", model: "advisor", responseId: "response-1", timestamp: Date.now(),
  content: [{ type: "text", text: "On track" }], usage, stopReason: "stop", ...overrides,
});
const base = {
  model: { provider: "test", id: "advisor" } as any,
  messages: [{ role: "user", content: "Assess" }] as any,
  systemPrompt: "You are an advisor", maxTokens: 100, reasoning: "high" as const,
  timeoutMs: 1000, pi: {} as any, cwd: "/project",
  read: async () => ({ content: [{ type: "text" as const, text: "source" }], details: undefined }),
};
function loopFor(message: any, inspect?: (...args: any[]) => void) {
  return ((...args: any[]) => {
    args[2].prepareRequest?.({ context: args[1], model: base.model });
    inspect?.(...args);
    return {
      async *[Symbol.asyncIterator]() { yield { type: "message_end", message }; },
      async result() { return [...args[0], message]; },
    };
  }) as any;
}

test("顾问仅提供 read，直接回答时只调用一次模型，保留推理配置、用量和取消信号", async () => {
  const controller = new AbortController();
  const events: any[] = [];
  const history = answer({ usage: { input: 99999, output: 99999 } });
  const result = await runAdvisor({
    ...base, messages: [history, ...base.messages] as any,
    pi: { events: { emit: (channel: string, data: any) => { assert.equal(channel, "pi:model-usage:v1"); events.push(data); } } } as any,
    signal: controller.signal,
    agentLoop: loopFor(answer(), (_prompts, context, config, signal) => {
      assert.deepEqual(context.tools.map((tool: any) => tool.name), ["read"]);
      assert.ok(getCurrentSystemPrompt(context.messages)!.startsWith(base.systemPrompt));
      assert.match(getCurrentSystemPrompt(context.messages)!, /working directory: "\/project"/);
      assert.deepEqual(config.finishTurn({ message: answer() }), { action: "end" });
      assert.equal(config.reasoning, "high");
      assert.equal(config.maxTokens, 100);
      controller.abort();
      assert.equal(signal.aborted, true);
    }),
  });
  assert.match(result.errorMessage!, /cancelled/);
  assert.equal(result.text, "On track");
  assert.equal(result.modelRequests, 1);
  assert.equal(result.readCalls, 0);
  assert.equal(result.inputTokens, 10);
  assert.equal(result.outputTokens, 5);
  assert.equal(result.cacheReadTokens, 20);
  assert.equal(result.cacheWriteTokens, 4);
  assert.equal(result.cacheWrite1hTokens, 2);
  assert.equal(result.reasoningTokens, 3);
  assert.equal(result.totalTokens, 39);
  assert.deepEqual(result.usage, usage);
  assert.ok(result.durationMs >= 0);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].usage, { input: 10, output: 5, cacheRead: 20, cacheWrite: 4, cacheWrite1h: 2, totalTokens: 39 });
  assert.ok(!JSON.stringify(events[0]).includes("On track"));
  assert.ok(!JSON.stringify(events[0]).includes("cost"));
});

test("截断、错误、取消和意外工具调用不能伪装成成功建议，仍保留用量", async () => {
  for (const stopReason of ["length", "error", "aborted", "toolUse"]) {
    const result = await runAdvisor({ ...base, agentLoop: loopFor(answer({ stopReason })) });
    assert.ok(result.errorMessage, stopReason);
    assert.equal(result.stopReason, stopReason);
    assert.equal(result.totalTokens, 39);
  }
});

test("未知或不完整用量不补零，思考内容不充当最终建议", async () => {
  const result = await runAdvisor({ ...base, agentLoop: loopFor(answer({ usage: undefined, content: [{ type: "thinking", thinking: "private reasoning" }] })) });
  assert.equal(result.text, "");
  assert.equal(result.inputTokens, undefined);
  assert.equal(result.totalTokens, undefined);
  assert.equal(result.usage, undefined);
  const partial = await runAdvisor({ ...base, agentLoop: loopFor(answer({ usage: { input: 0, output: 7 } })) });
  assert.equal(partial.inputTokens, 0);
  assert.equal(partial.outputTokens, 7);
  assert.equal(partial.cacheReadTokens, undefined);
  assert.equal(partial.usage, undefined);
  const failed = await runAdvisor({ ...base, agentLoop: loopFor(answer({ stopReason: "error", usage: {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  } })) });
  assert.equal(failed.inputTokens, undefined);
  assert.equal(failed.totalTokens, undefined);
  assert.equal(failed.usage, undefined);
});

test("流尾失败不丢失已完成响应的计数，可选统计消费者失败不影响主结果", async () => {
  const agentLoop = (() => ({
    async *[Symbol.asyncIterator]() { yield { type: "message_end", message: answer() }; throw new Error("stream tail failed"); },
    async result() { throw new Error("unreachable"); },
  })) as any;
  const result = await runAdvisor({ ...base, agentLoop, pi: { events: { emit: () => { throw new Error("consumer failed"); } } } as any });
  assert.match(result.errorMessage!, /stream tail failed/);
  assert.equal(result.outputTokens, 5);
});

test("超时向模型传递取消信号并显式报错，不自动重试或伪造用量", async () => {
  let calls = 0;
  const agentLoop = ((_prompts: any, _context: any, _config: any, signal: AbortSignal) => {
    calls++;
    return {
      async *[Symbol.asyncIterator]() {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        throw signal.reason;
      },
      async result() { return []; },
    };
  }) as any;
  const result = await runAdvisor({ ...base, timeoutMs: 10, agentLoop });
  assert.match(result.errorMessage!, /timed out/);
  assert.equal(result.stopReason, "aborted");
  assert.equal(result.inputTokens, undefined);
  assert.equal(calls, 1);
});

test("咨询超时也取消正在进行的读取，保留此前模型已报告用量", async () => {
  let readAborted = false;
  const read = async (_args: any, signal?: AbortSignal) => {
    await new Promise<void>((_resolve, reject) => signal!.addEventListener("abort", () => {
      readAborted = true;
      reject(signal!.reason);
    }, { once: true }));
    return { content: [], details: undefined };
  };
  const agentLoop = ((_prompts: any, context: any, config: any, signal: AbortSignal) => ({
    async *[Symbol.asyncIterator]() {
      config.prepareRequest({ context });
      yield { type: "message_end", message: answer({ stopReason: "toolUse", content: [] }) };
      await context.tools[0].execute("read-timeout", { path: "source.ts" }, signal);
    },
    async result() { return []; },
  })) as any;
  const result = await runAdvisor({ ...base, read, timeoutMs: 10, agentLoop });
  assert.equal(readAborted, true);
  assert.equal(result.readCalls, 1);
  assert.equal(result.inputTokens, 10);
  assert.match(result.errorMessage!, /timed out/);
});

test("后续请求没有最终用量时总量保持未知，已完成响应仍单独发布", async () => {
  const notifications: any[] = [];
  const agentLoop = ((_prompts: any, context: any, config: any) => ({
    async *[Symbol.asyncIterator]() {
      config.prepareRequest({ context });
      yield { type: "message_end", message: answer({ stopReason: "toolUse", content: [] }) };
      config.prepareRequest({ context });
      throw new Error("connection lost before final usage");
    },
    async result() { return []; },
  })) as any;
  const result = await runAdvisor({ ...base, agentLoop, pi: { events: { emit: (_channel: string, data: any) => notifications.push(data) } } as any });
  assert.equal(result.modelRequests, 2);
  assert.equal(result.inputTokens, undefined);
  assert.equal(result.usage, undefined);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].usage.input, 10);
  assert.match(result.errorMessage!, /connection lost/);
});
