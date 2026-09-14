import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	recallMemorySources,
	type Entry,
	type RecallResult,
	type RecalledObservation,
} from "../session-ledger/recall.js";
import type { Observation, Reflection } from "../session-ledger/index.js";
import { renderRecallSourceEntries, renderRecallSourceEntry } from "../serialize.js";
import { estimateEntryTokens } from "../tokens.js";

export const RECALL_OBSERVATION_TOOL_NAME = "recall";

const MEMORY_ID_PATTERN = /^[a-f0-9]{12}$/;

type RecallObservationToolStatus =
	| "ok"
	| "partial"
	| "invalid_id"
	| "not_found"
	| "no_source"
	| "source_unavailable";

/** 召回状态的中文标签，用于 TUI 头部与备注。 */
const RECALL_STATUS_LABELS: Record<RecallObservationToolStatus, string> = {
	ok: "正常",
	partial: "部分可用",
	invalid_id: "id 非法",
	not_found: "未找到",
	no_source: "无源条目",
	source_unavailable: "源条目不可用",
};

type ObservationDetails = Pick<Observation, "id" | "content" | "timestamp" | "relevance"> & { status?: "active" | "dropped" };
type ReflectionDetails = Pick<Reflection, "id" | "content" | "supportingObservationIds"> & { reflectionIndex: number };

export type RecallSourceEntryDetails = {
	id: string;
	origin: string;
	timestamp: string;
	tokens: number;
	qualifiers: string[];
	content?: string;
};

type RecallObservationMatchDetails = {
	status: "active" | "dropped" | "source_unavailable" | "no_source";
	observationEntryId: string;
	observationRecordIndex: number;
	observation: ObservationDetails;
	sourceEntryIds?: string[];
	sourceEntries?: RecallSourceEntryDetails[];
	missingSourceEntryIds?: string[];
	nonSourceEntryIds?: string[];
	sourceCharacterCount?: number;
};

type RecallUnavailableSupportingObservationDetails = {
	observationId: string;
};

export type RecallObservationToolDetails = {
	status: RecallObservationToolStatus;
	memoryId: string;
	observationId: string;
	collision: boolean;
	partial: boolean;
	reflections: ReflectionDetails[];
	directObservationMatches: RecallObservationMatchDetails[];
	observations: RecallObservationMatchDetails[];
	matches: RecallObservationMatchDetails[];
	sourceEntries: RecallSourceEntryDetails[];
	unavailableSupportingObservations: RecallUnavailableSupportingObservationDetails[];
	missingSourceEntryIds: string[];
	nonSourceEntryIds: string[];
	sourceCharacterCount?: number;
	message?: string;
};

function pad(n: number): string {
	return n.toString().padStart(2, "0");
}

function fmtLocal(d: Date): string {
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDisplayTimestamp(...values: Array<number | string | undefined>): string {
	for (const v of values) {
		if (v === undefined) continue;
		const d = new Date(v);
		if (!Number.isNaN(d.getTime())) return fmtLocal(d);
	}
	return "未知时间";
}

function textContentBlocks(content: unknown): Array<Record<string, unknown>> {
	return Array.isArray(content) ? content.filter((block): block is Record<string, unknown> => !!block && typeof block === "object") : [];
}

function uniqueStrings(items: string[]): string[] {
	return Array.from(new Set(items));
}

function sourceOriginAndQualifiers(entry: Entry): { origin: string; timestamp: string; qualifiers: string[] } {
	if (entry.type === "message" && entry.message && typeof entry.message === "object") {
		const msg = entry.message as Message;
		const timestamp = formatDisplayTimestamp(msg.timestamp, entry.timestamp);
		if (msg.role === "user") return { origin: "用户", timestamp, qualifiers: [] };
		if (msg.role === "assistant") {
			const toolCalls = uniqueStrings(
				textContentBlocks(msg.content)
					.filter((block) => block.type === "toolCall" && typeof block.name === "string")
					.map((block) => block.name as string),
			);
			return { origin: "助手", timestamp, qualifiers: toolCalls.length > 0 ? [`工具调用：${toolCalls.join("、")}`] : [] };
		}
		const toolName = (msg as ToolResultMessage).toolName;
		return { origin: `工具结果：${typeof toolName === "string" && toolName ? toolName : "未知"}`, timestamp, qualifiers: [] };
	}
	if (entry.type === "custom_message") {
		return {
			origin: "自定义消息",
			timestamp: formatDisplayTimestamp(entry.timestamp),
			qualifiers: typeof entry.customType === "string" && entry.customType ? [`自定义：${entry.customType}`] : [],
		};
	}
	if (entry.type === "branch_summary") return { origin: "分支摘要", timestamp: formatDisplayTimestamp(entry.timestamp), qualifiers: [] };
	return { origin: entry.type || "条目", timestamp: formatDisplayTimestamp(entry.timestamp), qualifiers: [] };
}

function renderSourceEntryContentOnly(entry: Entry): string | undefined {
	const rendered = renderRecallSourceEntry(entry);
	return rendered?.replace(/^\[[^\]]+\][:：]\s?/, "") || undefined;
}

function sourceEntryDetails(entry: Entry, includeContent: boolean): RecallSourceEntryDetails {
	const { origin, timestamp, qualifiers } = sourceOriginAndQualifiers(entry);
	const content = renderSourceEntryContentOnly(entry);
	return {
		id: entry.id,
		origin,
		timestamp,
		tokens: estimateEntryTokens(entry),
		qualifiers,
		...(includeContent && content ? { content } : {}),
	};
}

function observationDetails(observation: Observation, status?: "active" | "dropped"): ObservationDetails {
	return { id: observation.id, content: observation.content, timestamp: observation.timestamp, relevance: observation.relevance, ...(status ? { status } : {}) };
}

function reflectionDetails(reflection: Reflection, reflectionIndex: number): ReflectionDetails {
	return { id: reflection.id, content: reflection.content, supportingObservationIds: reflection.supportingObservationIds, reflectionIndex };
}

function observationMatchDetails(match: RecalledObservation, includeSourceContent = true): RecallObservationMatchDetails {
	const unavailable = match.missingSourceEntryIds.length > 0 || match.nonSourceEntryIds.length > 0;
	const status = unavailable ? "source_unavailable" : match.sourceEntries.length === 0 ? "no_source" : match.status;
	return {
		status,
		observationEntryId: match.observationEntryId,
		observationRecordIndex: match.observationRecordIndex,
		observation: observationDetails(match.observation, match.status),
		sourceEntryIds: match.sourceEntryIds,
		sourceEntries: match.sourceEntries.map((entry) => sourceEntryDetails(entry, includeSourceContent)),
		missingSourceEntryIds: match.missingSourceEntryIds,
		nonSourceEntryIds: match.nonSourceEntryIds,
		sourceCharacterCount: renderRecallSourceEntries(match.sourceEntries).length,
	};
}

function textResult(text: string, details: RecallObservationToolDetails) {
	return { content: [{ type: "text" as const, text }], details };
}

function emptyDetails(status: RecallObservationToolStatus, memoryId: string, message: string): RecallObservationToolDetails {
	return {
		status,
		memoryId,
		observationId: memoryId,
		collision: false,
		partial: false,
		reflections: [],
		directObservationMatches: [],
		observations: [],
		matches: [],
		sourceEntries: [],
		unavailableSupportingObservations: [],
		missingSourceEntryIds: [],
		nonSourceEntryIds: [],
		message,
	};
}

function aggregateStatus(details: Omit<RecallObservationToolDetails, "status">): RecallObservationToolStatus {
	const observationOnly = details.reflections.length === 0 && details.unavailableSupportingObservations.length === 0;
	if (details.partial) return "partial";
	if (observationOnly && details.observations.some((match) => match.status === "source_unavailable")) return "source_unavailable";
	if (observationOnly && details.observations.length > 0 && details.sourceEntries.length === 0 && details.matches.every((match) => (match.sourceEntries ?? []).length === 0)) return "no_source";
	return "ok";
}

function friendlyNoSourceMessage(memoryId: string): string {
	return `观察 ${memoryId} 没有关联的源条目。`;
}

function friendlySourceUnavailableMessage(match: RecallObservationMatchDetails): string {
	const missing = match.missingSourceEntryIds && match.missingSourceEntryIds.length > 0 ? ` 缺失：${match.missingSourceEntryIds.join("、")}` : "";
	const nonSource = match.nonSourceEntryIds && match.nonSourceEntryIds.length > 0 ? ` 非源条目：${match.nonSourceEntryIds.join("、")}` : "";
	return `观察 ${match.observation.id} 有关联的源条目，但其中一些在当前分支上不可用，或无法作为源渲染。${missing}${nonSource}`;
}

function reflectionLineText(reflection: ReflectionDetails): string {
	return `[${reflection.id}] ${reflection.content}`;
}

function observationLineText(observation: ObservationDetails): string {
	const status = observation.status === "dropped" ? " [已精简]" : "";
	return `[${observation.id}]${status} ${observation.timestamp} [${observation.relevance}] ${observation.content}`;
}

function directObservationMatches(result: Extract<RecallResult, { status: "found" }>): RecalledObservation[] {
	return result.observations.filter((match) => match.observation.id === result.memoryId);
}

function renderObservationOnlyTextFromResult(result: Extract<RecallResult, { status: "found" }>): string {
	const sections: string[] = [];
	if (result.collision) sections.push(`记忆 id ${result.memoryId} 匹配到多条观察；返回当前分支上所有匹配的源结果。`);
	for (const match of directObservationMatches(result)) {
		if (match.status === "dropped") sections.push(`观察 ${match.observation.id} 已从活跃记忆精简，但仍可召回。`);
		if (match.missingSourceEntryIds.length > 0 || match.nonSourceEntryIds.length > 0) {
			sections.push(friendlySourceUnavailableMessage(observationMatchDetails(match, false)));
			continue;
		}
		if (match.sourceEntries.length === 0) {
			sections.push(friendlyNoSourceMessage(match.observation.id));
			continue;
		}
		const sourceText = renderRecallSourceEntries(match.sourceEntries);
		sections.push(sourceText.trim() ? sourceText : `观察 ${match.observation.id} 有关联的源条目，但没有渲染出文本内容。`);
	}
	return sections.join("\n\n");
}

function unavailableSupportingLineText(item: RecallUnavailableSupportingObservationDetails): string {
	return `支撑观察 ${item.observationId} 在当前分支上不可用。`;
}

function renderMemoryText(result: Extract<RecallResult, { status: "found" }>): string {
	const sections: string[] = [];
	if (result.collision) sections.push(`记忆 id ${result.memoryId} 匹配到多条观察/反思；返回当前分支上所有可用证据。`);
	if (result.reflections.length > 0) sections.push(`反思：\n${result.reflections.map((match) => reflectionLineText(reflectionDetails(match.reflection, match.reflectionRecordIndex))).join("\n")}`);
	if (result.observations.length > 0) sections.push(`观察：\n${result.observations.map((match) => observationLineText(observationDetails(match.observation, match.status))).join("\n")}`);
	if (result.missingSupportingObservationIds.length > 0) sections.push(`不可用的支撑观察：\n${result.missingSupportingObservationIds.map((id) => unavailableSupportingLineText({ observationId: id })).join("\n")}`);
	if (result.missingSourceEntryIds.length > 0 || result.nonSourceEntryIds.length > 0) {
		const parts: string[] = [];
		if (result.missingSourceEntryIds.length > 0) parts.push(`缺失：${result.missingSourceEntryIds.join("、")}`);
		if (result.nonSourceEntryIds.length > 0) parts.push(`非源条目：${result.nonSourceEntryIds.join("、")}`);
		sections.push(`不可用的源条目：${parts.join("；")}`);
	}
	const sourceText = renderRecallSourceEntries(result.sourceEntries);
	if (sourceText.trim()) sections.push(`源内容：\n${sourceText}`);
	if (sections.length === 0) sections.push(`已找到记忆 ${result.memoryId}，但没有渲染出源证据。`);
	return sections.join("\n\n");
}

function resultDetails(result: Extract<RecallResult, { status: "found" }>, includeSourceContent = true): RecallObservationToolDetails {
	const reflections = result.reflections.map((match) => reflectionDetails(match.reflection, match.reflectionRecordIndex));
	const observations = result.observations.map((match) => observationMatchDetails(match, includeSourceContent));
	const directMatches = directObservationMatches(result).map((match) => observationMatchDetails(match, includeSourceContent));
	const sourceEntries = result.sourceEntries.map((entry) => sourceEntryDetails(entry, includeSourceContent));
	const detailWithoutStatus = {
		memoryId: result.memoryId,
		observationId: result.memoryId,
		collision: result.collision,
		partial: result.partial,
		reflections,
		directObservationMatches: directMatches,
		observations,
		matches: directMatches,
		sourceEntries,
		unavailableSupportingObservations: result.missingSupportingObservationIds.map((observationId) => ({ observationId })),
		missingSourceEntryIds: result.missingSourceEntryIds,
		nonSourceEntryIds: result.nonSourceEntryIds,
		sourceCharacterCount: renderRecallSourceEntries(result.sourceEntries).length,
	};
	return { status: aggregateStatus(detailWithoutStatus), ...detailWithoutStatus };
}

function isObservationOnly(details: RecallObservationToolDetails): boolean {
	return details.reflections.length === 0 && details.unavailableSupportingObservations.length === 0;
}

function renderFoundResult(result: Extract<RecallResult, { status: "found" }>): ReturnType<typeof textResult> {
	const details = resultDetails(result);
	const text = result.kind === "observation" ? renderObservationOnlyTextFromResult(result) : renderMemoryText(result);
	return textResult(text, details);
}

function plural(n: number, unit: string): string {
	return `${n.toLocaleString()} ${unit}`;
}

function sourceEntriesFromDetails(details: RecallObservationToolDetails): RecallSourceEntryDetails[] {
	if (!isObservationOnly(details)) return details.sourceEntries;
	return details.matches.flatMap((match) => match.sourceEntries ?? []);
}

function tokenSummary(tokens: number): string {
	return `~${tokens.toLocaleString()} token`;
}

function isFailureStatus(status: RecallObservationToolStatus): boolean {
	return status === "invalid_id" || status === "not_found";
}

function observationCountForHeader(details: RecallObservationToolDetails): number {
	return isObservationOnly(details) ? details.matches.length : details.observations.length;
}

export function formatRecallHeaderForTui(details: RecallObservationToolDetails): string {
	if (isFailureStatus(details.status)) return "× 失败";
	const parts = ["✓ 成功"];
	if (details.reflections.length > 0) parts.push(plural(details.reflections.length, "条反思"));
	const observations = observationCountForHeader(details);
	if (observations > 0) parts.push(plural(observations, "条观察"));
	const sources = sourceEntriesFromDetails(details);
	if (sources.length > 0) parts.push(plural(sources.length, "个源条目"));
	const tokens = sources.reduce((sum, source) => sum + source.tokens, 0);
	if (tokens > 0) parts.push(tokenSummary(tokens));
	if (details.partial && details.status !== "ok") parts.push(RECALL_STATUS_LABELS[details.status] ?? details.status);
	return parts.join(" · ");
}

const TUI_TYPE_WIDTH = 15;
const TUI_META_WIDTH = 31;

function alignedRow(type: string, meta: string, text: string): string {
	return `${type.padEnd(TUI_TYPE_WIDTH)} ${meta.padEnd(TUI_META_WIDTH)} ${text}`.trimEnd();
}

function sourceTag(source: RecallSourceEntryDetails): string {
	const origin = source.origin.trim();
	if (origin === "用户") return "用户";
	if (origin === "助手") return "助手";
	if (origin.startsWith("工具结果")) return "工具";
	if (origin.startsWith("自定义消息")) return "自定义";
	if (origin.startsWith("分支摘要")) return "摘要";
	return origin.split(/[^\p{L}\p{N}]+/u).find(Boolean) ?? "条目";
}

function sourceMetadataLine(source: RecallSourceEntryDetails): string {
	return alignedRow("✓ 源", `${source.timestamp} [${sourceTag(source)}]`, tokenSummary(source.tokens));
}

function observationLine(observation: ObservationDetails): string {
	const status = observation.status === "dropped" ? " 已精简" : "";
	return alignedRow("✓ 观察", `${observation.timestamp} [${observation.relevance}]${status}`, observation.content);
}

function reflectionLine(reflection: ReflectionDetails): string {
	return alignedRow("✓ 反思", "", reflection.content);
}

function noteLine(kind: string, text: string): string {
	return alignedRow("• 说明", `[${kind}]`, text);
}

function indentContent(content: string): string {
	return content.split("\n").map((line) => `    ${line}`).join("\n");
}

function unavailableEvidenceMessage(_details: RecallObservationToolDetails): string {
	return "该记忆 id 没有可用的源条目";
}

function pushSourceLines(lines: string[], sources: RecallSourceEntryDetails[], expanded: boolean): void {
	for (const source of sources) {
		lines.push(sourceMetadataLine(source));
		if (expanded && source.content) {
			lines.push(indentContent(source.content));
			lines.push("");
		}
	}
}

function memoryRows(details: RecallObservationToolDetails): string[] {
	if (isObservationOnly(details)) return details.matches.map((match) => observationLine(match.observation));
	return [...details.reflections.map((reflection) => reflectionLine(reflection)), ...details.observations.map((observation) => observationLine(observation.observation))];
}

function noteRows(details: RecallObservationToolDetails, sources: RecallSourceEntryDetails[]): string[] {
	const notes: string[] = [];
	if (details.status === "invalid_id") {
		notes.push(noteLine("id 非法", `记忆 id 必须是 12 位小写十六进制字符；收到 ${details.memoryId}`));
		return notes;
	}
	if (details.status === "not_found") {
		notes.push(noteLine("未找到", `当前分支上找不到 id 为 ${details.memoryId} 的观察或反思`));
		return notes;
	}
	if (details.collision) notes.push(noteLine("id 冲突", `多个记忆项共用 ${details.memoryId}`));
	if (details.observations.some((match) => match.observation.status === "dropped")) notes.push(noteLine("已精简", "一条或多条观察已从活跃记忆精简，但仍可召回"));
	if (details.unavailableSupportingObservations.length > 0) notes.push(noteLine("缺失支撑", details.unavailableSupportingObservations.map((item) => item.observationId).join("、")));
	if (details.missingSourceEntryIds.length > 0) notes.push(noteLine("缺失源条目", details.missingSourceEntryIds.join("、")));
	if (details.nonSourceEntryIds.length > 0) notes.push(noteLine("非源条目", details.nonSourceEntryIds.join("、")));
	if (sources.length === 0 && (details.reflections.length > 0 || details.observations.length > 0 || details.matches.length > 0)) notes.push(noteLine("证据不可用", unavailableEvidenceMessage(details)));
	return notes;
}

export function formatRecallResultForTui(result: AgentToolResult<RecallObservationToolDetails>, expanded: boolean): string {
	const details = result.details;
	if (!details) {
		const text = result.content.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n");
		return text || "召回";
	}
	const sources = sourceEntriesFromDetails(details);
	const lines: string[] = [];
	const rows = memoryRows(details);
	const notes = noteRows(details, sources);
	lines.push(...rows);
	if (rows.length > 0 && notes.length > 0) lines.push("");
	lines.push(...notes);
	if ((rows.length > 0 || notes.length > 0) && sources.length > 0) lines.push("");
	pushSourceLines(lines, sources, expanded);
	if (!expanded && sources.some((source) => source.content)) lines.push("", "（Ctrl+O 展开）");
	return lines.join("\n").trimEnd();
}

export function formatRecallCallForTui(id: string | undefined): string {
	return `召回 ${id ?? "..."}`;
}

export function formatRecallRenderedResultForTui(result: AgentToolResult<RecallObservationToolDetails>, expanded: boolean): string {
	const body = formatRecallResultForTui(result, expanded);
	const header = result.details ? formatRecallHeaderForTui(result.details) : undefined;
	if (header && body) return `\n${header}\n\n${body}`;
	if (header) return `\n${header}`;
	return body ? `\n${body}` : "";
}

export const recallObservationTool = defineTool({
	name: RECALL_OBSERVATION_TOOL_NAME,
	label: "召回记忆证据",
	description:
		"恢复当前分支上某条已压缩的观察式记忆观察或反思背后的精确证据与源上下文。" +
		"当压缩记忆很重要、行动前需要原始源上下文时使用。",
	promptSnippet: "需要精确性时，用 recall(<id>) 恢复已压缩记忆观察/反思背后的精确源上下文。",
	promptGuidelines: [
		"当重要决定依赖某条细节不清的已压缩观察或反思时，先用 recall 再决定。",
		"当需要记忆声明的精确措辞、理由、文件路径、命令、错误、提交、用户约束或来源时，使用 recall。",
		"当某条宽泛反思相关、但需要它的支撑观察或原始源内容才能安全继续时，使用 recall。",
		"当用户询问你为什么相信某事、某条记忆的依据，或之前决定了什么时，使用 recall。",
		"不要把 recall 当作语义搜索或会话浏览；必须已经有具体的 12 字符记忆 id。",
		"不要预先召回每个 id。只在精确源上下文能实质改善下一步行动时使用 recall。",
	],
	parameters: Type.Object({
		id: Type.String({
			pattern: "^[a-f0-9]{12}$",
			description: "压缩记忆、/om:view 或之前召回结果中显示的 12 位小写十六进制观察或反思 id。必须是具体 id；本工具不按主题搜索。",
		}),
	}),
	renderCall(args) {
		return new Text(formatRecallCallForTui(args.id), 0, 0);
	},
	renderResult(result, options) {
		return new Text(formatRecallRenderedResultForTui(result as AgentToolResult<RecallObservationToolDetails>, options.expanded), 0, 0);
	},
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const memoryId = params.id;
		if (!MEMORY_ID_PATTERN.test(memoryId)) {
			const message = `记忆 id 必须是 12 位小写十六进制字符。收到：${memoryId}`;
			return textResult(message, emptyDetails("invalid_id", memoryId, message));
		}
		const branchEntries = ctx.sessionManager.getBranch() as Entry[];
		const result = recallMemorySources(branchEntries, memoryId);
		if (result.status === "not_found") {
			const message = `当前分支上找不到 id 为 ${memoryId} 的观察或反思。`;
			return textResult(message, emptyDetails("not_found", memoryId, message));
		}
		return renderFoundResult(result);
	},
});

export function registerRecallTool(pi: ExtensionAPI): void {
	pi.registerTool(recallObservationTool);
}
