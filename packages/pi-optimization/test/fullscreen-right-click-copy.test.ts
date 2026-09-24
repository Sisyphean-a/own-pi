import assert from "node:assert/strict";
import { test } from "node:test";
import {
  installFullscreenRightClickCopy,
  patchFullscreenRightClickCopy,
  restoreFullscreenRightClickCopy,
} from "../src/fullscreen-right-click-copy.ts";

type MouseEvent = { button: number; release: boolean; x: number; y: number };

class FakeFullscreenTui {
  mode = "fullscreen";
  copyOnSelect = false;
  selection = true;
  selectionAnchor: object | undefined = { row: 0, col: 0 };
  selectionFocus: object | undefined = { row: 0, col: 4 };
  cleared = 0;
  renders = 0;
  events: MouseEvent[] = [];
  copied = 0;
  pasted = 0;
  onRightClickPaste: (() => void) | undefined = () => { this.pasted++; };
  flashes: string[] = [];
  copyResult: Promise<boolean> = Promise.resolve(true);

  getCopyOnSelect(): boolean { return this.copyOnSelect; }
  hasActiveSelection(): boolean { return this.selection; }
  copyActiveSelectionToClipboard(): Promise<boolean> {
    this.copied++;
    return this.copyResult;
  }
  flash(message: string): void { this.flashes.push(message); }
  clearTextSelection(): void {
    this.cleared++;
    this.selection = false;
    this.selectionAnchor = undefined;
    this.selectionFocus = undefined;
  }
  requestRender(): void { this.renders++; }
  handleMouseEvent(event: MouseEvent): void { this.events.push(event); }
}

function proxyTui(tui: object): object {
  return new Proxy({}, {
    get: (_target, property) => Reflect.get(tui, property, tui),
  });
}

const rightPress: MouseEvent = { button: 2, release: false, x: 4, y: 7 };
const rightRelease: MouseEvent = { ...rightPress, release: true };
const leftPress: MouseEvent = { ...rightPress, button: 0 };

// Pi 的渲染器会在向扩展分发原始输入前处理右键，所以补丁必须先于内置右键粘贴执行。
test("copies an active selection on right press and consumes its release", async () => {
  const tui = new FakeFullscreenTui();
  const proxy = proxyTui(tui);
  assert.equal(patchFullscreenRightClickCopy(proxy), true);
  assert.equal(patchFullscreenRightClickCopy(proxy), true);

  tui.handleMouseEvent(rightPress);
  tui.handleMouseEvent(rightRelease);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(tui.copied, 1);
  assert.equal(tui.cleared, 1);
  assert.equal(tui.renders, 1);
  assert.equal(tui.selection, false);
  assert.deepEqual(tui.events, []);

  tui.handleMouseEvent(rightPress);
  tui.handleMouseEvent(rightRelease);
  assert.equal(tui.pasted, 1);
  tui.handleMouseEvent(leftPress);
  assert.deepEqual(tui.events, [leftPress]);
  assert.equal(restoreFullscreenRightClickCopy(proxy), true);
  tui.selection = true;
  tui.handleMouseEvent(rightPress);
  assert.deepEqual(tui.events.at(-1), rightPress);
});

test("pastes once to Pi's focused target when the selection is empty", () => {
  const tui = new FakeFullscreenTui();
  assert.equal(patchFullscreenRightClickCopy(proxyTui(tui)), true);

  tui.selection = false;
  tui.handleMouseEvent(rightPress);
  tui.handleMouseEvent(rightRelease);
  assert.equal(tui.pasted, 1);
  assert.equal(tui.copied, 0);
  assert.deepEqual(tui.events, []);

  tui.copyOnSelect = true;
  tui.handleMouseEvent(rightPress);
  tui.handleMouseEvent({ ...rightRelease, button: 3 });
  assert.equal(tui.pasted, 2);
  assert.deepEqual(tui.events, []);
  assert.equal(restoreFullscreenRightClickCopy(tui), true);
});

test("keeps Pi's mouse handling for selections with auto-copy, missing paste, or other buttons", () => {
  const tui = new FakeFullscreenTui();
  assert.equal(patchFullscreenRightClickCopy(proxyTui(tui)), true);
  tui.copyOnSelect = true;
  tui.handleMouseEvent(rightPress);
  tui.copyOnSelect = false;
  tui.selection = false;
  tui.onRightClickPaste = undefined;
  tui.handleMouseEvent(rightPress);
  tui.handleMouseEvent(rightRelease);
  tui.handleMouseEvent({ ...rightPress, button: 10 });
  assert.equal(tui.copied, 0);
  assert.equal(tui.pasted, 0);
  assert.deepEqual(tui.events, [rightPress, rightPress, rightRelease, { ...rightPress, button: 10 }]);
  assert.equal(restoreFullscreenRightClickCopy(tui), true);
});

test("does not change regular or incompatible renderers", () => {
  assert.equal(patchFullscreenRightClickCopy(proxyTui({ mode: "regular" })), false);
  assert.equal(patchFullscreenRightClickCopy(proxyTui({ mode: "fullscreen" })), false);
  assert.equal(restoreFullscreenRightClickCopy({}), false);
});

test("reports clipboard errors without passing the click through as paste", async () => {
  const tui = new FakeFullscreenTui();
  tui.copyResult = Promise.reject(new Error("clipboard unavailable"));
  const errors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    assert.equal(patchFullscreenRightClickCopy(tui), true);
    tui.handleMouseEvent(rightPress);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(tui.copied, 1);
    assert.deepEqual(tui.events, []);
    assert.equal(tui.cleared, 0);
    assert.equal(tui.selection, true);
    assert.deepEqual(tui.flashes, ["Copy failed"]);
    assert.match(String(errors[0]?.[0]), /复制失败/);
  } finally {
    console.error = originalError;
    restoreFullscreenRightClickCopy(tui);
  }
});

test("keeps selection on an unsuccessful copy or when a newer selection replaced it", async () => {
  const tui = new FakeFullscreenTui();
  assert.equal(patchFullscreenRightClickCopy(tui), true);
  try {
    tui.copyResult = Promise.resolve(false);
    tui.handleMouseEvent(rightPress);
    tui.handleMouseEvent(rightRelease);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(tui.cleared, 0);
    assert.equal(tui.renders, 0);

    let finishCopy!: (copied: boolean) => void;
    tui.copyResult = new Promise<boolean>((resolve) => { finishCopy = resolve; });
    tui.handleMouseEvent(rightPress);
    tui.handleMouseEvent(rightRelease);
    tui.selectionAnchor = { row: 1, col: 0 };
    tui.selectionFocus = { row: 1, col: 6 };
    finishCopy(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(tui.cleared, 0);
    assert.equal(tui.selection, true);
    assert.equal(tui.renders, 0);
  } finally {
    restoreFullscreenRightClickCopy(tui);
  }
});

test("does not clear a selection after the patch is restored during copy", async () => {
  const tui = new FakeFullscreenTui();
  let finishCopy!: (copied: boolean) => void;
  tui.copyResult = new Promise<boolean>((resolve) => { finishCopy = resolve; });
  assert.equal(patchFullscreenRightClickCopy(tui), true);
  tui.handleMouseEvent(rightPress);
  assert.equal(restoreFullscreenRightClickCopy(tui), true);
  finishCopy(true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(tui.cleared, 0);
  assert.equal(tui.renders, 0);
  assert.equal(tui.selection, true);
});

test("installs through the extension widget and restores on session shutdown", async () => {
  const tui = new FakeFullscreenTui();
  const widgets: unknown[] = [];
  const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: {
      setWidget(_key: string, widget: unknown) {
        widgets.push(widget);
        if (typeof widget === "function") widget(proxyTui(tui), {});
      },
    },
  };
  installFullscreenRightClickCopy({ on: (event: string, handler: (event: unknown, ctx: unknown) => void) => { handlers.set(event, handler); } } as never);
  handlers.get("session_start")!({}, ctx);
  tui.handleMouseEvent(rightPress);
  assert.equal(tui.copied, 1);
  handlers.get("session_shutdown")!({}, ctx);
  tui.handleMouseEvent(rightPress);
  assert.equal(tui.copied, 1);
  assert.deepEqual(tui.events, [rightPress]);
  assert.equal(widgets.at(-1), undefined);
});
