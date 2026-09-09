import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const thinkingLevels: ModelThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export type Combo = {
  name: string;
  provider: string;
  modelId: string;
  thinkingLevel: ModelThinkingLevel;
  model: Model<Api> | undefined;
  supportedThinkingLevels: ModelThinkingLevel[];
};

type ComboConfig = {
  provider: string;
  modelId: string;
  thinkingLevel: ModelThinkingLevel;
};

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isThinkingLevel(value: unknown): value is ModelThinkingLevel {
  return typeof value === "string" && thinkingLevels.includes(value as ModelThinkingLevel);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readConfigFile(path: string): Record<string, ComboConfig> {
  if (!existsSync(path)) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`无法解析组合配置 ${path}：${formatError(error)}`);
  }

  if (!isJsonObject(parsed)) {
    throw new Error(`组合配置 ${path} 必须是 JSON 对象`);
  }

  const config: Record<string, ComboConfig> = Object.create(null);
  for (const [name, value] of Object.entries(parsed)) {
    if (!name.trim()) throw new Error(`组合配置 ${path} 包含空名称`);
    if (!isJsonObject(value)) {
      throw new Error(`组合“${name}”在 ${path} 中必须是对象`);
    }

    const provider = value.provider;
    const modelId = value.model ?? value.modelId;
    const level = value.thinkingLevel;
    if (typeof provider !== "string" || !provider.trim()) {
      throw new Error(`组合“${name}”缺少有效的 provider：${path}`);
    }
    if (typeof modelId !== "string" || !modelId.trim()) {
      throw new Error(`组合“${name}”缺少有效的 model：${path}`);
    }
    if (!isThinkingLevel(level)) {
      throw new Error(`组合“${name}”的 thinkingLevel 无效：${path}`);
    }

    config[name] = {
      provider: provider.trim(),
      modelId: modelId.trim(),
      thinkingLevel: level,
    };
  }

  return config;
}

export function getComboConfigPaths(ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">): string[] {
  const paths = [join(getAgentDir(), "quick-panel.json")];
  if (ctx.isProjectTrusted()) {
    paths.push(join(ctx.cwd, CONFIG_DIR_NAME, "quick-panel.json"));
  }
  return paths;
}

export function loadCombos(ctx: ExtensionContext): Combo[] {
  const merged: Record<string, ComboConfig> = Object.create(null);
  for (const path of getComboConfigPaths(ctx)) {
    Object.assign(merged, readConfigFile(path));
  }

  const modelsByKey = new Map(
    ctx.modelRegistry.getAvailable().map((model) => [`${model.provider}/${model.id}`, model]),
  );

  return Object.entries(merged)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, config]) => {
      const model = modelsByKey.get(`${config.provider}/${config.modelId}`);
      return {
        name,
        provider: config.provider,
        modelId: config.modelId,
        thinkingLevel: config.thinkingLevel,
        model,
        supportedThinkingLevels: model ? getSupportedThinkingLevels(model) : [],
      };
    });
}
