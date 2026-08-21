import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const CONFIG_KEY = "vision-mcp-auto";
export const DEFAULT_PATTERNS = ["analyze_image"];
export const SETTINGS_FILE = join(homedir(), ".pi", "agent", "settings.json");

type Mode = "auto" | "on" | "off";

export interface ExtensionConfig {
  mode: Mode;
  toolPatterns: string[];
}

interface ToolLike {
  name?: unknown;
}

interface ToolApi {
  getAllTools?: () => ToolLike[];
  getActiveTools?: () => string[];
  setActiveTools?: (toolNames: string[]) => void;
}

export interface VisionMcpOptions {
  settingsFile?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultConfig(): ExtensionConfig {
  return { mode: "auto", toolPatterns: [...DEFAULT_PATTERNS] };
}

export function readVisionConfig(settingsFile = SETTINGS_FILE): ExtensionConfig {
  try {
    const raw = JSON.parse(readFileSync(settingsFile, "utf8")) as Record<string, unknown>;
    const cfg = (raw?.[CONFIG_KEY] ?? {}) as Record<string, unknown>;
    const mode: Mode = cfg.mode === "on" || cfg.mode === "off" ? cfg.mode : "auto";
    const configuredPatterns = Array.isArray(cfg.toolPatterns)
      ? cfg.toolPatterns.map(String).filter((pattern) => pattern.length > 0)
      : [];
    return {
      mode,
      toolPatterns: configuredPatterns.length > 0 ? configuredPatterns : [...DEFAULT_PATTERNS],
    };
  } catch {
    return defaultConfig();
  }
}

export function writeVisionConfig(
  patch: Partial<ExtensionConfig>,
  settingsFile = SETTINGS_FILE,
): void {
  try {
    const current = existsSync(settingsFile)
      ? (JSON.parse(readFileSync(settingsFile, "utf8")) as Record<string, unknown>)
      : {};
    current[CONFIG_KEY] = { ...readVisionConfig(settingsFile), ...patch };
    writeFileSync(settingsFile, JSON.stringify(current, null, 2) + "\n");
  } catch (error) {
    console.error(`[pi-optimization/vision-mcp-auto] 写入配置失败：${errorMessage(error)}`);
  }
}

export function modelSupportsImage(model: ExtensionContext["model"]): boolean {
  return Boolean(model && Array.isArray(model.input) && model.input.includes("image"));
}

export function findVisionTools(pi: ExtensionAPI, patterns: string[]): string[] {
  try {
    const getAllTools = (pi as ToolApi).getAllTools;
    if (typeof getAllTools !== "function") return [];

    const toolPatterns = patterns.filter((pattern) => pattern.length > 0);
    if (toolPatterns.length === 0) return [];

    return getAllTools
      .call(pi)
      .filter((tool): tool is { name: string } => typeof tool?.name === "string")
      .map((tool) => tool.name)
      .filter((name) => toolPatterns.some((pattern) => name.endsWith(pattern)));
  } catch {
    // MCP tools may still be registering or the optional adapter may be gone.
    return [];
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

function syncVisionTools(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  settingsFile: string,
  announce = true,
): void {
  try {
    // No registered vision tool means no MCP adapter is available yet; keep the
    // state retryable so a later before_agent_start can observe late registration.
    const config = readVisionConfig(settingsFile);
    const visionTools = findVisionTools(pi, config.toolPatterns);
    if (visionTools.length === 0) return;

    // In auto mode, an absent model is not the same as a text-only model.
    // Wait for model_select so startup does not announce a temporary state and
    // then announce the final state again before the first agent turn.
    if (config.mode === "auto" && !ctx.model) return;

    const wanted =
      config.mode === "on" ? true : config.mode === "off" ? false : !modelSupportsImage(ctx.model);

    const api = pi as ToolApi;
    if (typeof api.getActiveTools !== "function" || typeof api.setActiveTools !== "function") {
      return;
    }

    const active = api.getActiveTools.call(pi);
    const next = new Set(active);
    for (const name of visionTools) {
      if (wanted) next.add(name);
      else next.delete(name);
    }
    const nextList = [...next];

    // Compare the full list instead of relying on a cached model key: another
    // extension or a reconnecting MCP server may have changed active tools.
    if (nextList.length === active.length && nextList.every((name, index) => name === active[index])) return;

    api.setActiveTools.call(pi, nextList);
    if (!announce) return;

    const modelName = ctx.model
      ? `${ctx.model.name} (${ctx.model.id}, ${modelSupportsImage(ctx.model) ? "支持" : "不支持"}图片)`
      : "(无模型)";
    const message = wanted
      ? `识图工具已激活：${visionTools.join(", ")} | ${modelName}`
      : `识图工具已关闭：${visionTools.join(", ")} | ${modelName}`;
    notify(ctx, message, "info");
    console.log(`[pi-optimization/vision-mcp-auto] ${message}`);
  } catch (error) {
    // Capability/version mismatches must not affect the session; a later
    // lifecycle event can retry after the MCP adapter recovers.
    console.error(`[pi-optimization/vision-mcp-auto] 同步失败：${errorMessage(error)}`);
  }
}

export function installVisionMcpAuto(
  pi: ExtensionAPI,
  options: VisionMcpOptions = {},
): void {
  const settingsFile = options.settingsFile ?? SETTINGS_FILE;

  if (typeof pi.on === "function") {
    pi.on("session_start", (_event, ctx) => {
      syncVisionTools(pi, ctx, settingsFile);
    });

    pi.on("model_select", (_event, ctx) => {
      syncVisionTools(pi, ctx, settingsFile);
    });

    // MCP tools can be registered after session_start.
    pi.on("before_agent_start", (_event, ctx) => {
      syncVisionTools(pi, ctx, settingsFile);
    });
  }

  if (typeof pi.registerCommand !== "function") return;

  pi.registerCommand("vision-mcp", {
    description: "查看/设置识图 MCP 开关：auto(按模型能力) | on(强制激活) | off(强制关闭)",
    handler: async (args, ctx) => {
      try {
        const arg = args?.trim().toLowerCase();
        if (arg === "on" || arg === "off" || arg === "auto") {
          writeVisionConfig({ mode: arg }, settingsFile);
          syncVisionTools(pi, ctx, settingsFile, false);
          notify(ctx, `识图 MCP 模式已设为 ${arg}`, "info");
          return;
        }

        const config = readVisionConfig(settingsFile);
        const visionTools = findVisionTools(pi, config.toolPatterns);
        let activeSet = new Set<string>();
        try {
          const getActiveTools = (pi as ToolApi).getActiveTools;
          if (typeof getActiveTools === "function") {
            activeSet = new Set(getActiveTools.call(pi));
          }
        } catch {
          // 状态读取失败时只展示未激活，不阻断命令。
        }

        const enabled = visionTools.filter((name) => activeSet.has(name));
        const modelName = ctx.model ? ctx.model.name : "(无模型)";
        const supports = modelSupportsImage(ctx.model);
        notify(
          ctx,
          `识图 MCP 模式：${config.mode} | 当前模型：${modelName} (${supports ? "支持" : "不支持"}图片)` +
            ` | 工具：${visionTools.join(", ") || "未注册"}` +
            ` | 已激活：${enabled.join(", ") || "无"}`,
          "info",
        );
      } catch (error) {
        console.error(`[pi-optimization/vision-mcp-auto] 命令失败：${errorMessage(error)}`);
      }
    },
  });
}

export default installVisionMcpAuto;
