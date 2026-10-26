import { agentLoop, type AgentLoopConfig, type AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Message, type Model, type ModelThinkingLevel, type ProviderHeaders } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { Static } from "typebox";
import { debugLog, recordDiagnosticError } from "../../debug-log.js";
import { hashId } from "../../ids.js";
import { createAgentContext } from "../agent-context.js";
import { logAgentStreamError } from "../stream-errors.js";
import { WorkerStreamError } from "../worker-retry.js";
import { WorkerDiagnostics } from "../worker-diagnostics.js";
import { workerMaxTokens, workerMessages } from "../../model-budget.js";
import { MAX_RECORD_CONTENT_CHARS } from "../../serialize.js";
import { REFLECTOR_SYSTEM } from "./prompts.js";
import { estimateStringTokens } from "../../tokens.js";
import { observationToSummaryLine, reflectionToSummaryLine, type Observation, type Reflection, type ReflectionRetirement } from "../../session-ledger/index.js";
import { normalizeSourceEntryIds } from "../observer/agent.js";

interface RunReflectorArgs {
	model: Model<any>;
	apiKey?: string;
	headers?: ProviderHeaders;
	env?: Record<string, string>;
	reflections: Reflection[];
	observations: Observation[];
	signal?: AbortSignal;
	agentLoop?: typeof agentLoop;
	maxTurns?: number;
	thinkingLevel?: ModelThinkingLevel;
	onUsage?: (message: unknown) => void;
}
const IdList = Type.Array(Type.String({ minLength: 1 }), { minItems: 1 });
const Content = Type.String({ minLength: 1, maxLength: MAX_RECORD_CONTENT_CHARS });
const RecordReflectionsSchema = Type.Object({
	reflections: Type.Array(Type.Object({ content: Content, supportingObservationIds: IdList })),
	retirements: Type.Array(Type.Object({ reflectionId: Type.String(), supportingObservationIds: IdList, reason: Content })),
	reviewedObservationIds: IdList,
});
export const normalizeSupportingObservationIds = normalizeSourceEntryIds;
export type ReflectorResult = { reflections: Reflection[]; retirements: ReflectionRetirement[]; reviewedObservationIds: string[] };

function singleLine(content: string): string {
	const text = content.trim();
	if (!text || /\r|\n/.test(text) || text.length > MAX_RECORD_CONTENT_CHARS) throw new Error("反思与撤回理由必须为长度合法的单行文本");
	return text;
}

export async function runReflector(args: RunReflectorArgs): Promise<ReflectorResult | undefined> {
	if (!args.observations.length) return undefined;
	const diagnostics = new WorkerDiagnostics("reflector", args, { observations: args.observations.length, reflections: args.reflections.length, outputTokenBudget: workerMaxTokens(args.model) });
	const allowedIds = args.observations.map((observation) => observation.id);
	const existingIds = new Set(args.reflections.map((reflection) => reflection.id));
	let result: ReflectorResult | undefined;
	const recordReflections: AgentTool<typeof RecordReflectionsSchema> = {
		name: "record_reflections", label: "维护反思",
		description: "原子提交新增反思、旧反思撤回和全部观察的审阅回执；无变化时两个结果数组均为空。",
		parameters: RecordReflectionsSchema,
		execute: async (_id, params: Static<typeof RecordReflectionsSchema>) => {
			if (result) throw new Error("本次反思维护已完成");
			const reviewed = normalizeSupportingObservationIds(params.reviewedObservationIds, allowedIds);
			if (!reviewed || reviewed.length !== new Set(allowedIds).size) {
				diagnostics.validation("record_reflections", { expectedCount: new Set(allowedIds).size, receivedCount: params.reviewedObservationIds.length, missingIds: allowedIds.filter((id) => !params.reviewedObservationIds.includes(id)) });
				throw new Error("审阅回执必须包含全部当前观察 id");
			}
			const support = (ids: string[]) => {
				const normalized = normalizeSupportingObservationIds(ids, allowedIds);
				if (!normalized) throw new Error("支撑 id 必须来自当前观察");
				return normalized;
			};
			const retirements = new Map<string, ReflectionRetirement>();
			for (const retirement of params.retirements) {
				if (!existingIds.has(retirement.reflectionId)) throw new Error("只能撤回当前有效的反思 id");
				retirements.set(retirement.reflectionId, {
					reflectionId: retirement.reflectionId,
					supportingObservationIds: support(retirement.supportingObservationIds),
					reason: singleLine(retirement.reason),
				});
			}
			const existingContent = new Set(args.reflections.filter((item) => !retirements.has(item.id)).map((item) => item.content));
			const accepted = new Map<string, Reflection>();
			for (const proposal of params.reflections) {
				const content = singleLine(proposal.content);
				const supportingObservationIds = support(proposal.supportingObservationIds);
				if (existingContent.has(content)) continue;
				const id = hashId(JSON.stringify([content, supportingObservationIds]));
				// 新证据上的重新确认具有独立身份；不可用新记录撤回自己。
				if (retirements.has(id)) throw new Error("新增反思不能与撤回反思复用同一 id；需要新的变化证据");
				accepted.set(id, { id, content, supportingObservationIds, tokenCount: estimateStringTokens(content) });
			}
			result = { reflections: [...accepted.values()], retirements: [...retirements.values()], reviewedObservationIds: reviewed };
			return {
				content: [{ type: "text", text: `维护完成：新增 ${result.reflections.length} 条，撤回 ${result.retirements.length} 条。` }],
				details: { added: result.reflections.length, retired: result.retirements.length },
			};
		},
	};
	const userText = `当前有效反思：\n${args.reflections.map(reflectionToSummaryLine).join("\n") || "（暂无）"}\n\n当前观察：\n${args.observations.map(observationToSummaryLine).join("\n")}`;
	const prompts: Message[] = [{ role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() }];
	const context = createAgentContext(REFLECTOR_SYSTEM, diagnostics.tools([recordReflections as AgentTool<any>]));
	let turns = 0;
	const thinking = args.thinkingLevel ?? "low";
	const config: AgentLoopConfig = {
		model: args.model, apiKey: args.apiKey, headers: args.headers, env: args.env,
		maxTokens: workerMaxTokens(args.model),
		convertToLlm: (messages) => workerMessages(args.model, messages as Message[]), toolExecution: "sequential",
		...(args.model.reasoning && thinking !== "off" ? { reasoning: thinking } : {}),
		finishTurn: () => { diagnostics.turns = ++turns; return result || (args.maxTurns && turns >= args.maxTurns) ? { action: "end" } as const : undefined; },
	};
	return diagnostics.run(async () => {
		const stream = (args.agentLoop ?? agentLoop)(prompts, context, config, args.signal, streamSimple);
		let streamError: { stopReason: string; errorMessage?: string } | undefined;
		for await (const event of stream) {
			diagnostics.observe(event);
			logAgentStreamError("reflector", event);
			if (event.type === "tool_execution_end" && event.isError) { if (result) diagnostics.invalidated(); result = undefined; }
			if (event.type === "message_end") {
				try { args.onUsage?.(event.message); } catch (error) { recordDiagnosticError("usage.callback_error", error, { stage: "reflector" }); }
				const message = event.message as { stopReason?: string; errorMessage?: string };
				if (message.stopReason === "error" || message.stopReason === "aborted") {
					streamError = { stopReason: message.stopReason, errorMessage: message.errorMessage };
				}
			}
		}
		await stream.result();
		if (streamError) {
			throw new WorkerStreamError(
				streamError.stopReason,
				streamError.errorMessage,
				`反思器流失败，未提交维护结果：${streamError.errorMessage ?? streamError.stopReason}`,
			);
		}
		if (!result) throw diagnostics.completionError("反思器缺少审阅完成回执");
		debugLog("reflector.result", { reflections: result.reflections.length, retirements: result.retirements.length });
		return result;
	});
}
