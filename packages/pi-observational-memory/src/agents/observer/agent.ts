import { agentLoop, type AgentContext, type AgentLoopConfig, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Message, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { Static } from "typebox";
import { hashId } from "../../ids.js";
import { logAgentStreamError } from "../stream-errors.js";
import { AGENT_LOOP_MAX_TOKENS, boundedMaxTokens } from "../../model-budget.js";
import { OBSERVER_SYSTEM } from "./prompts.js";
import { nowTimestamp, truncateRecordContent } from "../../serialize.js";
import type { Observation, Relevance } from "../../session-ledger/index.js";
import { observationLineTokenCount } from "../../tokens.js";

interface RunObserverArgs {
	model: Model<any>;
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
	priorReflections: string[];
	priorObservations: string[];
	chunk: string;
	allowedSourceEntryIds: string[];
	signal?: AbortSignal;
	agentLoop?: typeof agentLoop;
	maxTurns?: number;
	thinkingLevel?: ModelThinkingLevel;
}

const RelevanceSchema = Type.Union([
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("critical"),
]);

export const OBSERVATION_TIMESTAMP_PATTERN = "^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}$";

const RecordObservationsSchema = Type.Object({
	observations: Type.Array(
		Type.Object({
			timestamp: Type.String({
				pattern: OBSERVATION_TIMESTAMP_PATTERN,
				description: "观察时间，本地时间，格式 'YYYY-MM-DD HH:MM'。",
			}),
			content: Type.String({
				minLength: 1,
				description: "单行纯文本。不要 markdown、标签或内嵌时间戳。",
			}),
			relevance: RelevanceSchema,
			sourceEntryIds: Type.Array(
				Type.String({ minLength: 1 }),
				{
					minItems: 1,
					description:
						"分块中直接支持这条观察的精确源条目 id。" +
						"只能使用 '[Source entry id: ...]' 标签中出现的 id，绝不编造 id。",
				},
			),
		}),
		{ description: "一批新观察。只有完全不调用该工具时才允许为空。" },
	),
});

type RecordObservationsArgs = Static<typeof RecordObservationsSchema>;

/**
 * 当 agent 循环以 API/流失败（`stopReason` 为 `"error"`/`"aborted"`）结束且没有记录任何
 * 内容时抛出。agent-core 会正常返回这类运行，因此没有这个错误时，调用方无法区分硬失败和
 * 刻意空结果（#32）。
 */
export class ObserverStreamError extends Error {
	readonly stopReason: string;
	constructor(stopReason: string, errorMessage?: string) {
		super(`观察器流以 stopReason "${stopReason}" 结束${errorMessage ? `：${errorMessage}` : ""}`);
		this.name = "ObserverStreamError";
		this.stopReason = stopReason;
	}
}

function joinOrEmpty(items: string[]): string {
	return items.length ? items.join("\n") : "（暂无）";
}

export function normalizeSourceEntryIds(
	sourceEntryIds: readonly string[] | undefined,
	allowedSourceEntryIds: readonly string[],
): string[] | undefined {
	if (!sourceEntryIds || sourceEntryIds.length === 0) return undefined;
	const allowedOrder = new Map<string, number>();
	for (let i = 0; i < allowedSourceEntryIds.length; i++) allowedOrder.set(allowedSourceEntryIds[i], i);

	const seen = new Set<string>();
	for (const id of sourceEntryIds) {
		if (!allowedOrder.has(id)) return undefined;
		seen.add(id);
	}
	if (seen.size === 0) return undefined;
	return Array.from(seen).sort((a, b) => (allowedOrder.get(a) ?? 0) - (allowedOrder.get(b) ?? 0));
}

export async function runObserver(args: RunObserverArgs): Promise<Observation[] | undefined> {
	const { model, apiKey, headers, env, priorReflections, priorObservations, chunk, allowedSourceEntryIds, signal } = args;
	const conversation = chunk.trim();
	if (!conversation) return undefined;

	const accumulated = new Map<string, Observation>();

	const recordObservations: AgentTool<typeof RecordObservationsSchema> = {
		name: "record_observations",
		label: "记录观察",
		description:
			"记录从对话分块中提炼的一批新观察。处理分块时可以多次调用；覆盖完成后停止调用，" +
			"然后输出一句简短纯文本确认来结束本次运行。",
		parameters: RecordObservationsSchema,
		execute: async (_id, params: RecordObservationsArgs) => {
			let added = 0;
			let duplicates = 0;
			let rejected = 0;
			for (const obs of params.observations) {
				const sourceEntryIds = normalizeSourceEntryIds(obs.sourceEntryIds, allowedSourceEntryIds);
				if (!sourceEntryIds) {
					rejected++;
					continue;
				}
				const content = truncateRecordContent(obs.content);
				const id = hashId(content);
				if (accumulated.has(id)) {
					duplicates++;
					continue;
				}
				accumulated.set(id, {
					id,
					content,
					timestamp: obs.timestamp,
					relevance: obs.relevance as Relevance,
					sourceEntryIds,
					tokenCount: observationLineTokenCount({
						id,
						timestamp: obs.timestamp,
						relevance: obs.relevance,
						content,
					}),
				});
				added++;
			}
			const rejectedPart = rejected > 0
				? ` ${rejected} 条观察因 sourceEntryIds 缺失或非法被拒绝。`
				: "";
			const ack =
				`已记录 ${added} 条新观察` +
				(duplicates > 0 ? `（跳过 ${duplicates} 条重复）。` : "。") +
				rejectedPart +
				` 本次运行累计 ${accumulated.size} 条。` +
				`如果分块仍有未覆盖内容，继续调用工具；否则停止调用并输出一句简短纯文本确认。`;
			return { content: [{ type: "text", text: ack }], details: { added, duplicates, rejected, total: accumulated.size } };
		},
	};

	const now = nowTimestamp();
	const userText = `当前本地时间：${now}

当前反思：
${joinOrEmpty(priorReflections)}

当前观察：
${joinOrEmpty(priorObservations)}

请调用 record_observations 一次或多次，把下面这段新对话分块压缩成观察。不要重复当前反思或当前观察中已有的事实。分配时间时优先使用对话内联时间戳；只有在没有消息时间戳可用时才回退到上面的当前本地时间。分块完全覆盖后停止调用工具，并回复一句简短纯文本确认。

新对话分块：
${conversation}`;

	const prompts: Message[] = [
		{
			role: "user",
			content: [{ type: "text", text: userText }],
			timestamp: Date.now(),
		},
	];

	const context: AgentContext = {
		systemPrompt: OBSERVER_SYSTEM,
		messages: [],
		tools: [recordObservations as AgentTool<any>],
	};

	const reasoning = (model as { reasoning?: unknown }).reasoning;
	const thinkingLevel = args.thinkingLevel ?? "low";
	const effectiveMaxTurns = args.maxTurns && args.maxTurns > 0 ? args.maxTurns : undefined;
	let turnCount = 0;
	const config: AgentLoopConfig = {
		model,
		apiKey,
		headers,
		env,
		maxTokens: boundedMaxTokens(model, AGENT_LOOP_MAX_TOKENS),
		convertToLlm: (msgs) => msgs as Message[],
		toolExecution: "sequential",
		...(reasoning && thinkingLevel !== "off" ? { reasoning: thinkingLevel } : {}),
		...(effectiveMaxTurns !== undefined
			? {
				shouldStopAfterTurn: () => {
					turnCount++;
					return turnCount >= effectiveMaxTurns;
				},
			}
			: {}),
	};

	const loop = args.agentLoop ?? agentLoop;
	const stream = loop(prompts, context, config, signal, streamSimple);
	let streamError: { stopReason: string; errorMessage?: string } | undefined;
	for await (const event of stream) {
		// 排空事件；工具执行已经收集了记录。
		logAgentStreamError("observer", event);
		// 监测终止性 API/流失败，避免与刻意空结果混为一谈。
		const message = (event as { message?: { role?: string; stopReason?: string; errorMessage?: string } }).message;
		if (message?.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted")) {
			streamError = { stopReason: message.stopReason, errorMessage: message.errorMessage };
		}
	}
	await stream.result();

	if (accumulated.size === 0) {
		if (streamError) throw new ObserverStreamError(streamError.stopReason, streamError.errorMessage);
		return undefined;
	}
	return Array.from(accumulated.values());
}
