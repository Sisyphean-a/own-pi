import assert from "node:assert/strict";
import { test } from "node:test";
import {
  installNulRedirect,
  rewriteNulRedirects,
  type BashOperations,
} from "../src/nul-redirect.ts";

type Handler = (event: any, ctx: any) => unknown;

function createFakePi() {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, { handler: Handler }>();
  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand(name: string, command: { handler: Handler }) {
      commands.set(name, command);
    },
    async emit(event: string, value: unknown, ctx = { hasUI: false }) {
      const results = [];
      for (const handler of handlers.get(event) ?? []) {
        results.push(await handler(value, ctx));
      }
      return results;
    },
    command(name: string) {
      return commands.get(name);
    },
  };
  return pi;
}

test("only rewrites standalone nul redirect targets", () => {
  assert.deepEqual(rewriteNulRedirects("cmd >nul 2>> NUL"), {
    command: "cmd >/dev/null 2>> /dev/null",
    count: 2,
    skippedHeredoc: false,
  });
  assert.equal(rewriteNulRedirects("echo nul # >nul").command, "echo nul # >nul");
  assert.equal(rewriteNulRedirects("echo 'nul' > 'nul'").command, "echo 'nul' > /dev/null");
  assert.equal(rewriteNulRedirects("cat <<EOF\nnul\nEOF").skippedHeredoc, true);
  assert.equal(rewriteNulRedirects("cmd 2>&1").count, 0);
});

test("AI Bash tool calls are patched without loading the optional Bash backend", async () => {
  const pi = createFakePi();
  installNulRedirect(pi as never);

  const event = { toolName: "bash", input: { command: "echo hi >nul" } };
  await pi.emit("tool_call", event);

  assert.equal(event.input.command, "echo hi >/dev/null");
});

test("user Bash uses an injected backend and rewrites again at execution time", async () => {
  const pi = createFakePi();
  const executed: string[] = [];
  const operations: BashOperations = {
    exec(command, _cwd, _options) {
      executed.push(command);
      return Promise.resolve({ exitCode: 0 });
    },
  };
  installNulRedirect(pi as never, {
    loadLocalBashOperations: () => operations,
  });

  const [result] = await pi.emit("user_bash", { command: "echo hi >nul" }) as any[];
  assert.ok(result);
  await result.operations.exec("echo again >nul", ".", { onData() {} });
  assert.deepEqual(executed, ["echo again >/dev/null"]);
});

test("missing optional user Bash backend leaves the original path intact", async () => {
  const pi = createFakePi();
  installNulRedirect(pi as never, {
    loadLocalBashOperations: () => {
      throw new Error("backend missing");
    },
  });

  await assert.doesNotReject(async () => {
    const [result] = await pi.emit("user_bash", { command: "echo hi >nul" });
    assert.equal(result, undefined);
  });
});
