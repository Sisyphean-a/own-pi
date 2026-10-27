import { agentLoop, type AgentLoopConfig, type AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Message, type Model, type ModelThinkingLevel, type ProviderHeaders } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { Static } from "typebox";
import { createAgentContext } from "../agent-context.js";
import { recordDiagnosticError } from "../../debug-log.js";
import { logAgentStreamError, WorkerStreamError } from "../stream-errors.js";
import { WorkerDiagnostics } from "../worker-diagnostics.js";
import { workerMaxTokens, workerMessages } from "../../model-budget.js";
import { observationToSummaryLine, reflectionToSummaryLine, type Observation, type Reflection, type ObservationDrop } from "../../session-ledger/index.js";
import { observationPoolMetrics } from "./pool.js";
import { observationLineTokenCount } from "../../tokens.js";
import { DROPPER_SYSTEM } from "./prompts.js";
export { observationPoolFullness, observationPoolMetrics } from "./pool.js";

interface RunDropperArgs {
	model: Model<any>;
	apiKey?: string;
	headers?: ProviderHeaders;
	env?: Record<string, string>;
	reflections: Reflection[];
	observations: Observation[];
	targetTokens: number;
	signal?: AbortSignal;
	agentLoop?: typeof agentLoop;
	thinkingLevel?: ModelThinkingLevel;
	onUsage?: (message: unknown) => void;
}
const DropSchema = Type.Object({ drops: Type.Array(Type.Object({
	observationId: Type.String(),
	reason: Type.Union([Type.Literal("redundant"), Type.Literal("superseded"), Type.Literal("resolved"), Type.Literal("routine")]),
	replacementIds: Type.Array(Type.String()),
})) });

export function selectDropCandidates(
	proposals: readonly ObservationDrop[], observations: readonly Observation[], targetTokens: number, reflections: readonly Reflection[],
): ObservationDrop[] {
	const byId = new Map(observations.map((item) => [item.id, item]));
	const reflectionIds = new Set(reflections.map((item) => item.id));
	const unique = new Map<string, ObservationDrop>();
	for (const proposal of proposals) {
		const observation = byId.get(proposal.observationId);
		if (!observation) throw new Error("精简 id 必须来自当前观察");
		const replacements = [...new Set(proposal.replacementIds)];
		if (replacements.some((id) => id === observation.id || (!byId.has(id) && !reflectionIds.has(id)))) throw new Error("替代证据必须是其他当前有效记忆");
		if (proposal.reason === "routine" ? observation.relevance !== "low" : replacements.length === 0) throw new Error("非 low 例行项必须提供替代或状态变化证据");
		unique.set(observation.id, { ...proposal, replacementIds: replacements });
	}
	const rank = { low: 0, medium: 1, high: 2, critical: 3 };
	const sorted = [...unique.values()].sort((a, b) => {
		const left = byId.get(a.observationId)!, right = byId.get(b.observationId)!;
		return rank[left.relevance] - rank[right.relevance] || left.timestamp.localeCompare(right.timestamp);
	});
	let remaining = observationPoolMetrics(observations, targetTokens).observationTokens;
	const selected: ObservationDrop[] = [];
	for (const candidate of sorted) {
		if (remaining <= targetTokens) break;
		selected.push(candidate);
		remaining -= observationLineTokenCount(byId.get(candidate.observationId)!);
	}
	const selectedIds = new Set(selected.map((item) => item.observationId));
	// 替代记忆必须实际留存；同批互相引用或删除链不构成保留证明。
	return selected.filter((item) => item.reason === "routine" || item.replacementIds.every((id) => reflectionIds.has(id) || !selectedIds.has(id)));
}

export async function runDropper(args: RunDropperArgs): Promise<ObservationDrop[] | undefined> {
	const metrics = observationPoolMetrics(args.observations, args.targetTokens);
	if (!metrics.ready) return undefined;
	const diagnostics = new WorkerDiagnostics("dropper", { ...args, maxTurns: 1 }, { observations: args.observations.length, reflections: args.reflections.length, observationTokens: metrics.observationTokens, targetTokens: args.targetTokens, outputTokenBudget: workerMaxTokens(args.model) });
	let result: ObservationDrop[] | undefined;
	let hasToolError = false;
	const dropObservations: AgentTool<typeof DropSchema> = {
		name: "drop_observations", label: "精简观察",
		description: "提交安全精简及替代证据；无安全项时提交空数组。",
		parameters: DropSchema,
		execute: async (_id, params: Static<typeof DropSchema>) => {
			if (result !== undefined) throw new Error("本次精简已完成");
			result = selectDropCandidates(params.drops, args.observations, args.targetTokens, args.reflections);
			return { content: [{ type: "text", text: `已选择 ${result.length} 条有依据的精简。` }], details: { selected: result.length } };
		},
	};
	const text = `当前有效反思：\n${args.reflections.map(reflectionToSummaryLine).join("\n") || "（暂无）"}\n\n当前观察：\n${args.observations.map(observationToSummaryLine).join("\n")}\n\n活跃观察约 ${metrics.observationTokens} token，目标约 ${args.targetTokens} token。`;
	const prompts: Message[] = [{ role: "user", content: [{ type: "text", text }], timestamp: Date.now() }];
	const context = createAgentContext(DROPPER_SYSTEM, diagnostics.tools([dropObservations as AgentTool<any>]));
	const thinking = args.thinkingLevel ?? "low";
	const config: AgentLoopConfig = {
		model: args.model, apiKey: args.apiKey, headers: args.headers, env: args.env,
		maxTokens: workerMaxTokens(args.model),
		convertToLlm: (messages) => workerMessages(args.model, messages as Message[]), toolExecution: "sequential",
		...(args.model.reasoning && thinking !== "off" ? { reasoning: thinking } : {}),
		finishTurn: () => { diagnostics.turns = 1; return { action: "end" }; },
	};
	return diagnostics.run(async () => {
		const stream = (args.agentLoop ?? agentLoop)(prompts, context, config, args.signal, streamSimple);
		let streamError: { stopReason: string; errorMessage?: string } | undefined;
		for await (const event of stream) {
			diagnostics.observe(event);
			logAgentStreamError("dropper", event);
			if (event.type === "tool_execution_end" && event.isError) {
				hasToolError = true;
				if (result !== undefined) diagnostics.invalidated();
				result = undefined;
			}
			if (event.type === "message_end" && event.message.role === "assistant") {
				try { args.onUsage?.(event.message); } catch (error) { recordDiagnosticError("usage.callback_error", error, { stage: "dropper" }); }
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
				`精简器流失败，未提交删除结果：${streamError.errorMessage ?? streamError.stopReason}`,
			);
		}
		if (hasToolError || result === undefined) throw diagnostics.completionError("精简器缺少完成回执");
		return result;
	});
}
