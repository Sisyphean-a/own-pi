import { estimateEntryTokens } from "../tokens.js";
import {
	OM_OBSERVATIONS_DROPPED,
	OM_OBSERVATIONS_RECORDED,
	OM_REFLECTIONS_RECORDED,
	type Entry,
	type V3MemoryCustomType,
} from "./types.js";

const SOURCE_ENTRY_TYPES = new Set(["message", "custom_message", "branch_summary"]);

export function isSourceEntry(entry: Entry): boolean {
	return SOURCE_ENTRY_TYPES.has(entry.type);
}

export function entryIndexById(entries: Entry[]): Map<string, number> {
	const idToIndex = new Map<string, number>();
	for (let i = 0; i < entries.length; i++) idToIndex.set(entries[i].id, i);
	return idToIndex;
}

export function entryIndexForId(entries: Entry[], entryId: string | undefined): number {
	if (!entryId) return -1;
	const idx = entryIndexById(entries).get(entryId);
	return idx ?? -1;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isNonEmptyArray(value: unknown): value is unknown[] {
	return Array.isArray(value) && value.length > 0;
}

function isValidCoverageEntry(entry: Entry, customType: V3MemoryCustomType): entry is Entry & { data: { coversUpToId: string } } {
	if (entry.type !== "custom" || entry.customType !== customType) return false;
	if (!isObject(entry.data) || typeof entry.data.coversUpToId !== "string") return false;

	if (customType === OM_OBSERVATIONS_RECORDED) return isNonEmptyArray(entry.data.observations);
	if (customType === OM_REFLECTIONS_RECORDED) return isNonEmptyArray(entry.data.reflections);
	return isNonEmptyArray(entry.data.observationIds);
}

export function latestCoverageIndex(entries: Entry[], customType: V3MemoryCustomType): number {
	const idToIndex = entryIndexById(entries);
	let latest = -1;

	for (const entry of entries) {
		if (!isValidCoverageEntry(entry, customType)) continue;
		const coveredIndex = idToIndex.get(entry.data.coversUpToId);
		if (coveredIndex === undefined) continue;
		if (coveredIndex > latest) latest = coveredIndex;
	}

	return latest;
}

export function latestCoverageMarkerId(entries: Entry[], customType: V3MemoryCustomType): string | undefined {
	const idToIndex = entryIndexById(entries);
	let latestIndex = -1;
	let latestMarkerId: string | undefined;

	for (const entry of entries) {
		if (!isValidCoverageEntry(entry, customType)) continue;
		const coveredIndex = idToIndex.get(entry.data.coversUpToId);
		if (coveredIndex === undefined) continue;
		if (coveredIndex > latestIndex) {
			latestIndex = coveredIndex;
			latestMarkerId = entry.data.coversUpToId;
		}
	}

	return latestMarkerId;
}

export function earlierCoverageMarkerId(entries: Entry[], firstId: string | undefined, secondId: string | undefined): string | undefined {
	if (!firstId) return secondId;
	if (!secondId) return firstId;

	const idToIndex = entryIndexById(entries);
	const firstIndex = idToIndex.get(firstId);
	const secondIndex = idToIndex.get(secondId);
	if (firstIndex === undefined) return secondIndex === undefined ? undefined : secondId;
	if (secondIndex === undefined) return firstId;
	return firstIndex <= secondIndex ? firstId : secondId;
}

export function rawTokensAfterIndex(entries: Entry[], index: number): number {
	let total = 0;
	for (let i = Math.max(0, index + 1); i < entries.length; i++) {
		if (isSourceEntry(entries[i])) total += estimateEntryTokens(entries[i]);
	}
	return total;
}

export function rawTokensSinceCoverage(entries: Entry[], customType: V3MemoryCustomType): number {
	return rawTokensAfterIndex(entries, latestCoverageIndex(entries, customType));
}

export function rawTokensSinceObservationCoverage(entries: Entry[]): number {
	return rawTokensSinceCoverage(entries, OM_OBSERVATIONS_RECORDED);
}

export function rawTokensSinceReflectionCoverage(entries: Entry[]): number {
	return rawTokensSinceCoverage(entries, OM_REFLECTIONS_RECORDED);
}

export function rawTokensSinceDropCoverage(entries: Entry[]): number {
	return rawTokensSinceCoverage(entries, OM_OBSERVATIONS_DROPPED);
}

export function findLastCompactionIndex(entries: Entry[]): number {
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].type === "compaction") return i;
	}
	return -1;
}

// ==== 真实（provider 上报）token 计量 ====
//
// 这些辅助函数用 provider 上报的 usage 度量上下文增长，供观察与反思的覆盖时钟使用。
// 自动压缩保留独立的原始源条目时钟，因为它的设置统计的是 ledger 条目。

type UsageLike = {
	totalTokens?: number;
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
};

export function contextTokensFromUsage(usage: unknown): number | undefined {
	if (!usage || typeof usage !== "object") return undefined;
	const u = usage as UsageLike;
	const total = typeof u.totalTokens === "number" && Number.isFinite(u.totalTokens) && u.totalTokens > 0 ? u.totalTokens : undefined;
	if (total !== undefined) return total;
	const parts = [u.input, u.output, u.cacheRead, u.cacheWrite];
	if (parts.every((p) => typeof p === "number" && Number.isFinite(p))) {
		const sum = parts.reduce<number>((acc, p) => acc + (p ?? 0), 0);
		return sum > 0 ? sum : undefined;
	}
	return undefined;
}

function validAssistantContextTokens(entry: Entry): number | undefined {
	if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") return undefined;
	const msg = entry.message as { role?: string; stopReason?: string; usage?: unknown };
	if (msg.role !== "assistant" || msg.stopReason === "aborted" || msg.stopReason === "error") return undefined;
	return contextTokensFromUsage(msg.usage);
}

/**
 * 压缩锚点之后立即的真实上下文 token。
 *
 * 只有压缩之后响应的助手 usage 才是有效的压缩后基线：pi 自己的文档指出，压缩前/压缩时的
 * 最后一条助手 usage 反映的是压缩*前*的上下文大小。压缩条目自身携带的 usage 是摘要生成
 * 调用的 usage（压缩前的量级，且是另一次 LLM 调用），因此刻意不用作基线。
 */
export function realContextTokensAfterCompaction(entries: Entry[], compactionIdx: number): number | undefined {
	for (let i = compactionIdx + 1; i < entries.length; i++) {
		const t = validAssistantContextTokens(entries[i]);
		if (t !== undefined) return t;
	}
	return undefined;
}

/**
 * 观察覆盖结束时的真实上下文 token：被覆盖条目处或之前的最后一条有效助手 usage。
 * 没有有效 usage 时返回 undefined（例如错误/中止风暴）——调用方必须回退到原始估算，
 * 而不是从零开始计量，否则会把整个上下文读成“增长”并每轮重复触发各阶段。
 */
export function realContextTokensAtCoverage(entries: Entry[], coverageIdx: number): number | undefined {
	for (let i = coverageIdx; i >= 0; i--) {
		const t = validAssistantContextTokens(entries[i]);
		if (t !== undefined) return t;
	}
	return undefined;
}

/**
 * 自最近锚点（一次压缩，或给定的覆盖标记）以来的真实上下文增长，按 provider 上报的
 * usage 计量。
 *
 * 基线无法可靠度量时返回 undefined——锚点处或之后没有 usage，或当前上下文比基线更小
 * （计量基准变了，例如会话中途切换模型/provider 导致 usage 统计方式不同）。此时调用方
 * 必须回退到原始估算；把过期基线截断为 0 会让该阶段永远得不到触发，而从零计量会让它
 * 过度触发。
 */
export function realTokensSinceAnchor(
	entries: Entry[],
	customType: V3MemoryCustomType | undefined,
	currentContextTokens: number,
): number | undefined {
	const coverageIdx = customType ? latestCoverageIndex(entries, customType) : -1;
	const compactionIdx = findLastCompactionIndex(entries);
	if (compactionIdx > coverageIdx) {
		const baseline = realContextTokensAfterCompaction(entries, compactionIdx);
		if (baseline === undefined) return undefined;
		const delta = currentContextTokens - baseline;
		return delta >= 0 ? delta : undefined;
	}
	if (coverageIdx >= 0) {
		const baseline = realContextTokensAtCoverage(entries, coverageIdx);
		if (baseline === undefined) return undefined;
		const delta = currentContextTokens - baseline;
		return delta >= 0 ? delta : undefined;
	}
	return Math.max(0, currentContextTokens);
}

export function rawTokensSinceLastCompaction(entries: Entry[]): number {
	const compactionIndex = findLastCompactionIndex(entries);
	if (compactionIndex === -1) return rawTokensAfterIndex(entries, -1);

	const firstKeptEntryId = entries[compactionIndex].firstKeptEntryId;
	const firstKeptIndex = entryIndexForId(entries, firstKeptEntryId);

	if (firstKeptIndex === -1) return rawTokensAfterIndex(entries, compactionIndex);
	return rawTokensAfterIndex(entries, firstKeptIndex - 1);
}
