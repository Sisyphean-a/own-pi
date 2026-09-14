import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface ConfiguredModel {
	provider: string;
	id: string;
	thinking?: ModelThinkingLevel;
}

/**
 * `compactAfterTokens` 的语义。
 *
 * - `"calibrated"`（默认）：直接使用静态 `compactAfterTokens` 值，兼容所有现有 V3 配置。
 *
 * - `"ratio"`：有效阈值按 `floor(model.contextWindow * compactAfterTokensRatio)` 计算。
 *   它让主动压缩阈值随当前模型的上下文窗口自动缩放，使 1M 上下文的模型不会像 128K
 *   模型那样在同样的 81K 阈值被提前压缩。
 *
 *   有些模型宣称很大的上下文窗口，但长距离注意力会下降；用户可以在这些模型上降低
 *   `compactAfterTokensRatio` 以更早压缩，而不必在保持敏锐的模型上放弃窗口。
 *
 *   当前模型的 `contextWindow` 不可用时（undefined、0 或负数），ratio 模式回退到
 *   calibrated 的 `compactAfterTokens` 值，保证压缩仍能安全触发。
 */
export type CompactAfterTokensMode = "calibrated" | "ratio";

export interface Config {
	observeAfterTokens: number;
	reflectAfterTokens: number;
	/**
	 * 单次序列化给观察器的最大估算源 token 数。
	 * 未设置（默认）时从已解析的记忆模型上下文窗口推导；见 {@link resolveObserverChunkMaxTokens}。
	 */
	observerChunkMaxTokens?: number;
	compactAfterTokens: number;
	compactAfterTokensMode: CompactAfterTokensMode;
	compactAfterTokensRatio: number;
	observationsPoolMaxTokens: number;
	observationsPoolTargetTokens: number;
	agentMaxTurns: number;
	model?: ConfiguredModel;
	showWorkerNotifications: boolean;
	passive: boolean;
	debugLog: boolean;
}

export const DEFAULTS: Config = {
	observeAfterTokens: 10_000,
	reflectAfterTokens: 20_000,
	compactAfterTokens: 81_000,
	compactAfterTokensMode: "calibrated",
	compactAfterTokensRatio: 0.68,
	observationsPoolMaxTokens: 20_000,
	observationsPoolTargetTokens: 10_000,
	agentMaxTurns: 16,
	showWorkerNotifications: true,
	passive: false,
	debugLog: false,
};

export const COMPACT_AFTER_TOKENS_MODE_VALUES: readonly CompactAfterTokensMode[] = ["calibrated", "ratio"] as const;

/**
 * 根据配置和当前模型上下文窗口解析有效的主动压缩 token 阈值。
 *
 * `"calibrated"` 模式下始终为 `config.compactAfterTokens`。
 *
 * `"ratio"` 模式下，`contextWindow` 为正数时取
 * `floor(contextWindow * compactAfterTokensRatio)`（下限为 1），否则回退到
 * `config.compactAfterTokens`。
 */
export function resolveCompactAfterTokens(config: Config, contextWindow: number | undefined): number {
	if (config.compactAfterTokensMode === "ratio" && typeof contextWindow === "number" && contextWindow > 0) {
		return Math.max(1, Math.floor(contextWindow * config.compactAfterTokensRatio));
	}
	return config.compactAfterTokens;
}

export const THINKING_LEVEL_VALUES: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** 未配置且模型上下文窗口未知时使用的观察器分块上限。 */
export const OBSERVER_CHUNK_FALLBACK_MAX_TOKENS = 60_000;

/** 最小可用观察器分块：足以容纳标签、省略标记和源上下文。 */
export const OBSERVER_CHUNK_MIN_TOKENS = 256;

/**
 * 推导观察器分块上限时使用的记忆模型上下文窗口比例。分块大小按约 4 字符/token 估算，
 * 在非 ASCII 内容上可能低估真实 token 达约 4 倍，因此 0.2 让最坏情况也只占窗口的约 80%，
 * 为系统提示词、既有记忆和响应留出余量。
 */
export const OBSERVER_CHUNK_CONTEXT_RATIO = 0.2;

/**
 * 解析观察器单次序列化到分块中的最大估算 token 数。
 *
 * 显式配置的 `observerChunkMaxTokens` 始终优先。否则上限为已解析记忆模型的
 * `floor(contextWindow * OBSERVER_CHUNK_CONTEXT_RATIO)`，上下文窗口不可用时回退到
 * {@link OBSERVER_CHUNK_FALLBACK_MAX_TOKENS}。
 *
 * 没有上限时，超出模型上下文窗口的积压（例如观察器反复失败之后，或在长会话中途启用
 * 本扩展时）会让每次观察器调用都失败，覆盖范围无法推进，会话也永远无法恢复。有了上限，
 * 过大的积压会在连续运行中从最旧开始逐步排空。
 */
export function resolveObserverChunkMaxTokens(config: Config, contextWindow: number | undefined): number {
	if (config.observerChunkMaxTokens !== undefined && config.observerChunkMaxTokens > 0) {
		return Math.max(OBSERVER_CHUNK_MIN_TOKENS, config.observerChunkMaxTokens);
	}
	if (typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0) {
		return Math.max(
			OBSERVER_CHUNK_MIN_TOKENS,
			Math.floor(contextWindow * OBSERVER_CHUNK_CONTEXT_RATIO),
		);
	}
	return OBSERVER_CHUNK_FALLBACK_MAX_TOKENS;
}

const SETTINGS_KEY = "observational-memory";
const PASSIVE_ENV = "PI_OBSERVATIONAL_MEMORY_PASSIVE";

function positiveIntegerOrUndefined(value: unknown): number | undefined {
	return Number.isInteger(value) && typeof value === "number" && value > 0 ? value : undefined;
}

function validTargetOrUndefined(value: unknown, maxTokens: number): number | undefined {
	const target = positiveIntegerOrUndefined(value);
	return target !== undefined && target < maxTokens ? target : undefined;
}

function derivedObservationPoolTarget(maxTokens: number): number {
	return Math.floor(maxTokens / 2);
}

function isThinkingLevel(value: unknown): value is ModelThinkingLevel {
	return typeof value === "string" && (THINKING_LEVEL_VALUES as readonly string[]).includes(value);
}

function isCompactAfterTokensMode(value: unknown): value is CompactAfterTokensMode {
	return typeof value === "string" && (COMPACT_AFTER_TOKENS_MODE_VALUES as readonly string[]).includes(value);
}

/**
 * 有效 ratio 是严格介于 0 和 1 之间的有限数字。
 * 0 永远不会触发；>= 1 会在占满整个窗口时才压缩，没有给响应留任何余量。
 */
function validRatioOrUndefined(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 && value < 1 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeModel(value: unknown): ConfiguredModel | undefined {
	if (!isRecord(value)) return undefined;
	const provider = nonEmptyString(value.provider);
	const id = nonEmptyString(value.id);
	if (!provider || !id) return undefined;
	const model: ConfiguredModel = { provider, id };
	if (isThinkingLevel(value.thinking)) model.thinking = value.thinking;
	return model;
}

function normalizeSettingsConfig(value: Record<string, unknown>): Partial<Config> {
	const normalized: Partial<Config> = {};
	const numberKeys = [
		"observeAfterTokens",
		"reflectAfterTokens",
		"observerChunkMaxTokens",
		"compactAfterTokens",
		"observationsPoolMaxTokens",
		"observationsPoolTargetTokens",
		"agentMaxTurns",
	] as const;
	for (const key of numberKeys) {
		const normalizedValue = positiveIntegerOrUndefined(value[key]);
		if (normalizedValue !== undefined) normalized[key] = normalizedValue;
	}
	if (isCompactAfterTokensMode(value.compactAfterTokensMode)) {
		normalized.compactAfterTokensMode = value.compactAfterTokensMode;
	}
	const ratio = validRatioOrUndefined(value.compactAfterTokensRatio);
	if (ratio !== undefined) normalized.compactAfterTokensRatio = ratio;
	if (typeof value.showWorkerNotifications === "boolean") normalized.showWorkerNotifications = value.showWorkerNotifications;
	if (typeof value.passive === "boolean") normalized.passive = value.passive;
	if (typeof value.debugLog === "boolean") normalized.debugLog = value.debugLog;
	const model = normalizeModel(value.model);
	if (model) normalized.model = model;
	return normalized;
}

export function readEnvConfig(env: NodeJS.ProcessEnv = process.env): Partial<Config> {
	const rawPassive = env[PASSIVE_ENV];
	if (rawPassive === undefined) return {};
	const passive = rawPassive.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(passive)) return { passive: true };
	if (["0", "false", "no", "off"].includes(passive)) return { passive: false };
	return {};
}

function readNamespacedConfig(path: string): Partial<Config> {
	if (!existsSync(path)) return {};
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
		const nested = raw[SETTINGS_KEY];
		return isRecord(nested) ? normalizeSettingsConfig(nested) : {};
	} catch {
		return {};
	}
}

export function loadConfig(cwd: string, env: NodeJS.ProcessEnv = process.env): Config {
	const globalPath = join(getAgentDir(), "settings.json");
	const projectPath = join(cwd, ".pi", "settings.json");
	const globalConfig = readNamespacedConfig(globalPath);
	const projectConfig = readNamespacedConfig(projectPath);
	const envConfig = readEnvConfig(env);
	const merged = {
		...DEFAULTS,
		observationsPoolTargetTokens: undefined,
		...globalConfig,
		...projectConfig,
		...envConfig,
	};
	const target = validTargetOrUndefined(
		merged.observationsPoolTargetTokens,
		merged.observationsPoolMaxTokens,
	) ?? derivedObservationPoolTarget(merged.observationsPoolMaxTokens);

	return {
		...merged,
		observationsPoolTargetTokens: target,
	};
}
