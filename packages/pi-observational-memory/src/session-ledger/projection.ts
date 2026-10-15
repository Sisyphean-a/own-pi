import { foldLedger } from "./fold.js";
import { OM_FOLDED, isMemoryDetails, type Entry, type MemoryDetails, type Observation, type Reflection } from "./types.js";

export type Projection = { observations: Observation[]; reflections: Reflection[] };
export type ProjectionDiff = {
	observationsOnlyInFull: Observation[];
	reflectionsOnlyInFull: Reflection[];
	retiredOnlyInFull: Reflection[];
	droppedOnlyInFull: Observation[];
};
export type CompactionProjection = Projection & { fullFold: boolean; details: MemoryDetails };

export function fullProjection(entries: Entry[], upToEntryId?: string): Projection {
	if (upToEntryId) {
		const { observations, reflections } = buildCompactionProjection(entries, upToEntryId);
		return { observations, reflections };
	}
	const folded = foldLedger(entries);
	return { observations: folded.activeObservations, reflections: folded.reflections };
}

export function visibleProjection(entries: Entry[], upToEntryId?: string): Projection {
	if (upToEntryId) return buildCompactionProjection(entries, upToEntryId);
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "compaction" && isMemoryDetails(entry.details)) {
			return { observations: [...entry.details.observations], reflections: [...entry.details.reflections] };
		}
	}
	return { observations: [], reflections: [] };
}

export function buildCompactionProjection(entries: Entry[], firstKeptEntryId: string): CompactionProjection {
	const indexes = new Map(entries.map((entry, index) => [entry.id, index]));
	const boundary = indexes.get(firstKeptEntryId) ?? -1;
	const folded = foldLedger(entries);
	// 来源而不是批次水位决定观察是否属于待压缩历史，跨切点的一批观察不会整批丢失。
	const observations = folded.activeObservations.filter((observation) =>
		observation.sourceEntryIds.some((id) => {
			const index = indexes.get(id);
			return index !== undefined && index <= boundary;
		})
	);
	// 维护结果每次都生效，避免旧反思因延迟全量折叠而重新进入上下文。
	const reflections = folded.reflections;
	const details: MemoryDetails = { type: OM_FOLDED, version: 1, fullFold: true, observations, reflections };
	return { fullFold: true, observations, reflections, details };
}

export function diffProjection(visible: Projection, full: Projection): ProjectionDiff {
	const visibleObservationIds = new Set(visible.observations.map((observation) => observation.id));
	const fullObservationIds = new Set(full.observations.map((observation) => observation.id));
	const visibleReflectionIds = new Set(visible.reflections.map((reflection) => reflection.id));
	const fullReflectionIds = new Set(full.reflections.map((reflection) => reflection.id));
	return {
		observationsOnlyInFull: full.observations.filter((observation) => !visibleObservationIds.has(observation.id)),
		reflectionsOnlyInFull: full.reflections.filter((reflection) => !visibleReflectionIds.has(reflection.id)),
		retiredOnlyInFull: visible.reflections.filter((reflection) => !fullReflectionIds.has(reflection.id)),
		droppedOnlyInFull: visible.observations.filter((observation) => !fullObservationIds.has(observation.id)),
	};
}
