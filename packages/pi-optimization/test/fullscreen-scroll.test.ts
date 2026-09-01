import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CONFIG_KEY,
  DEFAULT_WHEEL_SCROLL_LINES,
  installFullscreenScroll,
  patchFullscreenTui,
  readFullscreenScrollConfig,
  restoreFullscreenTuiPatch,
  writeFullscreenScrollConfig,
} from "../src/fullscreen-scroll.ts";

type Handler = (event: any, ctx: any) => unknown;

class FakeFullscreenTui {
  mode = "fullscreen";
  wheelScrollLines = 1;

  routeWheel(): number {
    return this.wheelScrollLines;
  }
}

class FakeRegularTui {
  mode = "regular";
}

function proxyTui<T extends object>(tui: T): T {
  return new Proxy({}, {
    get: (_target, property) => Reflect.get(tui, property, tui),
  }) as T;
}

function createFakePi(tui: object) {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, { handler: Handler }>();
  const proxy = proxyTui(tui);
  const notifications: string[] = [];
  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand(name: string, command: { handler: Handler }) {
      commands.set(name, command);
    },
    async emit(event: string, value: unknown, ctx: any) {
      for (const handler of handlers.get(event) ?? []) await handler(value, ctx);
    },
    command(name: string) {
      return commands.get(name);
    },
    notifications,
    context: {
      mode: "tui",
      hasUI: true,
      ui: {
        setWidget(_key: string, content: unknown) {
          if (typeof content === "function") content(proxy, {});
        },
        notify(message: string) {
          notifications.push(message);
        },
      },
    },
  };
  return pi;
}

test("patches fullscreen wheel handling through the stable TUI proxy", () => {
  const tui = new FakeFullscreenTui();
  const proxy = proxyTui(tui);

  assert.equal(patchFullscreenTui(proxy, { enabled: true, wheelScrollLines: 4 }), true);
  assert.equal(tui.routeWheel(), 4);
  assert.equal(tui.wheelScrollLines, 1);

  assert.equal(patchFullscreenTui(proxy, { enabled: true, wheelScrollLines: 7 }), true);
  assert.equal(tui.routeWheel(), 7);
  assert.equal(new FakeFullscreenTui().routeWheel(), 7);

  assert.equal(patchFullscreenTui(proxy, { enabled: false, wheelScrollLines: 7 }), true);
  assert.equal(tui.routeWheel(), 1);
  assert.equal(restoreFullscreenTuiPatch(proxy), true);
  assert.equal(tui.routeWheel(), 1);
  assert.equal(new FakeFullscreenTui().routeWheel(), 1);
});

test("leaves regular and incompatible TUI instances untouched", () => {
  assert.equal(
    patchFullscreenTui(proxyTui(new FakeRegularTui()), {
      enabled: true,
      wheelScrollLines: 3,
    }),
    false,
  );
  assert.equal(
    patchFullscreenTui(proxyTui({ mode: "fullscreen", wheelScrollLines: 1 }), {
      enabled: true,
      wheelScrollLines: 3,
    }),
    false,
  );
});

test("reads and writes fullscreen scroll settings without dropping other settings", async () => {
  const settingsDir = await mkdtemp(join(tmpdir(), "pi-fullscreen-scroll-"));
  const settingsFile = join(settingsDir, "settings.json");

  assert.deepEqual(
    readFullscreenScrollConfig(settingsFile, { defaultEnabled: true }),
    { enabled: true, wheelScrollLines: DEFAULT_WHEEL_SCROLL_LINES },
  );

  await writeFullscreenScrollConfig(
    { enabled: false, wheelScrollLines: 5 },
    settingsFile,
    { defaultEnabled: true },
  );
  await writeFullscreenScrollConfig({ wheelScrollLines: 7 }, settingsFile, { defaultEnabled: true });

  const settings = JSON.parse(await readFile(settingsFile, "utf8"));
  assert.deepEqual(settings[CONFIG_KEY], { enabled: false, wheelScrollLines: 7 });
  assert.deepEqual(
    readFullscreenScrollConfig(settingsFile, { defaultEnabled: true }),
    { enabled: false, wheelScrollLines: 7 },
  );
});

test("installs the feature, applies changes immediately, and restores on shutdown", async () => {
  const settingsDir = await mkdtemp(join(tmpdir(), "pi-fullscreen-scroll-"));
  const settingsFile = join(settingsDir, "settings.json");
  const tui = new FakeFullscreenTui();
  const pi = createFakePi(tui);
  installFullscreenScroll(pi as never, { settingsFile, defaultEnabled: true });

  await pi.emit("session_start", {}, pi.context);
  assert.equal(tui.routeWheel(), DEFAULT_WHEEL_SCROLL_LINES);

  await pi.command("fullscreen-scroll")!.handler("5", pi.context);
  assert.equal(tui.routeWheel(), 5);

  await pi.command("fullscreen-scroll")!.handler("off", pi.context);
  assert.equal(tui.routeWheel(), 1);
  assert.match(pi.notifications.at(-1) ?? "", /停用/);

  await pi.emit("session_shutdown", {}, pi.context);
  assert.equal(tui.routeWheel(), 1);
});
