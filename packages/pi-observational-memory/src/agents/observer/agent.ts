import { agentLoop, type AgentLoopConfig, type AgentTool } from "@earendil-works/pi-agent-core";
import { createInitialSystemMessage, toToolDeclaration, Type, type Message, type Model, type ModelThinkingLevel, type ProviderHeaders } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { Static } from "typebox";
import { hashId } from "../../ids.js";
import { logAgentStreamError } from "../stream-errors.js";
import { WorkerStreamError } from "../worker-retry.js";
import { remainingWorkerInputBytes, workerMaxTokens, workerMessages } from "../../model-budget.js";
import { OBSERVER_SYSTEM } from "./prompts.js";
import { MAX_RECORD_CONTENT_CHARS, nowTimestamp } from "../../serialize.js";
import type { Observation } from "../../session-ledger/index.js";
import { observationLineTokenCount } from "../../tokens.js";
import { createAgentContext } from "../agent-context.js";

interface RunObserverArgs {
	model: Model<any>;
	apiKey?: string;
	headers?: ProviderHeaders;
	env?: Record<string, string>;
	priorReflections: string[];
	priorObservations: string[];
	chunk: string;
	allowedSourceEntryIds: string[];
	sourceOffset?: number;
	signal?: AbortSignal;
	agentLoop?: typeof agentLoop;
	maxTurns?: number;
	thinkingLevel?: ModelThinkingLevel;
	onUsage?: (message: unknown) => void;
}

export const OBSERVATION_TIMESTAMP_PATTERN = "^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}$";
const RecordObservationsSchema = Type.Object({ observations: Type.Array(Type.Object({
	timestamp: Type.String({ pattern: OBSERVATION_TIMESTAMP_PATTERN, description: "源消息本地时间，YYYY-MM-DD HH:MM。" }),
	content: Type.String({ minLength: 1, maxLength: MAX_RECORD_CONTENT_CHARS, description: "单行事实，保留适用范围与必要理由。" }),
	relevance: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("critical")]),
	sourceEntryIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: "直接支撑本观察的源条目 id。" }),
}), { minItems: 1 }) });
const FinishSchema = Type.Object({ processedSourceEntryIds: Type.Array(Type.String(), { minItems: 1 }) });
const RECORD_TOOL = {
	name: "record_observations", label: "记录观察",
	description: "记录有直接源证据的新观察；完成审阅后调用 finish_observation。", parameters: RecordObservationsSchema,
};
const FINISH_TOOL = {
	name: "finish_observation", label: "完成源片段审阅",
	description: "确认本次提供的全部源片段均已审阅；允许零条观察。", parameters: FinishSchema,
};

export class ObserverStreamError extends WorkerStreamError {
	constructor(stopReason: string, errorMessage?: string) {
		super(
			stopReason,
			errorMessage,
			`观察器流以 stopReason "${stopReason}" 结束${errorMessage ? `：${errorMessage}` : ""}`,
		);
		this.name = "ObserverStreamError";
	}
}

export function normalizeSourceEntryIds(ids: readonly string[] | undefined, allowedIds: readonly string[]): string[] | undefined {
	if (!ids?.length) return undefined;
	const unique = new Set(ids), allowed = new Set(allowedIds);
	if (ids.some((id) => !allowed.has(id))) return undefined;
	return [...allowed].filter((id) => unique.has(id));
}

export type ObserverResult = { observations: Observation[]; complete: true };

function observerUserText(priorReflections: string[], priorObservations: string[], chunk: string): string {
	return `当前本地时间：${nowTimestamp()}\n\n当前反思：\n${priorReflections.join("\n") || "（暂无）"}\n\n当前观察：\n${priorObservations.join("\n") || "（暂无）"}\n\n新源片段：\n${chunk}`;
}

export function observerChunkBudget(model: Model<any>, priorReflections: string[], priorObservations: string[], requested: number): number {
	const system = createInitialSystemMessage(OBSERVER_SYSTEM, [toToolDeclaration(RECORD_TOOL), toToolDeclaration(FINISH_TOOL)]);
	const prefix: Message = { role: "user", content: [{ type: "text", text: observerUserText(priorReflections, priorObservations, "") }], timestamp: Date.now() };
	const remaining = remainingWorkerInputBytes(model, [system!, prefix]);
	// 源预算用 4 字符/token；JSON 转义每个 UTF-16 字符至多 6 字节。
	const budget = Math.min(requested, Math.floor(remaining / 24));
	if (budget <= 0) throw new Error("已有记忆占满观察器输入预算；请使用更大上下文模型，处理进度未推进");
	return budget;
}

export async function runObserver(args: RunObserverArgs): Promise<ObserverResult | undefined> {
	if (!args.chunk.trim()) return undefined;
	const accumulated = new Map<string, Observation>();
	let complete = false;
	let lastRejected = 0;
	const recordObservations: AgentTool<typeof RecordObservationsSchema> = {
		...RECORD_TOOL,
		execute: async (_id, params: Static<typeof RecordObservationsSchema>) => {
			if (complete) throw new Error("观察审阅已经完成");
			let added = 0, duplicates = 0, rejected = 0;
			for (const proposal of params.observations) {
				const sourceEntryIds = normalizeSourceEntryIds(proposal.sourceEntryIds, args.allowedSourceEntryIds);
				const content = proposal.content.trim();
				if (!sourceEntryIds || !content || /\r|\n/.test(content) || content.length > MAX_RECORD_CONTENT_CHARS) { rejected++; continue; }
				// 事件身份包含来源与片段位置；相同事实再次发生不会复用旧墓志铭。
				const id = hashId(JSON.stringify([content, sourceEntryIds, args.sourceOffset ?? 0]));
				if (accumulated.has(id)) { duplicates++; continue; }
				const observation = { id, content, timestamp: proposal.timestamp, relevance: proposal.relevance, sourceEntryIds };
				accumulated.set(id, { ...observation, tokenCount: observationLineTokenCount(observation) });
				added++;
			}
			lastRejected = rejected;
			return {
				content: [{ type: "text", text: `已记录 ${added} 条；重复 ${duplicates} 条；拒绝 ${rejected} 条（检查来源和单行内容）。审阅完全部片段后调用 finish_observation。` }],
				details: { added, duplicates, rejected, total: accumulated.size },
			};
		},
	};
	const finishObservation: AgentTool<typeof FinishSchema> = {
		...FINISH_TOOL,
		execute: async (_id, params: Static<typeof FinishSchema>) => {
			complete = false;
			const ids = normalizeSourceEntryIds(params.processedSourceEntryIds, args.allowedSourceEntryIds);
			if (lastRejected > 0 || !ids || ids.length !== new Set(args.allowedSourceEntryIds).size) {
				throw new Error("完成回执必须包含全部已提供的源 id，且先修正被拒绝的观察");
			}
			complete = true;
			return { content: [{ type: "text", text: "本次源片段审阅完成。" }], details: undefined };
		},
	};
	const userText = observerUserText(args.priorReflections, args.priorObservations, args.chunk);
	const prompts: Message[] = [{ role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() }];
	const context = createAgentContext(OBSERVER_SYSTEM, [recordObservations, finishObservation] as AgentTool<any>[]);
	const effectiveMaxTurns = args.maxTurns && args.maxTurns > 0 ? args.maxTurns : undefined;
	let turns = 0;
	const thinking = args.thinkingLevel ?? "low";
	const config: AgentLoopConfig = {
		model: args.model, apiKey: args.apiKey, headers: args.headers, env: args.env,
		maxTokens: workerMaxTokens(args.model),
		convertToLlm: (messages) => workerMessages(args.model, messages as Message[]), toolExecution: "sequential",
		...(args.model.reasoning && thinking !== "off" ? { reasoning: thinking } : {}),
		finishTurn: () => (++turns, complete || (effectiveMaxTurns !== undefined && turns >= effectiveMaxTurns) ? { action: "end" } as const : undefined),
	};
	const stream = (args.agentLoop ?? agentLoop)(prompts, context, config, args.signal, streamSimple);
	let streamError: { stopReason: string; errorMessage?: string } | undefined;
	for await (const event of stream) {
		logAgentStreamError("observer", event);
		if (event.type === "tool_execution_end" && event.isError) complete = false;
		if (event.type === "message_end") {
			try { args.onUsage?.(event.message); } catch { /* Failure: 统计不改变 worker 结果。 */ }
		}
		const message = (event as { message?: { role?: string; stopReason?: string; errorMessage?: string } }).message;
		if (message?.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted")) {
			streamError = { stopReason: message.stopReason, errorMessage: message.errorMessage };
		}
	}
	await stream.result();
	if (streamError) throw new ObserverStreamError(streamError.stopReason, streamError.errorMessage);
	if (!complete) throw new Error("观察器缺少完成回执；不提交观察，也不推进处理进度");
	return { observations: Array.from(accumulated.values()), complete: true };
}
