import type { Message, Model } from "@earendil-works/pi-ai";

export const AGENT_LOOP_MAX_TOKENS = 32_000;

export function workerMaxTokens(model: Model<any>): number {
	const maximum = boundedMaxTokens(model);
	return Number.isFinite(model.contextWindow) && model.contextWindow > 0
		? Math.min(maximum, Math.max(1, Math.floor(model.contextWindow / 4))) : maximum;
}

/** UTF-8 字节数作为保守上界；预算不足时显式失败，不截断已有记忆。 */
export function remainingWorkerInputBytes(model: Model<any>, messages: readonly Message[]): number {
	if (!Number.isFinite(model.contextWindow) || model.contextWindow <= 0) return Number.POSITIVE_INFINITY;
	return model.contextWindow - workerMaxTokens(model) - Buffer.byteLength(JSON.stringify(messages), "utf8");
}

export function workerMessages(model: Model<any>, messages: Message[]): Message[] {
	if (remainingWorkerInputBytes(model, messages) < 0) throw new Error("记忆 worker 的完整输入超出模型预算；请使用更大上下文模型或整理记忆，现有内容未被截断");
	return messages;
}

export function boundedMaxTokens(model: Model<any>, requested: number = AGENT_LOOP_MAX_TOKENS): number {
	return typeof model.maxTokens === "number" && model.maxTokens > 0
		? Math.min(model.maxTokens, requested)
		: requested;
}
