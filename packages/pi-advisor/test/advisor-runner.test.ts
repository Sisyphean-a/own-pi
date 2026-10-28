import assert from "node:assert/strict";
import test from "node:test";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { runAdvisor } from "../src/advisor-runner.ts";

test("顾问请求不提供工具，保留提示词、用量和取消信号", async () => {
  const controller = new AbortController();
  const events: unknown[] = [];
  const fakeAgentLoop = ((prompts: unknown[], context: { messages: any[]; tools?: any[] }, config: any, signal: AbortSignal) => {
    assert.deepEqual(context.tools, []);
    assert.equal(getCurrentSystemPrompt(context.messages), "You are an advisor");
    assert.equal(signal, controller.signal);
    assert.deepEqual(config.finishTurn(), { action: "end" });
    const message = { role: "assistant", content: [{ type: "text", text: "On track" }], usage: { input: 10, output: 5 }, stopReason: "stop" };
    return {
      async *[Symbol.asyncIterator]() { yield { type: "message_end", message }; },
      async result() { return [...prompts, message]; },
    };
  }) as any;
  const result = await runAdvisor({
    model: {} as any, messages: [{ role: "user", content: "Assess" }] as any,
    systemPrompt: "You are an advisor", maxTokens: 100, reasoning: "high",
    pi: { events: { emit: (_: string, data: unknown) => events.push(data) } } as any,
    signal: controller.signal, agentLoop: fakeAgentLoop,
  });
  assert.equal(result.text, "On track");
  assert.equal(result.inputTokens, 10);
  assert.equal(result.outputTokens, 5);
  assert.equal(events.length, 1);
});

test("意外工具调用作为错误返回，不提供可执行工具", async () => {
  const fakeAgentLoop = ((_: unknown, context: { tools?: unknown[] }) => {
    assert.deepEqual(context.tools, []);
    return {
      async *[Symbol.asyncIterator]() {},
      async result() { return [{ role: "assistant", content: [], stopReason: "toolUse" }]; },
    };
  }) as any;
  const result = await runAdvisor({
    model: {} as any, messages: [] as any, systemPrompt: "advisor", maxTokens: 100,
    reasoning: "high", pi: {} as any, agentLoop: fakeAgentLoop,
  });
  assert.match(result.errorMessage!, /unexpected tool call/);
});
