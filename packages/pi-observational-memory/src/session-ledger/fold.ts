import {
	isObservationsDroppedData,
	isObservationsRecordedData,
	isReflectionsRecordedData,
	OM_OBSERVATIONS_DROPPED,
	OM_OBSERVATIONS_RECORDED,
	OM_REFLECTIONS_RECORDED,
	type Entry,
	type Observation,
	type Reflection,
} from "./types.js";

export type FoldLedgerOptions = {
	/** 从分支根折叠到该条目 id（含）。省略则折叠到分支末端。 */
	upToEntryId?: string;
};

export type FoldedLedger = {
	/** 折叠边界内遇到的全部首次有效观察记录，包含已精简的观察。 */
	observations: Observation[];
	/** 未被折叠的 drop 条目做成墓志铭的观察记录。 */
	activeObservations: Observation[];
	/** 已做成墓志铭的观察 id，包含折叠时尚无对应观察的 id。 */
	droppedObservationIds: Set<string>;
	/** 折叠边界内遇到的全部首次有效反思记录。 */
	reflections: Reflection[];
	/** 按 id 索引的全部首次有效观察记录，包含已精简的观察。 */
	observationsById: Map<string, Observation>;
	/** 按 id 索引的全部首次有效反思记录。 */
	reflectionsById: Map<string, Reflection>;
};

function foldEndIndex(entries: Entry[], upToEntryId: string | undefined): number {
	if (!upToEntryId) return entries.length - 1;
	const idx = entries.findIndex((entry) => entry.id === upToEntryId);
	return idx === -1 ? entries.length - 1 : idx;
}

function isCustomEntry(entry: Entry, customType: string): boolean {
	return entry.type === "custom" && entry.customType === customType;
}

/**
 * 从分支根到目标条目折叠有效的 V3 记忆 ledger 条目。
 *
 * 未知自定义条目、旧 V2 条目、形状非法的 V3 数据和压缩详情均被忽略。
 * 观察与反思采用“首次有效记录优先”的语义。drop 是墓志铭，即使被精简的 id 在折叠时未知也保留。
 */
export function foldLedger(entries: Entry[], options: FoldLedgerOptions = {}): FoldedLedger {
	const observationsById = new Map<string, Observation>();
	const reflectionsById = new Map<string, Reflection>();
	const droppedObservationIds = new Set<string>();
	const endIdx = foldEndIndex(entries, options.upToEntryId);

	for (let i = 0; i <= endIdx; i++) {
		const entry = entries[i];
		if (!entry) continue;

		if (isCustomEntry(entry, OM_OBSERVATIONS_RECORDED)) {
			if (!isObservationsRecordedData(entry.data)) continue;
			for (const observation of entry.data.observations) {
				if (!observationsById.has(observation.id)) {
					observationsById.set(observation.id, observation);
				}
			}
			continue;
		}

		if (isCustomEntry(entry, OM_REFLECTIONS_RECORDED)) {
			if (!isReflectionsRecordedData(entry.data)) continue;
			for (const reflection of entry.data.reflections) {
				if (!reflectionsById.has(reflection.id)) {
					reflectionsById.set(reflection.id, reflection);
				}
			}
			continue;
		}

		if (isCustomEntry(entry, OM_OBSERVATIONS_DROPPED)) {
			if (!isObservationsDroppedData(entry.data)) continue;
			for (const observationId of entry.data.observationIds) {
				droppedObservationIds.add(observationId);
			}
		}
	}

	const observations = Array.from(observationsById.values());
	const activeObservations = observations.filter((observation) => !droppedObservationIds.has(observation.id));
	const reflections = Array.from(reflectionsById.values());

	return {
		observations,
		activeObservations,
		droppedObservationIds,
		reflections,
		observationsById,
		reflectionsById,
	};
}
