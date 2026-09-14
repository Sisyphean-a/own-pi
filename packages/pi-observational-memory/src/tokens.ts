import { estimateTokens as estimateMessageTokens } from "@earendil-works/pi-coding-agent";

export function estimateStringTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/**
 * 估算一条观察行在摘要/观察池列表中的渲染占位："[id] YYYY-MM-DD HH:MM [relevance] content"。
 * 只统计纯内容的池预算会低估每行的元数据开销（id + 时间戳 + 重要度标签），导致实际达到
 * 配置的池目标比渲染记忆真正允许的更晚。
 */
export function observationLineTokenCount(observation: {
	id: string;
	timestamp: string;
	relevance: string;
	content: string;
}): number {
	return estimateStringTokens(
		`[${observation.id}] ${observation.timestamp} [${observation.relevance}] ${observation.content}`,
	);
}

export function estimateEntryTokens(entry: { type: string; message?: unknown; content?: unknown; summary?: unknown }): number {
	if (entry.type === "message" && entry.message) {
		return estimateMessageTokens(entry.message as Parameters<typeof estimateMessageTokens>[0]);
	}
	if (entry.type === "custom_message" && entry.content) {
		const content = entry.content;
		if (typeof content === "string") return estimateStringTokens(content);
		if (Array.isArray(content)) {
			let total = 0;
			for (const block of content) {
				if (block.type === "text" && block.text) total += estimateStringTokens(block.text);
			}
			return total;
		}
	}
	if (entry.type === "branch_summary" && typeof entry.summary === "string") {
		return estimateStringTokens(entry.summary);
	}
	return 0;
}

