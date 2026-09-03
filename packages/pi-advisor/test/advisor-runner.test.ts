import assert from "node:assert/strict";
import test from "node:test";
import { runAdvisor } from "../src/advisor-runner.ts";

function firstText(result: { content: unknown[] }): string {
  const block = result.content[0];
  if (!block || typeof block !== "object") throw new Error("expected text content");
  const record = block as Record<string, unknown>;
  if (record.type !== "text" || typeof record.text !== "string") throw new Error("expected text content");
  return record.text;
}

test("runs an advisor-selected bash tool inside the internal agent loop", async () => {
  const calls: string[] = [];
  const pi = {
    exec: async (_command: string, _args: string[]) => {
      calls.push("diagnostic");
      return { stdout: "diagnostic output", stderr: "", code: 0, killed: false };
    },
  } as any;
  let toolOutput = "";
  const fakeAgentLoop = ((prompts: unknown[], context: { tools?: any[] }) => {
    const stream = {
      async *[Symbol.asyncIterator]() {
        const tool = context.tools?.find((candidate) => candidate.name === "bash");
        assert.ok(tool, "the advisor loop should receive the bash tool");
        yield { type: "tool_execution_start", toolCallId: "bash-1", toolName: "bash", args: { command: "diagnose" } };
        toolOutput = firstText(await tool.execute("bash-1", { command: "diagnose" }));
        yield { type: "tool_execution_end", toolCallId: "bash-1", toolName: "bash", result: toolOutput, isError: false };
      },
      async result() {
        return [
          ...prompts,
          {
            role: "assistant",
            content: [{ type: "text", text: `On track\n1. ${toolOutput}` }],
            usage: { input: 10, output: 5 },
            stopReason: "stop",
          },
        ];
      },
    };
    return stream;
  }) as any;

  const result = await runAdvisor({
    model: {} as any,
    messages: [{ role: "user", content: "Assess this task" }] as any,
    systemPrompt: "You are an advisor",
    maxTokens: 100,
    reasoning: "high",
    pi,
    cwd: process.cwd(),
    agentLoop: fakeAgentLoop,
  });

  assert.equal(calls.length, 1);
  assert.match(result.text, /On track/);
  assert.deepEqual(result.toolUses, [{ name: "bash", summary: "$ diagnose", isError: false }]);
  assert.equal(result.inputTokens, 10);
  assert.equal(result.outputTokens, 5);
});
