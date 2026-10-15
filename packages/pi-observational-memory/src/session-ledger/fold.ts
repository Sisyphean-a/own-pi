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
	type ObservationDrop,
	type ReflectionRetirement,
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
	/** 当前仍有效的反思；被撤回的记录只留在历史索引中。 */
	reflections: Reflection[];
	retiredReflectionIds: Set<string>;
	reflectionRetirements: Map<string, ReflectionRetirement>;
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
	const retiredReflectionIds = new Set<string>();
	const reflectionRetirements = new Map<string, ReflectionRetirement>();
	const dropEvidence = new Map<string, ObservationDrop>();
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
			// 同一条目中先撤回旧结论，再登记新结论；历史内容和证据均不改写。
			for (const retirement of entry.data.retirements ?? []) {
				if (reflectionsById.has(retirement.reflectionId) && !retiredReflectionIds.has(retirement.reflectionId)
					&& retirement.supportingObservationIds.every((id) => observationsById.has(id))) {
					retiredReflectionIds.add(retirement.reflectionId);
					reflectionRetirements.set(retirement.reflectionId, retirement);
				}
			}
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
			for (const evidence of entry.data.evidence ?? []) dropEvidence.set(evidence.observationId, evidence);
		}
	}

	const observations = Array.from(observationsById.values());
	const reflections = Array.from(reflectionsById.values()).filter((reflection) => !retiredReflectionIds.has(reflection.id));
	const activeReflectionIds = new Set(reflections.map((reflection) => reflection.id));
	for (const [id, evidence] of dropEvidence) {
		const observation = observationsById.get(id);
		const retained = evidence.replacementIds.length > 0 && evidence.replacementIds.every((replacement) => activeReflectionIds.has(replacement)
			|| (observationsById.has(replacement) && !droppedObservationIds.has(replacement) && replacement !== id));
		if (!observation || (evidence.reason === "routine" ? observation.relevance !== "low" : !retained)) droppedObservationIds.delete(id);
	}
	const activeObservations = observations.filter((observation) => !droppedObservationIds.has(observation.id));

	return {
		observations,
		activeObservations,
		droppedObservationIds,
		reflections,
		retiredReflectionIds,
		reflectionRetirements,
		observationsById,
		reflectionsById,
	};
}
