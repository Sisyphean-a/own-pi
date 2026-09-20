import { agentLoop, type AgentLoopConfig, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Message, Model, ModelThinkingLevel, ProviderHeaders } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { Static } from "typebox";
import { debugLog } from "../../debug-log.js";
import { hashId } from "../../ids.js";
import { createAgentContext } from "../agent-context.js";
import { logAgentStreamError } from "../stream-errors.js";
import { AGENT_LOOP_MAX_TOKENS, boundedMaxTokens } from "../../model-budget.js";
import { truncateRecordContent } from "../../serialize.js";
import { REFLECTOR_SYSTEM } from "./prompts.js";
import { estimateStringTokens } from "../../tokens.js";
import { reflectionToSummaryLine, type Observation, type Reflection } from "../../session-ledger/index.js";
import {
	coverageTierForObservation,
	reflectionCoverageMap,
	summarizeCoverageByRelevance,
	summarizeCoverageTransitionsByRelevance,
	type ReflectionCoverageTier,
} from "../dropper/coverage.js";

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
}

const RecordReflectionsSchema = Type.Object({
	reflections: Type.Array(
		Type.Object({
			content: Type.String({ minLength: 1 }),
			supportingObservationIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
		}),
		{ minItems: 1 },
	),
});

type RecordReflectionsArgs = Static<typeof RecordReflectionsSchema>;

function joinOrEmpty(items: string[]): string {
	return items.length ? items.join("\n") : "（暂无）";
}

export function observationToReflectorLine(
	observation: Observation,
	coverage: ReflectionCoverageTier,
): string {
	return `[${observation.id}] ${observation.timestamp} [${observation.relevance}] [coverage: ${coverage}] ${observation.content}`;
}

export function summarizeSupportIdCounts(reflections: readonly Reflection[]): {
	reflectionCount: number;
	totalSupportIds: number;
	minSupportIds: number;
	maxSupportIds: number;
	averageSupportIds: number;
	histogram: Record<string, number>;
} {
	if (reflections.length === 0) {
		return { reflectionCount: 0, totalSupportIds: 0, minSupportIds: 0, maxSupportIds: 0, averageSupportIds: 0, histogram: {} };
	}
	const counts = reflections.map((reflection) => reflection.supportingObservationIds.length);
	const totalSupportIds = counts.reduce((sum, count) => sum + count, 0);
	const histogram: Record<string, number> = {};
	for (const count of counts) histogram[String(count)] = (histogram[String(count)] ?? 0) + 1;
	return {
		reflectionCount: reflections.length,
		totalSupportIds,
		minSupportIds: Math.min(...counts),
		maxSupportIds: Math.max(...counts),
		averageSupportIds: totalSupportIds / reflections.length,
		histogram,
	};
}

export function normalizeSupportingObservationIds(
	supportingObservationIds: readonly string[] | undefined,
	allowedObservationIds: readonly string[],
): string[] | undefined {
	if (!supportingObservationIds || supportingObservationIds.length === 0) return undefined;
	const allowedOrder = new Map<string, number>();
	for (let i = 0; i < allowedObservationIds.length; i++) {
		if (!allowedOrder.has(allowedObservationIds[i])) allowedOrder.set(allowedObservationIds[i], i);
	}

	const seen = new Set<string>();
	for (const id of supportingObservationIds) {
		if (!allowedOrder.has(id)) return undefined;
		seen.add(id);
	}
	if (seen.size === 0) return undefined;
	return Array.from(seen).sort((a, b) => (allowedOrder.get(a) ?? 0) - (allowedOrder.get(b) ?? 0));
}

function normalizeReflectionContent(content: string): string | undefined {
	const normalized = truncateRecordContent(content.trim());
	if (!normalized || /\r|\n/.test(normalized)) return undefined;
	return normalized;
}

export async function runReflector(args: RunReflectorArgs): Promise<Reflection[] | undefined> {
	const { model, apiKey, headers, env, reflections, observations, signal } = args;
	if (observations.length === 0) return undefined;

	const coverageById = reflectionCoverageMap(observations, reflections);
	debugLog("reflector.agent_start", {
		activeObservationCount: observations.length,
		reflectionCount: reflections.length,
		coverageSummaryByRelevance: summarizeCoverageByRelevance(observations, coverageById),
	});

	const allowedObservationIds = observations.map((observation) => observation.id);
	const existingReflectionIds = new Set(reflections.map((reflection) => reflection.id));
	const accumulated = new Map<string, Reflection>();
	let toolCallCount = 0;
	let rawProposedReflectionCount = 0;
	let acceptedReflectionCount = 0;
	let duplicateReflectionCount = 0;
	let rejectedReflectionCount = 0;

	const recordReflections: AgentTool<typeof RecordReflectionsSchema> = {
		name: "record_reflections",
		label: "记录反思",
		description: "记录新的持久反思及其支撑观察 id。",
		parameters: RecordReflectionsSchema,
		execute: async (_id, params: RecordReflectionsArgs) => {
			toolCallCount++;
			rawProposedReflectionCount += params.reflections.length;
			let added = 0;
			let duplicates = 0;
			let rejected = 0;
			for (const proposal of params.reflections) {
				const content = normalizeReflectionContent(proposal.content);
				const supportingObservationIds = normalizeSupportingObservationIds(proposal.supportingObservationIds, allowedObservationIds);
				if (!content || !supportingObservationIds) {
					rejected++;
					continue;
				}
				const id = hashId(content);
				if (existingReflectionIds.has(id) || accumulated.has(id)) {
					duplicates++;
					continue;
				}
				accumulated.set(id, {
					id,
					content,
					supportingObservationIds,
					tokenCount: estimateStringTokens(content),
				});
				added++;
			}
			acceptedReflectionCount += added;
			duplicateReflectionCount += duplicates;
			rejectedReflectionCount += rejected;
			return {
				content: [{ type: "text", text: `已记录 ${added} 条反思；重复 ${duplicates} 条；被拒 ${rejected} 条。本次运行累计 ${accumulated.size} 条。` }],
				details: { added, duplicates, rejected, total: accumulated.size },
			};
		},
	};

	const userText = `当前反思：\n${joinOrEmpty(reflections.map(reflectionToSummaryLine))}\n\n当前观察：\n${joinOrEmpty(observations.map((observation) => observationToReflectorLine(observation, coverageTierForObservation(observation, coverageById))))}\n\n请把缺失的持久事实或模式沉淀成新的反思。如果没有足够稳定的内容，就不要调用工具。`;
	const prompts: Message[] = [{ role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() }];
	const context = createAgentContext(
		REFLECTOR_SYSTEM,
		[recordReflections as AgentTool<any>],
	);
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
		...(effectiveMaxTurns !== undefined ? { shouldStopAfterTurn: () => ++turnCount >= effectiveMaxTurns } : {}),
	};

	const loop = args.agentLoop ?? agentLoop;
	const stream = loop(prompts, context, config, signal, streamSimple);
	for await (const event of stream) {
		// 工具执行时收集记录。
		logAgentStreamError("reflector", event);
	}
	await stream.result();
	const acceptedReflections = Array.from(accumulated.values());
	const afterCoverageById = reflectionCoverageMap(observations, [...reflections, ...acceptedReflections]);
	debugLog("reflector.result", {
		reason: acceptedReflections.length > 0 ? "accepted_nonempty" : toolCallCount === 0 ? "no_tool_call" : "all_filtered",
		toolCallCount,
		rawProposedReflectionCount,
		acceptedReflectionCount,
		duplicateReflectionCount,
		rejectedReflectionCount,
		acceptedSupportIdCounts: summarizeSupportIdCounts(acceptedReflections),
		coverageTransitionsByRelevance: summarizeCoverageTransitionsByRelevance(observations, coverageById, afterCoverageById),
	});
	return acceptedReflections.length > 0 ? acceptedReflections : undefined;
}
