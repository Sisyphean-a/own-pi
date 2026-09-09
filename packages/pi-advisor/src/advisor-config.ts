import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Model, ThinkingLevel } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface AdvisorConfig {
  enabled: boolean;
  provider: string;
  model: string;
  maxUsesPerRun: number;
  maxTokens: number;
  reasoning: ThinkingLevel;
  maxContextMessages: number;
  skipWhenCurrentModel: string[];
}

export const DEFAULT_CONFIG: AdvisorConfig = {
  enabled: false,
  provider: "anthropic",
  model: "claude-fable-5",
  maxUsesPerRun: 3,
  // Adaptive-thinking models count thinking tokens against the output cap;
  // 8k left too little room for the actual advice at reasoning=high.
  maxTokens: 16384,
  reasoning: "high",
  maxContextMessages: 18,
  skipWhenCurrentModel: [],
};

export const VALID_REASONING_LEVELS: ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh"];

type ModelLike = Pick<Model<any>, "provider" | "id">;

function configPath(): string {
  return join(getAgentDir(), "advisor.json");
}

export function normalizeSkipWhenCurrentModel(value: unknown): string[] {
  const values = Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : typeof value === "string"
      ? value.split(",")
      : [];
  return [...new Set(values.map((entry) => entry.trim()).filter((entry) => entry.length > 0))];
}

export function loadAdvisorConfig(): AdvisorConfig {
  const path = configPath();
  if (!existsSync(path)) return { ...DEFAULT_CONFIG, skipWhenCurrentModel: [] };
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    return {
      enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_CONFIG.enabled,
      provider: typeof raw.provider === "string" ? raw.provider : DEFAULT_CONFIG.provider,
      model: typeof raw.model === "string" ? raw.model : DEFAULT_CONFIG.model,
      maxUsesPerRun: typeof raw.maxUsesPerRun === "number" ? raw.maxUsesPerRun : DEFAULT_CONFIG.maxUsesPerRun,
      maxTokens: typeof raw.maxTokens === "number" ? raw.maxTokens : DEFAULT_CONFIG.maxTokens,
      reasoning: VALID_REASONING_LEVELS.includes(raw.reasoning as ThinkingLevel)
        ? raw.reasoning as ThinkingLevel
        : DEFAULT_CONFIG.reasoning,
      maxContextMessages: typeof raw.maxContextMessages === "number"
        ? raw.maxContextMessages
        : DEFAULT_CONFIG.maxContextMessages,
      skipWhenCurrentModel: normalizeSkipWhenCurrentModel(raw.skipWhenCurrentModel),
    };
  } catch {
    return { ...DEFAULT_CONFIG, skipWhenCurrentModel: [] };
  }
}

export function saveAdvisorConfig(config: AdvisorConfig): void {
  const path = configPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2), "utf-8");
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

export function shouldSkipAdvisorForCurrentModel(
  model: ModelLike | undefined,
  patterns: string[],
): boolean {
  if (!model || typeof model.provider !== "string" || typeof model.id !== "string") return false;
  const modelKey = `${model.provider}/${model.id}`;
  return patterns.some((rawPattern) => {
    const pattern = rawPattern.trim();
    if (!pattern) return false;
    const candidate = pattern.includes("/") ? modelKey : model.id;
    return globToRegExp(pattern).test(candidate);
  });
}
