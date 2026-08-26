import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { fileURLToPath } from "node:url";
import type {
  DefaultPackageManager,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

type PackageUpdates = Awaited<
  ReturnType<DefaultPackageManager["checkForAvailableUpdates"]>
>;
type UpdateChecker = {
  checkForAvailableUpdates: () => Promise<PackageUpdates>;
};
type SpawnProcess = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;

type PackageManagerClass = new (options: {
  cwd: string;
  agentDir: string;
  settingsManager: unknown;
}) => UpdateChecker;

type SettingsManagerFactory = (
  cwd: string,
  agentDir: string,
  projectTrusted: boolean,
) => unknown;

interface PackageManagerModule {
  DefaultPackageManager?: PackageManagerClass;
  SettingsManager?: {
    create: (
      cwd: string,
      agentDir?: string,
      options?: { projectTrusted?: boolean },
    ) => unknown;
  };
  getAgentDir?: () => string;
}

interface UpdateState {
  launchPromise?: Promise<boolean>;
  started: boolean;
}

export interface AutoExtensionUpdateOptions {
  packageManagerClass?: PackageManagerClass;
  createSettingsManager?: SettingsManagerFactory;
  agentDir?: string;
  loadPackageManagerModule?: () => Promise<PackageManagerModule | undefined>;
  launchUpdate?: (sources: string[]) => Promise<boolean>;
}

export interface DetachedUpdateOptions {
  execPath?: string;
  argv?: string[];
  spawnProcess?: SpawnProcess;
}

export interface PiUpdateLaunch {
  command: string;
  args: string[];
}

interface EnvironmentLike {
  PI_OFFLINE?: string;
}

interface StartupGate {
  restore(): void;
}

interface StartupGateOptions {
  isPackageUpdateGuard?: () => boolean;
}

const UPDATE_STATE = Symbol.for("pi-optimization.auto-extension-update.state");
const UPDATE_STATE_FALLBACK: UpdateState = { started: false };

function getUpdateState(): UpdateState {
  const globalState = globalThis as typeof globalThis & {
    [UPDATE_STATE]?: UpdateState;
  };
  return (globalState[UPDATE_STATE] ??= UPDATE_STATE_FALLBACK);
}

function usesScriptEntrypoint(execPath: string): boolean {
  const executableName = execPath.split(/[\\/]/).at(-1)?.toLowerCase();
  return (
    executableName === "node" ||
    executableName === "node.exe" ||
    executableName === "bun" ||
    executableName === "bun.exe"
  );
}

export function resolvePiUpdateLaunch(
  execPath = process.execPath,
  argv = process.argv,
): PiUpdateLaunch | undefined {
  if (usesScriptEntrypoint(execPath)) {
    const entrypoint = argv[1];
    if (!entrypoint) return undefined;
    return {
      command: execPath,
      args: [entrypoint, "update", "--extensions"],
    };
  }

  return {
    command: execPath,
    args: ["update", "--extensions"],
  };
}

function resolveSelectiveUpdateLaunch(
  sources: string[],
  execPath = process.execPath,
  argv = process.argv,
): PiUpdateLaunch | undefined {
  const launch = resolvePiUpdateLaunch(execPath, argv);
  if (!launch || sources.length === 0) return undefined;

  if (!usesScriptEntrypoint(execPath)) {
    if (sources.length !== 1) return undefined;
    return {
      command: launch.command,
      args: [
        ...launch.args.slice(0, -2),
        "update",
        "--extension",
        sources[0],
      ],
    };
  }

  const runner = fileURLToPath(new URL("./update-runner.js", import.meta.url));
  const baseArgs = launch.args.slice(0, 1);
  return {
    command: execPath,
    args: [runner, launch.command, JSON.stringify(baseArgs), ...sources],
  };
}

/**
 * 在独立进程中启动扩展更新，启动后立即解除父进程引用。
 *
 * Guarantee: 不创建 shell、窗口、管道、定时器或常驻监听；子进程完成后自然退出。
 */
export async function launchDetachedExtensionUpdate(
  options: DetachedUpdateOptions = {},
  sources: string[] = [],
): Promise<boolean> {
  const launch =
    sources.length > 0
      ? resolveSelectiveUpdateLaunch(sources, options.execPath, options.argv)
      : resolvePiUpdateLaunch(options.execPath, options.argv);
  if (!launch) return false;

  let child: ChildProcess;
  try {
    child = (options.spawnProcess ?? spawn)(launch.command, launch.args, {
      detached: true,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
  } catch {
    return false;
  }

  return new Promise<boolean>((resolve) => {
    const finish = (started: boolean): void => {
      child.removeListener("spawn", onSpawn);
      child.removeListener("error", onError);
      resolve(started);
    };
    const onSpawn = (): void => {
      child.unref();
      finish(true);
    };
    const onError = (): void => finish(false);

    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

function isPackageUpdateGuardCall(): boolean {
  return new Error().stack?.includes("checkForPackageUpdates") ?? false;
}

/**
 * 屏蔽 Pi 当前启动流程中的包更新提示，同时保留其他网络检查。
 *
 * 不能按读取次数拦截：DefaultPackageManager 会为每个候选扩展读取一次
 * PI_OFFLINE。改为只匹配 Pi 的 checkForPackageUpdates 调用栈，让插件自己的
 * 完整检查和模型/版本检查看到原始环境；命中目标后立即恢复环境。
 */
export function installPackageUpdateCheckGate(
  environment: EnvironmentLike = process.env,
  options: StartupGateOptions = {},
): StartupGate {
  const originalPrototype = Object.getPrototypeOf(environment);
  const hadOwnValue = Object.prototype.hasOwnProperty.call(environment, "PI_OFFLINE");
  const originalValue = environment.PI_OFFLINE;
  let restored = false;
  const isTargetGuard = options.isPackageUpdateGuard ?? isPackageUpdateGuardCall;

  const restore = (): void => {
    if (restored) return;
    restored = true;
    if (Object.getPrototypeOf(environment) === gatePrototype) {
      Object.setPrototypeOf(environment, originalPrototype);
    }
    if (hadOwnValue) environment.PI_OFFLINE = originalValue;
    else delete environment.PI_OFFLINE;
  };

  const gatePrototype = Object.create(originalPrototype, {
    PI_OFFLINE: {
      configurable: true,
      get(): string | undefined {
        if (!isTargetGuard()) return originalValue;
        restore();
        return "1";
      },
    },
  });

  if (hadOwnValue) delete environment.PI_OFFLINE;
  Object.setPrototypeOf(environment, gatePrototype);
  return { restore };
}

function isOffline(): boolean {
  const value = process.env.PI_OFFLINE;
  return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes";
}

async function loadPackageManagerModule(): Promise<PackageManagerModule | undefined> {
  try {
    return await import("@earendil-works/pi-coding-agent") as PackageManagerModule;
  } catch {
    return undefined;
  }
}

function createSettingsManager(
  module: PackageManagerModule,
  options: AutoExtensionUpdateOptions,
  ctx: ExtensionContext,
  agentDir: string,
): unknown {
  if (options.createSettingsManager) {
    return options.createSettingsManager(ctx.cwd, agentDir, ctx.isProjectTrusted?.() ?? true);
  }
  return module.SettingsManager?.create(ctx.cwd, agentDir, {
    projectTrusted: ctx.isProjectTrusted?.() ?? true,
  });
}

function startUpdateOnce(launchUpdate: () => Promise<boolean>): Promise<boolean> {
  const state = getUpdateState();
  state.launchPromise ??= Promise.resolve()
    .then(launchUpdate)
    .then((started) => {
      if (started) state.started = true;
      else state.launchPromise = undefined;
      return started;
    })
    .catch(() => {
      state.launchPromise = undefined;
      return false;
    });
  return state.launchPromise;
}

/**
 * 复用 Pi 的包更新检查，在有更新时启动隐藏的扩展更新进程。
 */
export async function installAutoExtensionUpdate(
  pi: ExtensionAPI,
  options: AutoExtensionUpdateOptions = {},
): Promise<void> {
  if (typeof pi.on !== "function") return;

  const module = await (options.loadPackageManagerModule ?? loadPackageManagerModule)();
  const packageManagerClass = options.packageManagerClass ?? module?.DefaultPackageManager;
  const agentDir = options.agentDir ?? module?.getAgentDir?.();
  if (!packageManagerClass || !agentDir) return;

  const launchUpdate =
    options.launchUpdate ??
    ((sources: string[]) => launchDetachedExtensionUpdate({}, sources));
  let activeGate: StartupGate | undefined;
  let lifecycleToken = 0;

  pi.on("session_shutdown", () => {
    lifecycleToken++;
    activeGate?.restore();
    activeGate = undefined;
  });

  pi.on("session_start", (_event, ctx) => {
    const sessionToken = ++lifecycleToken;
    activeGate?.restore();
    activeGate = undefined;
    if (ctx.mode !== "tui" || isOffline()) return;

    let check: Promise<PackageUpdates>;
    try {
      const settingsManager = createSettingsManager(module ?? {}, options, ctx, agentDir);
      if (!settingsManager) return;
      // Start before installing the gate. The gate identifies Pi's own package
      // update guard, while all reads in this complete check see the real value.
      check = new packageManagerClass({
        cwd: ctx.cwd,
        agentDir,
        settingsManager,
      }).checkForAvailableUpdates();
    } catch {
      return;
    }

    let gate: StartupGate;
    try {
      gate = installPackageUpdateCheckGate();
    } catch {
      // If this compatibility bridge is unavailable, leave Pi's own notification
      // path untouched instead of launching an update without suppressing it.
      void check.catch(() => undefined);
      return;
    }
    activeGate = gate;
    void check
      .then((updates) => {
        if (sessionToken !== lifecycleToken || !Array.isArray(updates)) {
          return false;
        }
        const sources = [...new Set(updates.map((update) => update.source))];
        if (sources.length === 0 || getUpdateState().started) return false;
        return startUpdateOnce(() => launchUpdate(sources));
      })
      .catch(() => {
        if (sessionToken === lifecycleToken && activeGate === gate) {
          gate.restore();
          activeGate = undefined;
        }
        return false;
      });
  });
}

export default installAutoExtensionUpdate;
