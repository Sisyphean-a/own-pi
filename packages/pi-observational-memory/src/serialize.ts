import type { Message, TextContent, ToolResultMessage } from "@earendil-works/pi-ai";
import { estimateStringTokens } from "./tokens.js";

function pad(n: number): string {
	return n.toString().padStart(2, "0");
}

function fmtLocal(d: Date): string {
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatTimestamp(v: number | string | undefined): string {
	if (v === undefined) return "????-??-?? ??:??";
	const d = new Date(v);
	return Number.isNaN(d.getTime()) ? "????-??-?? ??:??" : fmtLocal(d);
}

function formatRecallTimestamp(...values: Array<number | string | undefined>): string {
	for (const v of values) {
		if (v === undefined) continue;
		const d = new Date(v);
		if (!Number.isNaN(d.getTime())) return fmtLocal(d);
	}
	return "未知时间";
}

function textAndPlaceholders(
	content: unknown,
	options: { omitRedactedThinking?: boolean; includeThinking?: boolean } = {},
): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "[非文本内容已省略]";

	const parts: string[] = [];
	for (const block of content as Array<Record<string, unknown>>) {
		if (!block || typeof block !== "object") {
			parts.push("[非文本内容已省略]");
			continue;
		}
		if (block.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
			continue;
		}
		if (block.type === "thinking") {
			if (options.omitRedactedThinking && block.redacted === true) continue;
			if (options.includeThinking && typeof block.thinking === "string") {
				parts.push(`[思考：${block.thinking}]`);
				continue;
			}
			parts.push("[非文本内容已省略]");
			continue;
		}
		if (block.type === "toolCall" && typeof block.name === "string") {
			parts.push(`[${block.name}(${JSON.stringify(block.arguments ?? {})})]`);
			continue;
		}
		parts.push("[非文本内容已省略]");
	}
	return parts.join("\n");
}

function textOnly(content: unknown): string {
	if (content == null) return "";
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b): b is TextContent => b?.type === "text" && typeof b.text === "string")
		.map((b) => b.text)
		.join("\n");
}

export function serializeConversation(messages: Message[]): string {
	return messages
		.map((msg): string | null => {
			const time = formatTimestamp(msg.timestamp);
			if (msg.role === "user") {
				const text = textOnly(msg.content);
				return `[用户 @ ${time}]：${text}`;
			}
			if (msg.role === "assistant") {
				const body = textAndPlaceholders(msg.content, {
					includeThinking: true,
					omitRedactedThinking: true,
				})
					.split("\n")
					.filter(Boolean)
					.join("\n");
				if (!body) return null;
				return `[助手 @ ${time}]：${body}`;
			}
			const text = textOnly(msg.content);
			return `[工具结果 ${(msg as ToolResultMessage).toolName} @ ${time}]：${text}`;
		})
		.filter((line): line is string => line !== null)
		.join("\n\n");
}

export function nowTimestamp(): string {
	return fmtLocal(new Date());
}

export const MAX_RECORD_CONTENT_CHARS = 10_000;

export function truncateRecordContent(content: string): string {
	if (content.length <= MAX_RECORD_CONTENT_CHARS) return content;
	const head = content.slice(0, MAX_RECORD_CONTENT_CHARS);
	const dropped = content.length - MAX_RECORD_CONTENT_CHARS;
	return `${head} … [已截断 ${dropped} 字符]`;
}

export type RenderableEntry = {
	type: string;
	id?: string;
	timestamp?: string;
	message?: unknown;
	customType?: string;
	content?: unknown;
	summary?: unknown;
};

function renderCustomMessage(entry: RenderableEntry, options: { recallFormat: boolean }): string {
	const time = options.recallFormat ? formatRecallTimestamp(entry.timestamp) : formatTimestamp(entry.timestamp);
	const text = options.recallFormat
		? textAndPlaceholders(entry.content)
		: typeof entry.content === "string"
			? entry.content
			: Array.isArray(entry.content)
				? (entry.content as Array<{ type?: string; text?: string }>)
						.filter((b) => b?.type === "text" && typeof b.text === "string")
						.map((b) => b.text as string)
						.join("\n")
				: "";
	if (options.recallFormat) {
		const origin = entry.customType ? `自定义消息（${entry.customType}）` : "自定义消息";
		return `[${origin} @ ${time}]：${text}`;
	}
	const tag = entry.customType ? `自定义（${entry.customType}）` : "自定义";
	return `[${tag} @ ${time}]：${text}`;
}

export function serializeBranchEntries(entries: RenderableEntry[]): string {
	const blocks: string[] = [];
	for (const entry of entries) {
		if (entry.type === "message" && entry.message) {
			const part = serializeConversation([entry.message as Message]);
			if (part) blocks.push(part);
			continue;
		}
		if (entry.type === "custom_message") {
			blocks.push(renderCustomMessage(entry, { recallFormat: false }));
			continue;
		}
		if (entry.type === "branch_summary" && typeof entry.summary === "string") {
			const time = formatTimestamp(entry.timestamp);
			blocks.push(`[分支摘要 @ ${time}]：${entry.summary}`);
		}
	}
	return blocks.join("\n\n");
}

export type SourceAddressedSerialization = {
	text: string;
	sourceEntryIds: string[];
	estimatedTokens: number;
	truncatedSourceEntryIds: string[];
};

export type SourceAddressedSerializationOptions = {
	/** 最终源寻址文本的最大估算 token 数。 */
	maxTokens?: number;
};

const SOURCE_OMISSION_MARKER =
	"\n\n[… 中间部分已省略：源内容超出观察器输入预算；原始源内容仍保留在会话账本中 …]\n\n";

function truncateSourceBlockToTokenBudget(label: string, rendered: string, maxTokens: number): string | undefined {
	const required = `${label}\n${SOURCE_OMISSION_MARKER}`;
	if (estimateStringTokens(required) > maxTokens) return undefined;
	const full = `${label}\n${rendered}`;
	if (estimateStringTokens(full) <= maxTokens) return full;
	const maxChars = Math.max(1, maxTokens * 4);
	const fixed = `${label}\n${SOURCE_OMISSION_MARKER}`;
	const retainedChars = maxChars - fixed.length;
	const headChars = Math.ceil(retainedChars / 2);
	const tailChars = retainedChars - headChars;
	return `${label}\n${rendered.slice(0, headChars)}${SOURCE_OMISSION_MARKER}${tailChars > 0 ? rendered.slice(-tailChars) : ""}`;
}

function isSourceRenderableEntry(entry: RenderableEntry): boolean {
	return entry.type === "message" || entry.type === "custom_message" || entry.type === "branch_summary";
}

/**
 * 在 token 预算内序列化完整的源条目。如果首个条目单独就超出预算，则包含一个带明显标记的
 * 首尾摘录，避免一个病态的工具结果永久阻断观察覆盖。
 * 原始 ledger 条目永不修改，且仍可按 id 召回。
 */
export function serializeSourceAddressedBranchEntries(
	entries: RenderableEntry[],
	options: SourceAddressedSerializationOptions = {},
): SourceAddressedSerialization {
	const blocks: string[] = [];
	const sourceEntryIds: string[] = [];
	const truncatedSourceEntryIds: string[] = [];
	let estimatedTokens = 0;

	for (const entry of entries) {
		if (!entry.id || !isSourceRenderableEntry(entry)) continue;
		const rendered = serializeBranchEntries([entry]);
		if (!rendered.trim()) continue;
		const label = `[Source entry id: ${entry.id}]`;
		const block = `${label}\n${rendered}`;
		const separator = blocks.length > 0 ? "\n\n" : "";
		const blockTokens = estimateStringTokens(`${separator}${block}`);
		const maxTokens = options.maxTokens;

		if (maxTokens !== undefined && estimatedTokens + blockTokens > maxTokens) {
			if (blocks.length > 0) break;
			const excerpt = truncateSourceBlockToTokenBudget(label, rendered, maxTokens);
			if (!excerpt) break;
			blocks.push(excerpt);
			sourceEntryIds.push(entry.id);
			truncatedSourceEntryIds.push(entry.id);
			estimatedTokens = estimateStringTokens(excerpt);
			break;
		}

		blocks.push(block);
		sourceEntryIds.push(entry.id);
		estimatedTokens += blockTokens;
	}

	const text = blocks.join("\n\n");
	return { text, sourceEntryIds, estimatedTokens: estimateStringTokens(text), truncatedSourceEntryIds };
}

function renderRecallMessage(entry: RenderableEntry): string | null {
	if (!entry.message || typeof entry.message !== "object") return null;
	const msg = entry.message as Message;
	const time = formatRecallTimestamp(msg.timestamp, entry.timestamp);
	if (msg.role === "user") {
		return `[用户 @ ${time}]：${textAndPlaceholders(msg.content)}`;
	}
	if (msg.role === "assistant") {
		const body = textAndPlaceholders(msg.content, {
			includeThinking: true,
			omitRedactedThinking: true,
		})
			.split("\n")
			.filter(Boolean)
			.join("\n");
		if (!body) return null;
		return `[助手 @ ${time}]：${body}`;
	}
	return `[工具结果：${(msg as ToolResultMessage).toolName} @ ${time}]：${textAndPlaceholders(msg.content)}`;
}

export function renderRecallSourceEntry(entry: RenderableEntry): string | null {
	if (entry.type === "message") return renderRecallMessage(entry);
	if (entry.type === "custom_message") return renderCustomMessage(entry, { recallFormat: true });
	if (entry.type === "branch_summary" && typeof entry.summary === "string") {
		const time = formatRecallTimestamp(entry.timestamp);
		return `[分支摘要 @ ${time}]：${entry.summary}`;
	}
	return null;
}

export function renderRecallSourceEntries(entries: RenderableEntry[]): string {
	return entries
		.map(renderRecallSourceEntry)
		.filter((block): block is string => block !== null && block.trim().length > 0)
		.join("\n\n");
}
