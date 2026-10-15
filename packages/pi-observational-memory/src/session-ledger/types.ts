export const OM_OBSERVATIONS_RECORDED = "om.observations.recorded";
export const OM_REFLECTIONS_RECORDED = "om.reflections.recorded";
export const OM_OBSERVATIONS_DROPPED = "om.observations.dropped";
export const OM_FOLDED = "om.folded";

export const RELEVANCE_VALUES = ["low", "medium", "high", "critical"] as const;
export type Relevance = (typeof RELEVANCE_VALUES)[number];

export const MEMORY_ID_PATTERN = /^[a-f0-9]{12}$/;

export type Entry = {
	type: string;
	id: string;
	timestamp?: string;
	message?: unknown;
	content?: unknown;
	customType?: string;
	summary?: unknown;
	fromId?: string;
	data?: unknown;
	details?: unknown;
	firstKeptEntryId?: string;
};

export type Observation = {
	id: string;
	content: string;
	timestamp: string;
	relevance: Relevance;
	sourceEntryIds: string[];
	tokenCount: number;
};

export type Reflection = {
	id: string;
	content: string;
	supportingObservationIds: string[];
	tokenCount: number;
};

export type ObservationProcessing = {
	/** 只有收到显式完成回执才写入；允许已处理但没有值得保存的观察。 */
	processedSourceEntryIds: string[];
	startSourceOffset?: number;
	/** 最后一个源条目尚未读完时，下次从该字符位置继续。 */
	nextSourceOffset?: number;
};

export type ObservationsRecordedEntryData = {
	observations: Observation[];
	coversUpToId: string;
	processing?: ObservationProcessing;
};

export type ReflectionRetirement = {
	reflectionId: string;
	supportingObservationIds: string[];
	reason: string;
};

export type ReflectionsRecordedEntryData = {
	reflections: Reflection[];
	coversUpToId: string;
	retirements?: ReflectionRetirement[];
	reviewedObservationIds?: string[];
};

export type ObservationDrop = {
	observationId: string;
	replacementIds: string[];
	reason: "redundant" | "superseded" | "resolved" | "routine";
};

export type ObservationsDroppedEntryData = {
	observationIds: string[];
	coversUpToId: string;
	evidence?: ObservationDrop[];
};

export type MemoryDetails = {
	type: typeof OM_FOLDED;
	version: 1;
	fullFold: boolean;
	observations: Observation[];
	reflections: Reflection[];
};

export type V3MemoryCustomType =
	| typeof OM_OBSERVATIONS_RECORDED
	| typeof OM_REFLECTIONS_RECORDED
	| typeof OM_OBSERVATIONS_DROPPED;

export function isRelevance(value: unknown): value is Relevance {
	return typeof value === "string" && (RELEVANCE_VALUES as readonly string[]).includes(value);
}

export function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

export function isNonEmptyStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

export function isMemoryId(value: unknown): value is string {
	return typeof value === "string" && MEMORY_ID_PATTERN.test(value);
}

function isTokenCount(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object";
}

export function isObservation(value: unknown): value is Observation {
	if (!isPlainRecord(value)) return false;
	return (
		isMemoryId(value.id) &&
		isNonEmptyString(value.content) &&
		isNonEmptyString(value.timestamp) &&
		isRelevance(value.relevance) &&
		isNonEmptyStringArray(value.sourceEntryIds) &&
		isTokenCount(value.tokenCount)
	);
}

export function isReflection(value: unknown): value is Reflection {
	if (!isPlainRecord(value)) return false;
	return (
		isMemoryId(value.id) &&
		isNonEmptyString(value.content) &&
		!/\r|\n/.test(value.content) &&
		isNonEmptyStringArray(value.supportingObservationIds) &&
		isTokenCount(value.tokenCount)
	);
}

export function isObservationProcessing(value: unknown): value is ObservationProcessing {
	return isPlainRecord(value) && isNonEmptyStringArray(value.processedSourceEntryIds)
		&& (value.startSourceOffset === undefined || (Number.isSafeInteger(value.startSourceOffset) && (value.startSourceOffset as number) >= 0))
		&& (value.nextSourceOffset === undefined || (Number.isSafeInteger(value.nextSourceOffset) && (value.nextSourceOffset as number) > 0));
}

export function isReflectionRetirement(value: unknown): value is ReflectionRetirement {
	return isPlainRecord(value) && isMemoryId(value.reflectionId)
		&& isNonEmptyStringArray(value.supportingObservationIds) && isNonEmptyString(value.reason);
}

export function isObservationsRecordedData(value: unknown): value is ObservationsRecordedEntryData {
	if (!isPlainRecord(value)) return false;
	return Array.isArray(value.observations) && value.observations.every(isObservation)
		&& isNonEmptyString(value.coversUpToId)
		&& (value.processing === undefined ? value.observations.length > 0
			: isObservationProcessing(value.processing) && value.processing.processedSourceEntryIds.at(-1) === value.coversUpToId);
}

export function isReflectionsRecordedData(value: unknown): value is ReflectionsRecordedEntryData {
	if (!isPlainRecord(value)) return false;
	return Array.isArray(value.reflections) && value.reflections.every(isReflection)
		&& isNonEmptyString(value.coversUpToId)
		&& (value.retirements === undefined || (Array.isArray(value.retirements) && value.retirements.every(isReflectionRetirement)))
		&& (value.reviewedObservationIds === undefined || isNonEmptyStringArray(value.reviewedObservationIds))
		&& (value.reflections.length > 0 || (Array.isArray(value.retirements) && value.retirements.length > 0) || isNonEmptyStringArray(value.reviewedObservationIds));
}

export function isObservationDrop(value: unknown): value is ObservationDrop {
	return isPlainRecord(value) && isMemoryId(value.observationId)
		&& ["redundant", "superseded", "resolved", "routine"].includes(value.reason as string)
		&& Array.isArray(value.replacementIds) && value.replacementIds.every(isMemoryId)
		&& (value.reason === "routine" || value.replacementIds.length > 0);
}

export function isObservationsDroppedData(value: unknown): value is ObservationsDroppedEntryData {
	if (!isPlainRecord(value) || !isNonEmptyStringArray(value.observationIds) || !isNonEmptyString(value.coversUpToId)) return false;
	if (value.evidence === undefined) return true;
	if (!Array.isArray(value.evidence) || value.evidence.length !== value.observationIds.length || !value.evidence.every(isObservationDrop)) return false;
	const observationIds = new Set(value.observationIds);
	const evidenceIds = new Set(value.evidence.map((item) => item.observationId));
	return observationIds.size === value.observationIds.length && evidenceIds.size === observationIds.size
		&& [...evidenceIds].every((id) => observationIds.has(id));
}

export function isMemoryDetails(value: unknown): value is MemoryDetails {
	if (!isPlainRecord(value)) return false;
	return (
		value.type === OM_FOLDED &&
		value.version === 1 &&
		typeof value.fullFold === "boolean" &&
		Array.isArray(value.observations) &&
		value.observations.every(isObservation) &&
		Array.isArray(value.reflections) &&
		value.reflections.every(isReflection)
	);
}

export function isObservationsRecordedEntry(entry: Entry): entry is Entry & {
	type: "custom";
	customType: typeof OM_OBSERVATIONS_RECORDED;
	data: ObservationsRecordedEntryData;
} {
	return entry.type === "custom" && entry.customType === OM_OBSERVATIONS_RECORDED && isObservationsRecordedData(entry.data);
}

export function isReflectionsRecordedEntry(entry: Entry): entry is Entry & {
	type: "custom";
	customType: typeof OM_REFLECTIONS_RECORDED;
	data: ReflectionsRecordedEntryData;
} {
	return entry.type === "custom" && entry.customType === OM_REFLECTIONS_RECORDED && isReflectionsRecordedData(entry.data);
}

export function isObservationsDroppedEntry(entry: Entry): entry is Entry & {
	type: "custom";
	customType: typeof OM_OBSERVATIONS_DROPPED;
	data: ObservationsDroppedEntryData;
} {
	return entry.type === "custom" && entry.customType === OM_OBSERVATIONS_DROPPED && isObservationsDroppedData(entry.data);
}

export function buildObservationsRecordedData(
	observations: Observation[], coversUpToId: string, processing?: ObservationProcessing,
): ObservationsRecordedEntryData | undefined {
	const data = { observations, coversUpToId, ...(processing ? { processing } : {}) };
	return isObservationsRecordedData(data) ? data : undefined;
}

export function buildReflectionsRecordedData(
	reflections: Reflection[], coversUpToId: string, retirements: ReflectionRetirement[] = [], reviewedObservationIds?: string[],
): ReflectionsRecordedEntryData | undefined {
	const data = { reflections, coversUpToId, ...(retirements.length > 0 ? { retirements } : {}), ...(reviewedObservationIds ? { reviewedObservationIds } : {}) };
	return isReflectionsRecordedData(data) ? data : undefined;
}

export function buildObservationsDroppedData(
	observationIds: string[], coversUpToId: string, evidence?: ObservationDrop[],
): ObservationsDroppedEntryData | undefined {
	if (observationIds.length === 0 || !isNonEmptyString(coversUpToId)) return undefined;
	const data = { observationIds, coversUpToId, ...(evidence ? { evidence } : {}) };
	return isObservationsDroppedData(data) ? data : undefined;
}
