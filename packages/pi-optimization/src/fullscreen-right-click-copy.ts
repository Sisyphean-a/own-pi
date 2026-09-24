import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const WIDGET_KEY = "pi-optimization.fullscreen-right-click-copy";
const PATCH_KEY = Symbol.for("pi-optimization.fullscreen-right-click-copy.patch");

type MouseHandler = (event: unknown) => void;
type RuntimePrototype = { handleMouseEvent?: MouseHandler };
type RuntimeTui = {
  mode?: unknown;
  __proto__?: RuntimePrototype;
  getCopyOnSelect?: () => boolean;
  hasActiveSelection?: () => boolean;
  copyActiveSelectionToClipboard?: () => Promise<boolean>;
  clearTextSelection?: () => void;
  requestRender?: () => void;
  selectionAnchor?: unknown;
  selectionFocus?: unknown;
  onRightClickPaste?: () => void;
  flash?: (message: string) => void;
};
type PatchState = {
  original: MouseHandler;
  wrapped: MouseHandler;
  pressed: WeakSet<RuntimeTui>;
};

function getPrototype(tui: unknown): RuntimePrototype | undefined {
  if (!tui || typeof tui !== "object") return undefined;
  // Pi 的 widget 参数是代理；其 __proto__ getter 才指向实际 renderer 的原型。
  const prototype = (tui as RuntimeTui).__proto__;
  return prototype && typeof prototype === "object" ? prototype : undefined;
}

function getState(prototype: RuntimePrototype): PatchState | undefined {
  return (prototype as Record<PropertyKey, unknown>)[PATCH_KEY] as PatchState | undefined;
}

function restorePrototype(prototype: RuntimePrototype): boolean {
  const state = getState(prototype);
  if (!state) return false;
  try {
    if (prototype.handleMouseEvent === state.wrapped) prototype.handleMouseEvent = state.original;
    delete (prototype as Record<PropertyKey, unknown>)[PATCH_KEY];
    return true;
  } catch {
    return false;
  }
}

/** fullscreen 右键：手动复制非空选区，否则复用 Pi 的聚焦组件粘贴入口。 */
export function patchFullscreenRightClickCopy(tui: unknown): boolean {
  if (!tui || typeof tui !== "object") return false;
  const runtime = tui as RuntimeTui;
  if (
    runtime.mode !== "fullscreen" ||
    typeof runtime.getCopyOnSelect !== "function" ||
    typeof runtime.hasActiveSelection !== "function" ||
    typeof runtime.copyActiveSelectionToClipboard !== "function"
  ) return false;

  const prototype = getPrototype(runtime);
  if (!prototype || typeof prototype.handleMouseEvent !== "function") return false;
  if (getState(prototype)) return true;

  const state: PatchState = {
    original: prototype.handleMouseEvent,
    wrapped: prototype.handleMouseEvent,
    pressed: new WeakSet(),
  };
  const wrapped: MouseHandler = function (this: RuntimeTui, event: unknown): void {
    const mouse = event as { button?: unknown; release?: unknown } | null;
    if (mouse?.release === true && (mouse.button === 2 || mouse.button === 3) && state.pressed.has(this)) {
      state.pressed.delete(this);
      return;
    }
    if (mouse?.release === false && mouse.button === 2) {
      const hasSelection = this.hasActiveSelection?.();
      if (!hasSelection && typeof this.onRightClickPaste === "function") {
        state.pressed.add(this);
        try {
          this.onRightClickPaste();
        } catch (error) {
          console.error("[pi-optimization/fullscreen-right-click-copy] 粘贴失败：", error);
        }
        return;
      }
      if (hasSelection && !this.getCopyOnSelect?.()) {
        state.pressed.add(this);
        const anchor = this.selectionAnchor;
        const focus = this.selectionFocus;
        const reportFailure = (error: unknown): void => {
          console.error("[pi-optimization/fullscreen-right-click-copy] 复制失败：", error);
          try {
            this.flash?.("Copy failed");
          } catch {
            // 异步复制完成时 UI 可能已经关闭。
          }
        };
        try {
          void Promise.resolve(this.copyActiveSelectionToClipboard?.()).then((copied) => {
            // Rule: 只清除本次成功复制的选区；异步期间重选或会话结束都不能抹掉新状态。
            if (copied !== true || getState(prototype) !== state || anchor === undefined ||
              focus === undefined || this.selectionAnchor !== anchor || this.selectionFocus !== focus ||
              typeof this.clearTextSelection !== "function" || typeof this.requestRender !== "function") return;
            try {
              this.clearTextSelection();
              this.requestRender();
            } catch (error) {
              console.error("[pi-optimization/fullscreen-right-click-copy] 清除选区失败：", error);
            }
          }, reportFailure);
        } catch (error) {
          reportFailure(error);
        }
        return;
      }
    }
    if (mouse?.release === false) state.pressed.delete(this);
    state.original.call(this, event);
  };
  state.wrapped = wrapped;

  try {
    prototype.handleMouseEvent = wrapped;
    Object.defineProperty(prototype, PATCH_KEY, {
      configurable: true,
      enumerable: false,
      value: state,
    });
    return true;
  } catch {
    try {
      prototype.handleMouseEvent = state.original;
    } catch {
      // 只在可写的运行时原型上安装，不影响其他 Pi 功能。
    }
    return false;
  }
}

export function restoreFullscreenRightClickCopy(tui: unknown): boolean {
  const prototype = getPrototype(tui);
  return prototype ? restorePrototype(prototype) : false;
}

function createEmptyWidget(): { render: () => string[]; invalidate: () => void } {
  return { render: () => [], invalidate: () => {} };
}

export function installFullscreenRightClickCopy(pi: ExtensionAPI): void {
  if (typeof pi.on !== "function") return;
  let patchedPrototype: RuntimePrototype | undefined;

  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    if (ctx.mode !== "tui" || !ctx.hasUI || typeof ctx.ui?.setWidget !== "function") return;
    try {
      ctx.ui.setWidget(WIDGET_KEY, (tui) => {
        const prototype = getPrototype(tui);
        if (patchedPrototype && patchedPrototype !== prototype) restorePrototype(patchedPrototype);
        patchedPrototype = patchFullscreenRightClickCopy(tui) ? prototype : undefined;
        return createEmptyWidget();
      });
    } catch (error) {
      console.error("[pi-optimization/fullscreen-right-click-copy] 安装失败：", error);
    }
  });

  pi.on("session_shutdown", (_event, ctx: ExtensionContext) => {
    if (patchedPrototype) restorePrototype(patchedPrototype);
    patchedPrototype = undefined;
    try {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
    } catch {
      // Pi 可能已重置 UI。
    }
  });
}

export default installFullscreenRightClickCopy;
