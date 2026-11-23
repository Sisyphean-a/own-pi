import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import advisorExtension from "../src/advisor.ts";

function model(provider: string, id: string) {
  return { provider, id } as any;
}

test("hides and guards the advisor when the current model matches a skip rule", async () => {
  const configDir = await mkdtemp(join(tmpdir(), "pi-advisor-skip-"));
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = configDir;
  await writeFile(join(configDir, "advisor.json"), JSON.stringify({
    enabled: true,
    provider: "anthropic",
    model: "claude-fable-5",
    skipWhenCurrentModel: ["openai-codex/gpt-5.6-sol"],
  }));

  try {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    let activeTools = ["advisor"];
    let registeredTool: any;
    let findCalls = 0;
    const pi = {
      on(name: string, handler: (...args: any[]) => unknown) {
        handlers.set(name, handler);
      },
      registerTool(tool: unknown) {
        registeredTool = tool;
      },
      registerCommand() {},
      getActiveTools() {
        return activeTools;
      },
      setActiveTools(next: string[]) {
        activeTools = next;
      },
      getAllTools() {
        return [];
      },
    } as any;

    advisorExtension(pi);
    const skippedContext = {
      model: model("openai-codex", "gpt-5.6-sol"),
      modelRegistry: {
        find() {
          findCalls++;
          return undefined;
        },
      },
    } as any;

    await handlers.get("session_start")?.({}, skippedContext);
    assert.deepEqual(activeTools, []);

    const result = await registeredTool.execute("call-1", {}, undefined, undefined, skippedContext);
    assert.match(result.content[0].text, /skipped for current model/);
    assert.equal(result.details.error, "current_model_skipped");
    assert.equal(findCalls, 0);

    await handlers.get("model_select")?.({}, { model: model("anthropic", "claude-3") });
    assert.deepEqual(activeTools, ["advisor"]);
  } finally {
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    await rm(configDir, { recursive: true, force: true });
  }
});
