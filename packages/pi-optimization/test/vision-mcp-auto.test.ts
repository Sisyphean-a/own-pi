import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  findVisionTools,
  installVisionMcpAuto,
  modelSupportsImage,
  readVisionConfig,
} from "../src/vision-mcp-auto.ts";

type Handler = (event: any, ctx: any) => unknown;

function createFakePi(tools: string[] = [], activeTools: string[] = []) {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, { handler: Handler }>();
  let active = [...activeTools];
  const setCalls: string[][] = [];
  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand(name: string, command: { handler: Handler }) {
      commands.set(name, command);
    },
    getAllTools() {
      return tools.map((name) => ({ name }));
    },
    getActiveTools() {
      return [...active];
    },
    setActiveTools(next: string[]) {
      active = [...next];
      setCalls.push([...next]);
    },
    async emit(event: string, value: unknown, ctx: any) {
      for (const handler of handlers.get(event) ?? []) await handler(value, ctx);
    },
    command(name: string) {
      return commands.get(name);
    },
    get active() {
      return active;
    },
    setCalls,
  };
  return pi;
}

function context(model: any, withUi = true) {
  return withUi
    ? {
        model,
        hasUI: true,
        ui: { notify() {} },
      }
    : { model, hasUI: false };
}

test("detects image capability and vision tool suffixes", () => {
  assert.equal(modelSupportsImage({ input: ["text", "image"] } as never), true);
  assert.equal(modelSupportsImage({ input: ["text"] } as never), false);
  assert.deepEqual(
    findVisionTools({ getAllTools: () => [{ name: "mcp_analyze_image" }, { name: "read" }] } as never, ["analyze_image"]),
    ["mcp_analyze_image"],
  );
  assert.deepEqual(findVisionTools({} as never, ["analyze_image"]), []);
});

test("auto mode activates vision tools only for text-only models", async () => {
  const pi = createFakePi(["mcp_analyze_image"], ["read"]);
  installVisionMcpAuto(pi as never, { settingsFile: join(await mkdtemp(join(tmpdir(), "pi-vision-")), "settings.json") });

  await pi.emit("session_start", {}, context({ provider: "test", id: "text", name: "Text", input: ["text"] }));
  assert.deepEqual(pi.active, ["read", "mcp_analyze_image"]);
  assert.equal(pi.setCalls.length, 1);

  await pi.emit("model_select", {}, context({ provider: "test", id: "image", name: "Image", input: ["text", "image"] }));
  assert.deepEqual(pi.active, ["read"]);
  assert.equal(pi.setCalls.length, 2);
});

test("auto mode waits for a real model and announces the final state once", async () => {
  const pi = createFakePi(["mcp_analyze_image"], []);
  const notificationState = { values: [] as string[] };
  const settingsDir = await mkdtemp(join(tmpdir(), "pi-vision-"));
  const settingsFile = join(settingsDir, "settings.json");
  installVisionMcpAuto(pi as never, { settingsFile });

  const noModelContext = {
    model: undefined,
    hasUI: true,
    ui: { notify(message: string) { notificationState.values.push(message); } },
  };
  await pi.emit("session_start", {}, noModelContext);
  assert.deepEqual(pi.active, []);
  assert.deepEqual(notificationState.values, []);

  const modelContext = {
    model: { provider: "test", id: "text", name: "Text", input: ["text"] },
    hasUI: true,
    ui: { notify(message: string) { notificationState.values.push(message); } },
  };
  await pi.emit("before_agent_start", {}, modelContext);
  await pi.emit("before_agent_start", {}, modelContext);
  assert.deepEqual(pi.active, ["mcp_analyze_image"]);
  assert.equal(notificationState.values.length, 1);
});

test("missing MCP tools and missing UI are safe no-ops", async () => {
  const pi = createFakePi([], []);
  const settingsDir = await mkdtemp(join(tmpdir(), "pi-vision-"));
  const settingsFile = join(settingsDir, "settings.json");
  installVisionMcpAuto(pi as never, { settingsFile });

  await assert.doesNotReject(() => pi.emit(
    "session_start",
    {},
    context({ provider: "test", id: "text", name: "Text", input: ["text"] }, false),
  ));
  await assert.doesNotReject(async () => {
    await pi.command("vision-mcp")!.handler("", context(undefined, false));
  });
  assert.deepEqual(pi.setCalls, []);
});

test("vision mode changes are persisted without requiring the MCP adapter", async () => {
  const pi = createFakePi([], []);
  const settingsDir = await mkdtemp(join(tmpdir(), "pi-vision-"));
  const settingsFile = join(settingsDir, "settings.json");
  installVisionMcpAuto(pi as never, { settingsFile });

  await pi.command("vision-mcp")!.handler("off", context(undefined, false));
  assert.equal(readVisionConfig(settingsFile).mode, "off");
  assert.match(await readFile(settingsFile, "utf8"), /vision-mcp-auto/);
});
