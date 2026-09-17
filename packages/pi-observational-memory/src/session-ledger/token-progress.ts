import { estimateEntryTokens } from "../tokens.js";
import { findLastCompactionIndex, isSourceEntry } from "./progress.js";
import {
	OM_OBSERVATIONS_RECORDED,
	OM_REFLECTIONS_RECORDED,
	isObservationsRecordedEntry,
	isReflectionsRecordedEntry,
	type Entry,
} from "./types.js";

/**
 * 单个覆盖时钟的增量状态。
 *
 * Rule: 会话日志只会在末尾追加，已累计的源 token 因此永不失效；只有覆盖标记推进时才需要
 * 从新标记重新累计。这样每次 `turn_end` 的代价只与新增条目相关，而不是整个账本长度。
 */
type ClockState = {
	/** 最近一次成功计算的覆盖标记 id；undefined 表示尚无覆盖（从账本起点累计）。 */
	markerId: string | undefined;
	/** 标记对应的条目在账本中的下标。 */
	coveredIndex: number;
	/** 覆盖点之后所有源条目的估算 token 之和。 */
	tokensAfterCoverage: number;
	/** 已累计到哪个下标（不含）。 */
	scannedTo: number;
	/** 该标记处（含之前）最近一条有效助手 usage 上报的上下文 token。 */
	baselineTokens: number | undefined;
};

type JournalState = {
	entries: Entry[];
	indexById: Map<string, number>;
	compactionIndex: number;
	observations: ClockState;
	reflections: ClockState;
};

/** `stageDue` 需要的两个数字：真实 token 增量与原始估算增量。 */
export type StageProgress = {
	realTokens: number | undefined;
	rawTokens: number;
};

function emptyClock(): ClockState {
	return {
		markerId: undefined,
		coveredIndex: -1,
		tokensAfterCoverage: 0,
		scannedTo: 0,
		baselineTokens: undefined,
	};
}

function validAssistantContextTokens(entry: Entry): number | undefined {
	if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") return undefined;
	const message = entry.message as { role?: string; stopReason?: string; usage?: unknown };
	if (message.role !== "assistant" || message.stopReason === "aborted" || message.stopReason === "error") {
		return undefined;
	}
	const usage = message.usage as { totalTokens?: unknown; input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown } | undefined;
	if (!usage || typeof usage !== "object") return undefined;
	const total = usage.totalTokens;
	if (typeof total === "number" && Number.isFinite(total) && total > 0) return total;
	const parts = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite];
	if (parts.every((part) => typeof part === "number" && Number.isFinite(part))) {
		const sum = (parts as number[]).reduce((acc, part) => acc + part, 0);
		return sum > 0 ? sum : undefined;
	}
	return undefined;
}

export class JournalTokenProgress {
	private journal: JournalState | undefined;

	/** 观察覆盖之后的进度。 */
	observationProgress(entries: Entry[], currentTokens: number | undefined): StageProgress {
		return this.stageProgress(entries, "observations", currentTokens);
	}

	/** 反思覆盖之后的进度。 */
	reflectionProgress(entries: Entry[], currentTokens: number | undefined): StageProgress {
		return this.stageProgress(entries, "reflections", currentTokens);
	}

	private stageProgress(
		entries: Entry[],
		kind: "observations" | "reflections",
		currentTokens: number | undefined,
	): StageProgress {
		const journal = this.syncJournal(entries);
		const clock = kind === "observations" ? journal.observations : journal.reflections;
		const coverageIndex = this.syncClock(journal, clock, kind);
		const compactionIndex = journal.compactionIndex;

		if (compactionIndex > coverageIndex) {
			const baseline = this.tokensAfterCompaction(journal, compactionIndex);
			const real = baseline === undefined || currentTokens === undefined || currentTokens < baseline
				? undefined
				: currentTokens - baseline;
			return { realTokens: real, rawTokens: clock.tokensAfterCoverage };
		}
		if (coverageIndex >= 0) {
			const real = clock.baselineTokens === undefined || currentTokens === undefined || currentTokens < clock.baselineTokens
				? undefined
				: currentTokens - clock.baselineTokens;
			return { realTokens: real, rawTokens: clock.tokensAfterCoverage };
		}
		// 尚无覆盖：真实增量就是从零开始，原始增量覆盖整个账本。
		return {
			realTokens: currentTokens === undefined ? undefined : Math.max(0, currentTokens),
			rawTokens: clock.tokensAfterCoverage,
		};
	}

	/** Guarantee: 只在账本对象被替换、覆盖标记推进或标记位置变化时整体重建。 */
	private syncJournal(entries: Entry[]): JournalState {
		const existing = this.journal;
		if (existing && existing.entries === entries) return existing;

		const indexById = new Map<string, number>();
		for (let i = 0; i < entries.length; i++) indexById.set(entries[i].id, i);

		const fresh: JournalState = {
			entries,
			indexById,
			compactionIndex: findLastCompactionIndex(entries),
			observations: emptyClock(),
			reflections: emptyClock(),
		};
		// 账本被替换（reload、分支切换、压缩重写）时无法安全复用旧的累计值，全部重算。
		this.journal = fresh;
		return fresh;
	}

	/** 推进或重建一个覆盖时钟，返回当前覆盖下标。 */
	private syncClock(journal: JournalState, clock: ClockState, kind: "observations" | "reflections"): number {
		const entries = journal.entries;
		const marker = this.latestCoverageMarker(journal, kind);
		const coveredIndex = marker ? journal.indexById.get(marker.coversUpToId) ?? -1 : -1;
		const markerId = marker?.id;
		const stale = clock.markerId !== markerId || clock.coveredIndex !== coveredIndex;

		if (stale) {
			clock.markerId = markerId;
			clock.coveredIndex = coveredIndex;
			clock.tokensAfterCoverage = 0;
			clock.scannedTo = coveredIndex + 1;
			clock.baselineTokens = coveredIndex >= 0
				? this.baselineAtCoverage(entries, coveredIndex)
				: undefined;
		}

		for (let i = clock.scannedTo; i < entries.length; i++) {
			if (isSourceEntry(entries[i])) clock.tokensAfterCoverage += estimateEntryTokens(entries[i]);
		}
		clock.scannedTo = Math.max(clock.scannedTo, entries.length);
		return coveredIndex;
	}

	/**
	 * 取最新生效的覆盖标记：`coversUpToId` 必须能在账本中定位，且指向最靠后的位置。
	 * 覆盖标记位于账本末尾附近，从后向前扫描可在命中后立刻停止。
	 */
	private latestCoverageMarker(
		journal: JournalState,
		kind: "observations" | "reflections",
	): { id: string; coversUpToId: string } | undefined {
		const entries = journal.entries;
		let latestIndex = -1;
		let marker: { id: string; coversUpToId: string } | undefined;
		const consider = (entry: Entry, coversUpToId: string): void => {
			const coveredIndex = journal.indexById.get(coversUpToId);
			if (coveredIndex === undefined || coveredIndex < 0 || coveredIndex <= latestIndex) return;
			latestIndex = coveredIndex;
			marker = { id: entry.id, coversUpToId };
		};
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (kind === "observations") {
				if (isObservationsRecordedEntry(entry)) consider(entry, entry.data.coversUpToId);
			} else if (isReflectionsRecordedEntry(entry)) {
				consider(entry, entry.data.coversUpToId);
			}
		}
		return marker;
	}

	private baselineAtCoverage(entries: Entry[], coverageIndex: number): number | undefined {
		for (let i = coverageIndex; i >= 0; i--) {
			const tokens = validAssistantContextTokens(entries[i]);
			if (tokens !== undefined) return tokens;
		}
		return undefined;
	}

	private tokensAfterCompaction(journal: JournalState, compactionIndex: number): number | undefined {
		for (let i = compactionIndex + 1; i < journal.entries.length; i++) {
			const tokens = validAssistantContextTokens(journal.entries[i]);
			if (tokens !== undefined) return tokens;
		}
		return undefined;
	}
}
