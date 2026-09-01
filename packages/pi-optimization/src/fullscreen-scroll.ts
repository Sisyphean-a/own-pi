import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const CONFIG_KEY = "fullscreen-scroll";
export const SETTINGS_FILE = join(homedir(), ".pi", "agent", "settings.json");
export const DEFAULT_WHEEL_SCROLL_LINES = 3;
export const WIDGET_KEY = "pi-optimization.fullscreen-scroll";

export interface FullscreenScrollConfig {
  enabled: boolean;
  wheelScrollLines: number;
}

export interface FullscreenScrollOptions {
  settingsFile?: string;
  defaultEnabled?: boolean;
  defaultWheelScrollLines?: number;
}

type RuntimeWheelHandler = (event: unknown) => unknown;

type RuntimeTuiPrototype = {
  routeWheel?: RuntimeWheelHandler;
};

type RuntimeTui = {
  mode?: unknown;
  wheelScrollLines?: unknown;
  __proto__?: RuntimeTuiPrototype;
};

type WheelPatchState = {
  original: RuntimeWheelHandler;
  wrapped: RuntimeWheelHandler;
  enabled: boolean;
  wheelScrollLines: number;
};

const PATCH_KEY = Symbol.for("pi-optimization.fullscreen-scroll.patch");

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultConfig(options: FullscreenScrollOptions = {}): FullscreenScrollConfig {
  return {
    // ConPTY/原生 Windows 是目标环境；其他终端可通过配置或命令显式开启。
    enabled: options.defaultEnabled ?? process.platform === "win32",
    wheelScrollLines: normalizeWheelScrollLines(
      options.defaultWheelScrollLines,
      DEFAULT_WHEEL_SCROLL_LINES,
    ),
  };
}

function normalizeWheelScrollLines(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1
    ? value
    : fallback;
}

function getPatchState(prototype: RuntimeTuiPrototype): WheelPatchState | undefined {
  return (prototype as Record<PropertyKey, unknown>)[PATCH_KEY] as WheelPatchState | undefined;
}

function getRuntimePrototype(tui: unknown): RuntimeTuiPrototype | undefined {
  if (!tui || typeof tui !== "object") return undefined;

  // Extension UI 提供稳定代理；其 __proto__ getter 指向当前 renderer，不能改用
  // Object.getPrototypeOf(proxy)，后者只会看到代理目标对象。
  const prototype = (tui as RuntimeTui).__proto__;
  return prototype && typeof prototype === "object" ? prototype : undefined;
}

function updatePatchState(
  prototype: RuntimeTuiPrototype,
  config: FullscreenScrollConfig,
): boolean {
  const state = getPatchState(prototype);
  if (!state) return false;

  state.enabled = config.enabled;
  state.wheelScrollLines = config.wheelScrollLines;
  return true;
}

/**
 * 不改变普通 TUI，只调整 Pi 的 fullscreen 滚轮处理。
 *
 * Failure：ExtensionAPI 没有公开 wheelScrollLines；只有检测到预期运行时 seam
 * 才临时打补丁，Pi 版本不兼容时保持空操作。
 */
export function patchFullscreenTui(
  tui: unknown,
  config: FullscreenScrollConfig,
): boolean {
  if (!tui || typeof tui !== "object") return false;

  const runtime = tui as RuntimeTui;
  if (runtime.mode !== "fullscreen" || typeof runtime.wheelScrollLines !== "number") {
    return false;
  }

  const prototype = getRuntimePrototype(runtime);
  const routeWheel = prototype?.routeWheel;
  if (!prototype || typeof routeWheel !== "function") return false;

  if (updatePatchState(prototype, config)) return true;

  const state: WheelPatchState = {
    original: routeWheel,
    wrapped: routeWheel,
    enabled: config.enabled,
    wheelScrollLines: config.wheelScrollLines,
  };
  const wrapped: RuntimeWheelHandler = function (this: RuntimeTui, event: unknown): unknown {
    const previous = this.wheelScrollLines;
    this.wheelScrollLines = state.enabled ? state.wheelScrollLines : 1;
    try {
      return state.original.call(this, event);
    } finally {
      this.wheelScrollLines = previous;
    }
  };
  state.wrapped = wrapped;

  try {
    prototype.routeWheel = wrapped;
    Object.defineProperty(prototype, PATCH_KEY, {
      configurable: true,
      enumerable: false,
      value: state,
      writable: false,
    });
  } catch {
    prototype.routeWheel = routeWheel;
    return false;
  }

  return true;
}

/** 恢复本功能在指定 fullscreen TUI/代理上拥有的补丁。 */
export function restoreFullscreenTuiPatch(tui: unknown): boolean {
  const prototype = getRuntimePrototype(tui);
  if (!prototype) return false;

  const state = getPatchState(prototype);
  if (!state) return false;

  try {
    if (prototype.routeWheel === state.wrapped) {
      prototype.routeWheel = state.original;
    }
    delete (prototype as Record<PropertyKey, unknown>)[PATCH_KEY];
    return true;
  } catch {
    return false;
  }
}

export function readFullscreenScrollConfig(
  settingsFile = SETTINGS_FILE,
  defaults: FullscreenScrollOptions = {},
): FullscreenScrollConfig {
  const fallback = defaultConfig(defaults);

  try {
    const raw = JSON.parse(readFileSync(settingsFile, "utf8")) as Record<string, unknown>;
    const configured = raw?.[CONFIG_KEY];
    const config = configured && typeof configured === "object"
      ? configured as Record<string, unknown>
      : {};

    return {
      enabled: typeof config.enabled === "boolean" ? config.enabled : fallback.enabled,
      wheelScrollLines: normalizeWheelScrollLines(
        config.wheelScrollLines,
        fallback.wheelScrollLines,
      ),
    };
  } catch {
    return fallback;
  }
}

export function writeFullscreenScrollConfig(
  patch: Partial<FullscreenScrollConfig>,
  settingsFile = SETTINGS_FILE,
  defaults: FullscreenScrollOptions = {},
): void {
  try {
    const current = existsSync(settingsFile)
      ? (JSON.parse(readFileSync(settingsFile, "utf8")) as Record<string, unknown>)
      : {};
    current[CONFIG_KEY] = {
      ...readFullscreenScrollConfig(settingsFile, defaults),
      ...patch,
    };
    writeFileSync(settingsFile, JSON.stringify(current, null, 2) + "\n");
  } catch (error) {
    console.error(`[pi-optimization/fullscreen-scroll] 写入配置失败：${errorMessage(error)}`);
  }
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning"): void {
  try {
    if (ctx.hasUI && typeof ctx.ui?.notify === "function") {
      ctx.ui.notify(message, level);
    }
  } catch {
    // UI is optional and can be stale while a session is being replaced.
  }
}

function createEmptyWidget(): { render: () => string[]; invalidate: () => void } {
  return {
    render: () => [],
    invalidate: () => {},
  };
}

function applyFullscreenScrollWidget(
  ctx: ExtensionContext,
  config: FullscreenScrollConfig,
  patchedPrototype: { value?: RuntimeTuiPrototype },
): boolean {
  if (ctx.mode !== "tui" || !ctx.hasUI || typeof ctx.ui?.setWidget !== "function") {
    return false;
  }

  let applied = false;
  try {
    ctx.ui.setWidget(WIDGET_KEY, (tui) => {
      const runtime = tui as unknown;
      const prototype = getRuntimePrototype(runtime);
      if (prototype) {
        updatePatchState(prototype, config);
      }
      if (patchFullscreenTui(runtime, config)) {
        patchedPrototype.value = prototype;
        applied = true;
      }
      return createEmptyWidget();
    });
  } catch (error) {
    console.error(`[pi-optimization/fullscreen-scroll] 应用配置失败：${errorMessage(error)}`);
  }
  return applied;
}

function isPositiveInteger(value: string): boolean {
  const parsed = Number(value);
  return /^\d+$/.test(value) && Number.isSafeInteger(parsed) && parsed >= 1;
}

export function installFullscreenScroll(
  pi: ExtensionAPI,
  options: FullscreenScrollOptions = {},
): void {
  if (typeof pi.on !== "function") return;

  const settingsFile = options.settingsFile ?? SETTINGS_FILE;
  const patchedPrototype: { value?: RuntimeTuiPrototype } = {};
  const readConfig = (): FullscreenScrollConfig =>
    readFullscreenScrollConfig(settingsFile, options);
  const apply = (ctx: ExtensionContext): boolean =>
    applyFullscreenScrollWidget(ctx, readConfig(), patchedPrototype);

  pi.on("session_start", (_event, ctx) => {
    apply(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    const prototype = patchedPrototype.value;
    if (prototype) {
      const state = getPatchState(prototype);
      if (state) {
        try {
          if (prototype.routeWheel === state.wrapped) prototype.routeWheel = state.original;
          delete (prototype as Record<PropertyKey, unknown>)[PATCH_KEY];
        } catch {
          // 渲染器可能已在关闭过程中销毁，不能阻塞 Pi 清理。
        }
      }
    }
    patchedPrototype.value = undefined;
    try {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
    } catch {
      // Pi 可能已经重置 UI。
    }
  });

  if (typeof pi.registerCommand !== "function") return;

  pi.registerCommand("fullscreen-scroll", {
    description: "查看/设置 fullscreen 鼠标滚轮速度：on | off | <每次行数>",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      const config = readConfig();

      if (arg === "on" || arg === "off") {
        const enabled = arg === "on";
        writeFullscreenScrollConfig({ enabled }, settingsFile, options);
        apply(ctx);
        notify(
          ctx,
          `fullscreen 滚轮加速已${enabled ? "启用" : "停用"}（${config.wheelScrollLines} 行/次）`,
          enabled ? "info" : "warning",
        );
        return;
      }

      if (isPositiveInteger(arg)) {
        const wheelScrollLines = Number(arg);
        writeFullscreenScrollConfig(
          { enabled: true, wheelScrollLines },
          settingsFile,
          options,
        );
        apply(ctx);
        notify(ctx, `fullscreen 滚轮速度已设为 ${wheelScrollLines} 行/次`, "info");
        return;
      }

      if (arg) {
        notify(ctx, "用法：/fullscreen-scroll [on|off|<每次滚动行数>]", "warning");
        return;
      }

      notify(
        ctx,
        `fullscreen 滚轮加速：${config.enabled ? "开启" : "关闭"}（${config.wheelScrollLines} 行/次）`,
        "info",
      );
    },
  });
}

export default installFullscreenScroll;
