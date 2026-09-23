import { estimateEntryTokens } from "../tokens.js";
import { isSourceEntry } from "./progress.js";
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

type CoverageKind = "observations" | "reflections";
type CoverageMarker = { id: string; coversUpToId: string; entryIndex: number; coveredIndex: number };
type PendingMarker = { kind: CoverageKind; id: string; entryIndex: number };
type CompactionClock = { compactionIndex: number; start: number; scannedTo: number; tokens: number };

type JournalState = {
	entries: Entry[];
	length: number;
	first: Entry | undefined;
	last: Entry | undefined;
	indexById: Map<string, number>;
	pendingMarkers: Map<string, PendingMarker[]>;
	compactionIndex: number;
	postCompactionBaseline: number | undefined;
	markers: { observations?: CoverageMarker; reflections?: CoverageMarker };
	observations: ClockState;
	reflections: ClockState;
	compaction: CompactionClock;
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

	reset(): void {
		this.journal = undefined;
	}

	/** 自上次压缩保留的第一条源条目起，估算当前分支的原始 token。 */
	compactionProgress(entries: Entry[]): number {
		const journal = this.syncJournal(entries);
		const compactionIndex = journal.compactionIndex;
		const firstKeptEntryId = compactionIndex >= 0 ? entries[compactionIndex].firstKeptEntryId : undefined;
		const firstKeptIndex = firstKeptEntryId ? journal.indexById.get(firstKeptEntryId) : undefined;
		const start = compactionIndex < 0 ? 0 : firstKeptIndex ?? compactionIndex + 1;
		const clock = journal.compaction;
		if (clock.compactionIndex !== compactionIndex || clock.start !== start) {
			clock.compactionIndex = compactionIndex;
			clock.start = start;
			clock.scannedTo = start;
			clock.tokens = 0;
		}
		for (let i = clock.scannedTo; i < entries.length; i++) {
			if (isSourceEntry(entries[i])) clock.tokens += estimateEntryTokens(entries[i]);
		}
		clock.scannedTo = entries.length;
		return clock.tokens;
	}

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
			const baseline = journal.postCompactionBaseline;
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

	/** Pi 的 getBranch 每次返回新数组；用旧分支末端条目判断它是否仍是当前分支的前缀。 */
	private syncJournal(entries: Entry[]): JournalState {
		const existing = this.journal;
		if (existing && entries.length >= existing.length && entries[0] === existing.first
			&& (existing.length === 0 || entries[existing.length - 1] === existing.last)) {
			this.appendEntries(existing, entries, existing.length);
			return existing;
		}

		const fresh: JournalState = {
			entries,
			length: 0,
			first: undefined,
			last: undefined,
			indexById: new Map(),
			pendingMarkers: new Map(),
			compactionIndex: -1,
			postCompactionBaseline: undefined,
			markers: {},
			observations: emptyClock(),
			reflections: emptyClock(),
			compaction: { compactionIndex: -1, start: 0, scannedTo: 0, tokens: 0 },
		};
		this.appendEntries(fresh, entries, 0);
		this.journal = fresh;
		return fresh;
	}

	private appendEntries(journal: JournalState, entries: Entry[], from: number): void {
		journal.entries = entries;
		for (let i = from; i < entries.length; i++) {
			const entry = entries[i];
			journal.indexById.set(entry.id, i);
			const pending = journal.pendingMarkers.get(entry.id);
			if (pending) {
				journal.pendingMarkers.delete(entry.id);
				for (const marker of pending) this.acceptMarker(journal, marker.kind, marker.id, entry.id, marker.entryIndex);
			}
			if (entry.type === "compaction") {
				journal.compactionIndex = i;
				journal.postCompactionBaseline = undefined;
			} else if (journal.compactionIndex >= 0 && journal.postCompactionBaseline === undefined) {
				journal.postCompactionBaseline = validAssistantContextTokens(entry);
			}
			if (isObservationsRecordedEntry(entry)) {
				this.acceptMarker(journal, "observations", entry.id, entry.data.coversUpToId, i);
			} else if (isReflectionsRecordedEntry(entry)) {
				this.acceptMarker(journal, "reflections", entry.id, entry.data.coversUpToId, i);
			}
		}
		journal.length = entries.length;
		journal.first = entries[0];
		journal.last = entries.at(-1);
	}

	private acceptMarker(journal: JournalState, kind: CoverageKind, id: string, coversUpToId: string, entryIndex: number): void {
		const coveredIndex = journal.indexById.get(coversUpToId);
		if (coveredIndex === undefined) {
			const pending = journal.pendingMarkers.get(coversUpToId) ?? [];
			pending.push({ kind, id, entryIndex });
			journal.pendingMarkers.set(coversUpToId, pending);
			return;
		}
		const current = journal.markers[kind];
		if (!current || coveredIndex > current.coveredIndex
			|| (coveredIndex === current.coveredIndex && entryIndex > current.entryIndex)) {
			journal.markers[kind] = { id, coversUpToId, entryIndex, coveredIndex };
		}
	}

	/** 推进或重建一个覆盖时钟，返回当前覆盖下标。 */
	private syncClock(journal: JournalState, clock: ClockState, kind: "observations" | "reflections"): number {
		const entries = journal.entries;
		const marker = journal.markers[kind];
		const coveredIndex = marker?.coveredIndex ?? -1;
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

	private baselineAtCoverage(entries: Entry[], coverageIndex: number): number | undefined {
		for (let i = coverageIndex; i >= 0; i--) {
			const tokens = validAssistantContextTokens(entries[i]);
			if (tokens !== undefined) return tokens;
		}
		return undefined;
	}

}
