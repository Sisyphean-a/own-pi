import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { publishUsage } from "../agents/model-usage.js";
import { runDropper } from "../agents/dropper/agent.js";
import { observationPoolMetrics } from "../agents/dropper/pool.js";
import { observerChunkBudget, runObserver } from "../agents/observer/agent.js";
import { runReflector } from "../agents/reflector/agent.js";
import { debugLog, withDebugLogContext } from "../debug-log.js";
import { resolveObserverChunkMaxTokens } from "../config.js";
import { CONSOLIDATION_PHASE_LABELS, type ResolveResult, type Runtime } from "../runtime.js";
import { serializeSourceAddressedBranchEntries } from "../serialize.js";
import {
	OM_OBSERVATIONS_DROPPED,
	OM_OBSERVATIONS_RECORDED,
	OM_REFLECTIONS_RECORDED,
	buildObservationsDroppedData,
	buildObservationsRecordedData,
	buildReflectionsRecordedData,
	foldLedger,
	fullProjection,
	observationProcessingState,
	latestCoverageMarkerId,
	observationToSummaryLine,
	reflectionToSummaryLine,
	type Entry,
} from "../session-ledger/index.js";

type ResolvedModel = Extract<ResolveResult, { ok: true }>;

type ConsolidationCtx = {
	/** 启动时的会话代次；代次变化后 ctx/pi 已失效，后台任务必须立即退出。 */
	epoch: number;
	cwd: string;	hasUI: boolean;
	ui?: { notify: (message: string, type?: "warning" | "info" | "error") => void };
	model: unknown;
	modelRegistry: any;
	getContextUsage?: () => { tokens?: number | null; contextWindow?: number } | undefined;
	sessionManager: {
		getBranch: () => unknown;
		getSessionId?: () => string;
		getSessionFile?: () => string | undefined;
	};
};

/** 事件回调里拿到的实时 ctx；启动后台任务时再固化为带代次的 ConsolidationCtx。 */
type LiveCtx = Omit<ConsolidationCtx, "epoch">;

type StageOutcome = "continue" | "abort";

/** 会话代次变化后，Pi 已让旧 ctx/pi 失效：停止后续阶段，不再触碰它们。 */
function sessionActive(runtime: Runtime, ctx: ConsolidationCtx): boolean {
	return runtime.isSessionCurrent(ctx.epoch);
}

/**
 * 从会话读取真实当前上下文 token（provider 上报的 usage，与 footer 百分比同一基准）。
 * 宿主 pi 不支持 getContextUsage 或计数未知时回退为 undefined（例如刚压缩完、下一条有效
 * 助手响应之前）。
 */
function rawContextTokens(ctx: LiveCtx): number | undefined {
	try {
		const usage = typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
		const tokens = usage?.tokens;
		return typeof tokens === "number" && Number.isFinite(tokens) ? tokens : undefined;
	} catch {
		return undefined;
	}
}

function realContextTokens(runtime: Runtime, ctx: ConsolidationCtx): number | undefined {
	if (!sessionActive(runtime, ctx)) return undefined;
	return rawContextTokens(ctx);
}

function stageDue(
	runtime: Runtime,
	entries: Entry[],
	currentTokens: number | undefined,
	kind: "observations" | "reflections",
	threshold: number,
): boolean {
	const progress = kind === "observations"
		? runtime.observationProgress(entries, currentTokens)
		: runtime.reflectionProgress(entries, currentTokens);
	return (progress.realTokens ?? progress.rawTokens) >= threshold;
}

function anyStageDue(entries: Entry[], runtime: Runtime, currentTokens: number | undefined): boolean {
	return stageDue(runtime, entries, currentTokens, "observations", runtime.config.observeAfterTokens)
		|| stageDue(runtime, entries, currentTokens, "reflections", runtime.config.reflectAfterTokens)
		|| runtime.maintenanceDue(entries);
}

function shouldNotifyWorker(runtime: Runtime, ctx: ConsolidationCtx): boolean {
	return runtime.config.showWorkerNotifications && ctx.hasUI && sessionActive(runtime, ctx);
}

function makeModelResolver(runtime: Runtime, ctx: ConsolidationCtx): (stage: "observer" | "reflector" | "dropper") => Promise<ResolvedModel | undefined> {
	let cached: ResolveResult | undefined;
	return async (stage) => {
		if (!sessionActive(runtime, ctx)) return undefined;
		cached ??= await runtime.resolveModel({
			model: ctx.model,
			modelRegistry: ctx.modelRegistry,
			hasUI: ctx.hasUI,
			ui: ctx.ui,
		});
		if (cached.ok) {
			runtime.resolveFailureNotified = false;
			// OpenCode Go 要求 worker 请求携带稳定会话头；同时保留已有认证头。
			const model = (cached.model ?? {}) as { provider?: string; baseUrl?: string };
			if (model.provider === "opencode" || model.provider === "opencode-go" || (typeof model.baseUrl === "string" && model.baseUrl.includes("opencode.ai"))) {
				const sessionId = ctx.sessionManager.getSessionId?.();
				if (sessionId) {
					return {
						...cached,
						headers: {
							...(cached.headers ?? {}),
							"x-opencode-session": sessionId,
							"x-opencode-client": "pi",
						},
					};
				}
			}
			return cached;
		}
		debugLog(`${stage}.model_unavailable`, { reason: cached.reason });
		if (!runtime.resolveFailureNotified && ctx.hasUI && ctx.ui && sessionActive(runtime, ctx)) {
			ctx.ui.notify(`观察式记忆：${CONSOLIDATION_PHASE_LABELS[stage]}已跳过——${cached.reason}`, "warning");
			runtime.resolveFailureNotified = true;
		}
		return undefined;
	};
}

export function registerConsolidationTrigger(pi: ExtensionAPI, runtime: Runtime): void {
	const launch = (_event: unknown, ctx: ExtensionContext) => {
		maybeLaunchConsolidation(pi, runtime, ctx);
	};
	pi.on("agent_start", launch);
	pi.on("turn_end", launch);
}

function debugSessionMetadata(ctx: LiveCtx): { sessionId?: string; sessionFile?: string } {
	try {
		return {
			sessionId: ctx.sessionManager.getSessionId?.(),
			sessionFile: ctx.sessionManager.getSessionFile?.(),
		};
	} catch {
		return {};
	}
}

function maybeLaunchConsolidation(pi: ExtensionAPI, runtime: Runtime, ctx: LiveCtx): void {
	runtime.ensureConfig(ctx.cwd);
	if (runtime.config.passive === true) return;
	if (runtime.consolidationInFlight) return;

	const entries = ctx.sessionManager.getBranch() as Entry[];
	const currentTokens = rawContextTokens(ctx);
	if (!anyStageDue(entries, runtime, currentTokens)) return;

	const runId = `consolidation-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
	const consolidationCtx: ConsolidationCtx = {
		epoch: runtime.sessionEpoch,
		cwd: ctx.cwd,
		hasUI: ctx.hasUI,
		ui: ctx.ui,
		model: ctx.model,
		modelRegistry: ctx.modelRegistry,
		getContextUsage: ctx.getContextUsage,
		sessionManager: ctx.sessionManager,
	};

	const sessionMetadata = debugSessionMetadata(ctx);
	void runtime.launchConsolidationTask(ctx, async () => withDebugLogContext({
		enabled: runtime.config.debugLog === true,
		cwd: ctx.cwd,
		...sessionMetadata,
		runId,
	}, async () => {
		await runConsolidationPipeline(pi, runtime, consolidationCtx);
	}));
}

export async function runConsolidationPipeline(pi: ExtensionAPI, runtime: Runtime, ctx: ConsolidationCtx): Promise<void> {
	if (!sessionActive(runtime, ctx)) return;
	const resolveModel = makeModelResolver(runtime, ctx);
	for (const stage of ["observer", "reflector", "dropper"] as const) {
		runtime.consolidationPhase = stage;
		try {
			const outcome = stage === "observer" ? await runObserverStage(pi, runtime, ctx, resolveModel)
				: stage === "reflector" ? await runReflectorStage(pi, runtime, ctx, resolveModel)
				: await runDropperStage(pi, runtime, ctx, resolveModel);
			if (outcome === "abort") return;
			if (stage === "dropper" && sessionActive(runtime, ctx)) runtime.finishMaintenance(ctx.sessionManager.getBranch() as Entry[]);
		} catch (error) {
			debugLog(`${stage}.error`, { errorMessage: runtime.recordConsolidationStageError(ctx, stage, error) });
			return;
		}
	}
}

async function runObserverStage(
	pi: ExtensionAPI, runtime: Runtime, ctx: ConsolidationCtx,
	resolveModel: (stage: "observer") => Promise<ResolvedModel | undefined>,
): Promise<StageOutcome> {
	if (!sessionActive(runtime, ctx)) return "abort";
	const entries = ctx.sessionManager.getBranch() as Entry[];
	if (!stageDue(runtime, entries, realContextTokens(runtime, ctx), "observations", runtime.config.observeAfterTokens)) return "continue";
	const cursor = observationProcessingState(entries);
	if (cursor.nextEntryIndex < 0) return "continue";
	const resolved = await resolveModel("observer");
	if (!resolved || !sessionActive(runtime, ctx)) return "abort";
	const memory = fullProjection(entries);
	const priorReflections = memory.reflections.map(reflectionToSummaryLine);
	const priorObservations = memory.observations.map(observationToSummaryLine);
	const maxChunkTokens = observerChunkBudget(resolved.model as any, priorReflections, priorObservations,
		resolveObserverChunkMaxTokens(runtime.config, (resolved.model as { contextWindow?: number }).contextWindow));
	const chunk = serializeSourceAddressedBranchEntries(entries.slice(cursor.nextEntryIndex), {
		maxTokens: maxChunkTokens, startOffset: cursor.startOffset,
	});
	if (!chunk.text || !chunk.sourceEntryIds.length) throw new Error("观察器输入预算不足，无法读取下一个源片段");
	if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(`观察式记忆：观察器正在处理约 ${chunk.estimatedTokens.toLocaleString()} token 的分块`, "info");
	debugLog("observer.start", { sourceEntryIds: chunk.sourceEntryIds, startSourceOffset: cursor.startOffset, chunkTokens: chunk.estimatedTokens });
	const result = await runObserver({
		onUsage: (message) => { try { publishUsage(pi.events, message); } catch { /* Failure: 旧会话已失效。 */ } },
		model: resolved.model as any, apiKey: resolved.apiKey, headers: resolved.headers, env: resolved.env,
		priorReflections, priorObservations, chunk: chunk.text, allowedSourceEntryIds: chunk.sourceEntryIds,
		sourceOffset: cursor.startOffset, maxTurns: runtime.config.agentMaxTurns, thinkingLevel: runtime.config.model?.thinking ?? "low",
	});
	if (!result?.complete) throw new Error("观察器缺少完成回执，处理进度保持不变");
	const coversUpToId = chunk.sourceEntryIds.at(-1)!;
	const data = buildObservationsRecordedData(result.observations, coversUpToId, {
		processedSourceEntryIds: chunk.sourceEntryIds,
		...(cursor.startOffset > 0 ? { startSourceOffset: cursor.startOffset } : {}),
		...(chunk.nextSourceOffset !== undefined ? { nextSourceOffset: chunk.nextSourceOffset } : {}),
	});
	if (!data) throw new Error("观察器处理记录非法");
	if (!sessionActive(runtime, ctx)) return "abort";
	pi.appendEntry(OM_OBSERVATIONS_RECORDED, data);
	debugLog("observer.appended", { count: result.observations.length, coversUpToId, nextSourceOffset: chunk.nextSourceOffset });
	if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(`观察式记忆：已审阅源片段，记录 ${result.observations.length} 条观察`, "info");
	return "continue";
}

async function runReflectorStage(
	pi: ExtensionAPI, runtime: Runtime, ctx: ConsolidationCtx,
	resolveModel: (stage: "reflector") => Promise<ResolvedModel | undefined>,
): Promise<StageOutcome> {
	if (!sessionActive(runtime, ctx)) return "abort";
	const entries = ctx.sessionManager.getBranch() as Entry[];
	const folded = foldLedger(entries);
	const pressure = observationPoolMetrics(folded.activeObservations, runtime.config.observationsPoolMaxTokens).observationTokens >= runtime.config.observationsPoolMaxTokens;
	if (!pressure && !stageDue(runtime, entries, realContextTokens(runtime, ctx), "reflections", runtime.config.reflectAfterTokens)) return "continue";
	if (!folded.activeObservations.length) return "continue";
	const observationCoverageId = latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED);
	if (!observationCoverageId) return "continue";
	const resolved = await resolveModel("reflector");
	if (!resolved || !sessionActive(runtime, ctx)) return "abort";
	if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(`观察式记忆：反思器正在维护 ${folded.activeObservations.length} 条观察与 ${folded.reflections.length} 条当前结论`, "info");
	debugLog("reflector.start", { observations: folded.activeObservations.length, reflections: folded.reflections.length, pressure });
	const result = await runReflector({
		onUsage: (message) => { try { publishUsage(pi.events, message); } catch { /* Failure: 旧会话已失效。 */ } },
		model: resolved.model as any, apiKey: resolved.apiKey, headers: resolved.headers, env: resolved.env,
		reflections: folded.reflections, observations: folded.activeObservations,
		maxTurns: runtime.config.agentMaxTurns, thinkingLevel: runtime.config.model?.thinking ?? "low",
	});
	if (!result) throw new Error("反思器未返回审阅结果");
	const data = buildReflectionsRecordedData(result.reflections, observationCoverageId, result.retirements, result.reviewedObservationIds);
	if (!data) throw new Error("反思维护记录非法");
	if (!sessionActive(runtime, ctx)) return "abort";
	pi.appendEntry(OM_REFLECTIONS_RECORDED, data);
	debugLog("reflector.appended", { added: result.reflections.length, retired: result.retirements.length, coversUpToId: observationCoverageId });
	return "continue";
}

async function runDropperStage(
	pi: ExtensionAPI, runtime: Runtime, ctx: ConsolidationCtx,
	resolveModel: (stage: "dropper") => Promise<ResolvedModel | undefined>,
): Promise<StageOutcome> {
	if (!sessionActive(runtime, ctx)) return "abort";
	const entries = ctx.sessionManager.getBranch() as Entry[];
	const folded = foldLedger(entries);
	const metrics = observationPoolMetrics(folded.activeObservations, runtime.config.observationsPoolTargetTokens);
	if (!metrics.ready) return "continue";
	const coverageId = latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED);
	if (!coverageId) return "continue";
	const resolved = await resolveModel("dropper");
	if (!resolved || !sessionActive(runtime, ctx)) return "abort";
	if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(`观察式记忆：精简器正在检查——活跃观察池约 ${metrics.observationTokens.toLocaleString()} / ${metrics.targetTokens.toLocaleString()} 目标 token`, "info");
	debugLog("dropper.start", metrics);
	const drops = await runDropper({
		onUsage: (message) => { try { publishUsage(pi.events, message); } catch { /* Failure: 旧会话已失效。 */ } },
		model: resolved.model as any, apiKey: resolved.apiKey, headers: resolved.headers, env: resolved.env,
		reflections: folded.reflections, observations: folded.activeObservations, targetTokens: runtime.config.observationsPoolTargetTokens,
		maxTurns: runtime.config.agentMaxTurns, thinkingLevel: runtime.config.model?.thinking ?? "low",
	});
	if (!drops) throw new Error("精简器缺少完成回执");
	if (!drops.length) return "continue";
	const data = buildObservationsDroppedData(drops.map((item) => item.observationId), coverageId, drops);
	if (!data) throw new Error("精简记录非法");
	if (!sessionActive(runtime, ctx)) return "abort";
	pi.appendEntry(OM_OBSERVATIONS_DROPPED, data);
	debugLog("dropper.appended", { count: drops.length, coversUpToId: coverageId });
	return "continue";
}
