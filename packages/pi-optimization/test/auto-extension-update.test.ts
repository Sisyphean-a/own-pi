import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { SpawnOptions } from "node:child_process";
import { test } from "node:test";
import {
  installAutoExtensionUpdate,
  installPackageUpdateCheckGate,
  launchDetachedExtensionUpdate,
  resolvePiUpdateLaunch,
} from "../src/auto-extension-update.ts";

const AVAILABLE_UPDATE = {
  source: "npm:example-extension",
  displayName: "example-extension",
  type: "npm" as const,
  scope: "user" as const,
};

test("resolves the current Pi CLI without a shell", () => {
  assert.deepEqual(
    resolvePiUpdateLaunch("C:\\nodejs\\node.exe", ["node.exe", "C:\\pi\\cli.js"]),
    {
      command: "C:\\nodejs\\node.exe",
      args: ["C:\\pi\\cli.js", "update", "--extensions"],
    },
  );

  assert.deepEqual(resolvePiUpdateLaunch("C:\\pi\\pi.exe", ["C:\\pi\\pi.exe"]), {
    command: "C:\\pi\\pi.exe",
    args: ["update", "--extensions"],
  });
});

test("launches the updater detached and hides its window", async () => {
  const child = new EventEmitter() as EventEmitter & { unref(): void };
  let unrefCalls = 0;
  child.unref = () => {
    unrefCalls++;
  };

  let invocation: { command: string; args: string[]; options: SpawnOptions } | undefined;
  const launched = launchDetachedExtensionUpdate({
    execPath: "C:\\nodejs\\node.exe",
    argv: ["node.exe", "C:\\pi\\cli.js"],
    spawnProcess(command, args, options) {
      invocation = { command, args, options };
      queueMicrotask(() => child.emit("spawn"));
      return child as never;
    },
  });

  assert.equal(await launched, true);
  assert.equal(unrefCalls, 1);
  assert.deepEqual(invocation, {
    command: "C:\\nodejs\\node.exe",
    args: ["C:\\pi\\cli.js", "update", "--extensions"],
    options: {
      detached: true,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    },
  });
});

test("selective updates use one hidden runner instead of a blanket update", async () => {
  const child = new EventEmitter() as EventEmitter & { unref(): void };
  child.unref = () => {};
  let invocation: { command: string; args: string[] } | undefined;

  const launched = launchDetachedExtensionUpdate(
    {
      execPath: "C:\\nodejs\\node.exe",
      argv: ["node.exe", "C:\\pi\\cli.js"],
      spawnProcess(command, args) {
        invocation = { command, args };
        queueMicrotask(() => child.emit("spawn"));
        return child as never;
      },
    },
    ["npm:one", "https://example.test/two.git"],
  );

  assert.equal(await launched, true);
  assert.ok(invocation);
  assert.equal(invocation.command, "C:\\nodejs\\node.exe");
  assert.ok(invocation.args[0].endsWith("update-runner.js"));
  assert.equal(invocation.args[1], "C:\\nodejs\\node.exe");
  assert.deepEqual(JSON.parse(invocation.args[2]), ["C:\\pi\\cli.js"]);
  assert.deepEqual(invocation.args.slice(3), ["npm:one", "https://example.test/two.git"]);
});

test("only gates Pi's package update guard and restores the environment", () => {
  const environment = {} as { PI_OFFLINE?: string };
  const originalPrototype = Object.getPrototypeOf(environment);
  const gate = installPackageUpdateCheckGate(environment);
  const normalRead = () => environment.PI_OFFLINE;
  function checkForPackageUpdates() {
    return environment.PI_OFFLINE;
  }

  assert.equal(normalRead(), undefined);
  assert.equal(normalRead(), undefined);
  assert.equal(checkForPackageUpdates(), "1");
  assert.equal(Object.getPrototypeOf(environment), originalPrototype);

  gate.restore();
  assert.equal(environment.PI_OFFLINE, undefined);
});

test("package checks do not consume the gate and start only one detached update", async () => {
  class FakePackageManager {
    static calls = 0;

    constructor(_options: unknown) {}

    async checkForAvailableUpdates() {
      assert.equal(process.env.PI_OFFLINE, undefined);
      FakePackageManager.calls++;
      await new Promise((resolve) => setImmediate(resolve));
      // A real check reads PI_OFFLINE once for every eligible package. None of
      // those reads may consume the gate intended for Pi's later startup check.
      assert.equal(process.env.PI_OFFLINE, undefined);
      assert.equal(process.env.PI_OFFLINE, undefined);
      assert.equal(process.env.PI_OFFLINE, undefined);
      return [AVAILABLE_UPDATE];
    }
  }

  let sessionStart:
    | ((event: unknown, ctx: unknown) => void | Promise<void>)
    | undefined;
  let sessionShutdown: (() => void | Promise<void>) | undefined;
  let launchCalls = 0;
  await installAutoExtensionUpdate(
    {
      on(
        event: string,
        handler: (event?: unknown, ctx?: unknown) => void | Promise<void>,
      ) {
        if (event === "session_start") sessionStart = handler;
        if (event === "session_shutdown") sessionShutdown = handler;
      },
    } as never,
    {
      packageManagerClass: FakePackageManager as never,
      agentDir: "C:\\Users\\test\\.pi",
      createSettingsManager: () => ({}),
      launchUpdate: async () => {
        launchCalls++;
        return true;
      },
    },
  );

  assert.ok(sessionStart);
  const ctx = {
    mode: "tui",
    cwd: "C:\\project",
    isProjectTrusted: () => true,
  };
  sessionStart({}, ctx);
  sessionStart({}, ctx);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(FakePackageManager.calls, 2);
  assert.equal(launchCalls, 1);
  sessionShutdown?.();
});

test("does not launch the updater when no package update is available", async () => {
  let sessionStart:
    | ((event: unknown, ctx: unknown) => void | Promise<void>)
    | undefined;
  let sessionShutdown: (() => void | Promise<void>) | undefined;
  let launchCalls = 0;

  await installAutoExtensionUpdate(
    {
      on(
        event: string,
        handler: (event?: unknown, ctx?: unknown) => void | Promise<void>,
      ) {
        if (event === "session_start") sessionStart = handler;
        if (event === "session_shutdown") sessionShutdown = handler;
      },
    } as never,
    {
      packageManagerClass: class {
        async checkForAvailableUpdates() {
          return [];
        }
      } as never,
      agentDir: "C:\\Users\\test\\.pi",
      createSettingsManager: () => ({}),
      launchUpdate: async () => {
        launchCalls++;
        return true;
      },
    },
  );

  assert.ok(sessionStart);
  await sessionStart(
    {},
    { mode: "tui", cwd: "C:\\project", isProjectTrusted: () => true },
  );
  assert.equal(launchCalls, 0);
  sessionShutdown?.();
});
