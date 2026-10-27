import { isReflectionsRecordedEntry, isObservationsDroppedData, OM_OBSERVATIONS_DROPPED, type Entry } from "./types.js";

export const OM_WORKER_ATTEMPTED = "om.worker.attempted";
export type WorkerStage = "observer" | "reflector" | "dropper";

/** 次数记录先于请求落盘；不是审阅成功或来源覆盖证明。 */
export function workerAttempted(entries: Entry[], stage: WorkerStage, sourceEntryId?: string, sourceOffset = 0): boolean {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (stage !== "observer" && entry.type === "compaction") return false;
		// 旧版本已提交的成功维护也占用本周期机会，不必迁移会话。
		if (stage === "reflector" && isReflectionsRecordedEntry(entry)) return true;
		if (stage === "dropper" && entry.type === "custom" && entry.customType === OM_OBSERVATIONS_DROPPED && isObservationsDroppedData(entry.data)) return true;
		if (entry.type !== "custom" || entry.customType !== OM_WORKER_ATTEMPTED || !entry.data || typeof entry.data !== "object") continue;
		const data = entry.data as Record<string, unknown>;
		if (data.stage !== stage) continue;
		if (stage !== "observer" || (data.sourceEntryId === sourceEntryId && data.sourceOffset === sourceOffset)) return true;
	}
	return false;
}

export function workerCycleId(entries: Entry[]): string | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].type === "compaction") return entries[i].id;
	}
	return undefined;
}
