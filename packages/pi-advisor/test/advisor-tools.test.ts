import assert from "node:assert/strict";
import test from "node:test";
import { createAdvisorTools } from "../src/advisor-tools.ts";

function firstText(result: { content: unknown[] }): string {
  const block = result.content[0];
  if (!block || typeof block !== "object") throw new Error("expected text content");
  const record = block as Record<string, unknown>;
  if (record.type !== "text" || typeof record.text !== "string") throw new Error("expected text content");
  return record.text;
}

test("exposes optional read and bash tools to the advisor loop", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const pi = {
    exec: async (command: string, args: string[]) => {
      calls.push({ command, args });
      return { stdout: "diagnostic output", stderr: "", code: 0, killed: false };
    },
  } as any;
  const tools = createAdvisorTools(pi, process.cwd());

  assert.deepEqual(tools.map((tool) => tool.name), ["read", "bash"]);

  const readResult = await tools[0].execute("read-1", { path: "README.md", offset: 1, limit: 1 });
  const readText = firstText(readResult);
  assert.match(readText, /FILE: .*README\.md/);
  assert.match(readText, /# pi-advisor/);

  const bashResult = await tools[1].execute("bash-1", { command: "printf diagnostic" });
  const bashText = firstText(bashResult);
  assert.match(bashText, /exit code: 0/);
  assert.match(bashText, /diagnostic output/);
  assert.equal(calls.length, 1);
});
