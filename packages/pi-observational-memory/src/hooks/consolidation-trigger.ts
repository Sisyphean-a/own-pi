import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { publishUsage } from "../agents/model-usage.js";
import { runDropper } from "../agents/dropper/agent.js";
import { observationPoolMetrics } from "../agents/dropper/pool.js";
import { observerChunkBudget, runObserver } from "../agents/observer/agent.js";
import { runReflector } from "../agents/reflector/agent.js";
import { debugLog, diagnosticLog, recordDiagnosticError, withDebugLogContext } from "../debug-log.js";
import { resolveCompactAfterTokens, resolveObserverChunkMaxTokens } from "../config.js";
import { type ResolveResult, type Runtime } from "../runtime.js";
import { serializeSourceAddressedBranchEntries } from "../serialize.js";
import {
	OM_OBSERVATIONS_DROPPED,
	OM_OBSERVATIONS_RECORDED,
	OM_REFLECTIONS_RECORDED,
	OM_WORKER_ATTEMPTED,
	workerAttempted,
	workerCycleId,
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
	signal?: AbortSignal;
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
	return runtime.isSessionCurrent(ctx.epoch) && !ctx.signal?.aborted;
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
	} catch (error) {
		recordDiagnosticError("context.usage_error", error);
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

function maintenanceCanRun(entries: Entry[], runtime: Runtime, currentTokens: number | undefined): boolean {
	const canDrop = !workerAttempted(entries, "dropper");
	const canReflect = !workerAttempted(entries, "reflector");
	if ((!canDrop && !canReflect) || !runtime.maintenanceDue(entries)) return false;
	if (canDrop) return true;
	return stageDue(runtime, entries, currentTokens, "reflections", runtime.config.reflectAfterTokens)
		|| observationPoolMetrics(foldLedger(entries).activeObservations, runtime.config.observationsPoolMaxTokens).observationTokens >= runtime.config.observationsPoolMaxTokens;
}

function anyStageDue(entries: Entry[], runtime: Runtime, currentTokens: number | undefined): boolean {
	if (stageDue(runtime, entries, currentTokens, "observations", runtime.config.observeAfterTokens)) {
		const cursor = observationProcessingState(entries);
		if (cursor.nextEntryIndex >= 0 && !workerAttempted(entries, "observer", entries[cursor.nextEntryIndex].id, cursor.startOffset)) return true;
	}
	return (!workerAttempted(entries, "reflector") && stageDue(runtime, entries, currentTokens, "reflections", runtime.config.reflectAfterTokens))
		|| maintenanceCanRun(entries, runtime, currentTokens);
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
		if (!sessionActive(runtime, ctx)) return undefined;
		if (cached.ok) {
			const selected = cached.model as { provider?: string; id?: string; contextWindow?: number };
			diagnosticLog("worker.model_resolved", { stage, model: { provider: selected?.provider, id: selected?.id, contextWindow: selected?.contextWindow }, thinking: runtime.config.model?.thinking ?? "low" });
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
		const error = new Error(cached.reason);
		runtime.recordConsolidationStageError(ctx, stage, error, { failureCode: "model_unavailable" });
		return undefined;
	};
}

export function registerConsolidationTrigger(pi: ExtensionAPI, runtime: Runtime): void {
	const launch = (_event: unknown, ctx: ExtensionContext) => {
		maybeLaunchConsolidation(pi, runtime, ctx);
	};
	pi.on("agent_start", launch);
	pi.on("turn_end", launch);
	pi.on("session_compact", () => {
		if (runtime.consolidationPhase === "reflector" || runtime.consolidationPhase === "dropper") runtime.cancelConsolidation();
	});
	pi.registerCommand("om:retry", {
		description: "手动重试当前暂停的观察批次；不重置反思和清理额度",
		handler: async (_args, ctx) => {
			if (!ctx.isIdle() || runtime.consolidationInFlight) {
				ctx.ui.notify("观察式记忆：请等待当前任务结束后再重试", "warning");
				return;
			}
			await maybeLaunchConsolidation(pi, runtime, ctx, true);
		},
	});
}

function debugSessionMetadata(ctx: LiveCtx): { sessionId?: string; sessionFile?: string } {
	try {
		return {
			sessionId: ctx.sessionManager.getSessionId?.(),
			sessionFile: ctx.sessionManager.getSessionFile?.(),
		};
	} catch (error) {
		recordDiagnosticError("context.metadata_error", error);
		return {};
	}
}

function maybeLaunchConsolidation(pi: ExtensionAPI, runtime: Runtime, ctx: LiveCtx, retryObserver = false): Promise<void> | undefined {
	runtime.ensureConfig(ctx.cwd);
	if (runtime.config.passive === true && !retryObserver) return;
	if (runtime.consolidationInFlight) return;

	const entries = ctx.sessionManager.getBranch() as Entry[];
	const currentTokens = rawContextTokens(ctx);
	if (!retryObserver && !anyStageDue(entries, runtime, currentTokens)) return;

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
	return runtime.launchConsolidationTask(ctx, async (signal) => withDebugLogContext({
		enabled: runtime.config.debugLog === true,
		cwd: ctx.cwd,
		...sessionMetadata,
		runId,
	}, async () => {
		await runConsolidationPipeline(pi, runtime, { ...consolidationCtx, signal }, retryObserver);
	}));
}

/** 距主动压缩不足一轮观察预算时，先追赶当前快照，不追逐持续增长的消息尾部。 */
function observationPriorityTarget(runtime: Runtime, ctx: ConsolidationCtx): string | undefined {
	const entries = ctx.sessionManager.getBranch() as Entry[];
	const contextWindow = (ctx.model as { contextWindow?: number } | undefined)?.contextWindow;
	const threshold = resolveCompactAfterTokens(runtime.config, contextWindow);
	if (runtime.tokenProgress.compactionProgress(entries) + runtime.config.observeAfterTokens < threshold) return;
	const cursor = observationProcessingState(entries);
	if (cursor.nextEntryIndex < 0 || maintenanceCanRun(entries, runtime, realContextTokens(runtime, ctx))
		|| workerAttempted(entries, "observer", entries[cursor.nextEntryIndex].id, cursor.startOffset)) return;
	return entries.at(-1)?.id;
}

export async function runConsolidationPipeline(pi: ExtensionAPI, runtime: Runtime, ctx: ConsolidationCtx, retryObserver = false): Promise<void> {
	if (!sessionActive(runtime, ctx)) return;
	const resolveModel = makeModelResolver(runtime, ctx);
	const stages = retryObserver ? ["observer"] as const : ["observer", "reflector", "dropper"] as const;
	for (const stage of stages) {
		if (!sessionActive(runtime, ctx)) return;
		runtime.consolidationPhase = stage;
		try {
			const target = retryObserver ? undefined : observationPriorityTarget(runtime, ctx);
			if (target) {
				runtime.consolidationPhase = "observer";
				let needsMaintenance = false;
				while (sessionActive(runtime, ctx)) {
					const entries = ctx.sessionManager.getBranch() as Entry[];
					const cursor = observationProcessingState(entries);
					const end = entries.findIndex((entry) => entry.id === target);
					if (cursor.nextEntryIndex < 0 || cursor.nextEntryIndex > end) break;
					if (await runObserverStage(pi, runtime, ctx, resolveModel, target, retryObserver) === "abort") return;
					if (!sessionActive(runtime, ctx)) return;
					// 不能为追赶持续扩张记忆池，挤掉反思与安全精简的输入预算。
					needsMaintenance = maintenanceCanRun(ctx.sessionManager.getBranch() as Entry[], runtime, realContextTokens(runtime, ctx));
					if (needsMaintenance) break;
				}
				if (!needsMaintenance) return;
				if (stage === "observer") continue;
				runtime.consolidationPhase = stage;
			}
			const outcome = stage === "observer" ? await runObserverStage(pi, runtime, ctx, resolveModel, undefined, retryObserver)
				: stage === "reflector" ? await runReflectorStage(pi, runtime, ctx, resolveModel)
				: await runDropperStage(pi, runtime, ctx, resolveModel);
			if (outcome === "abort") return;
			if (stage === "dropper" && sessionActive(runtime, ctx)) runtime.finishMaintenance(ctx.sessionManager.getBranch() as Entry[]);
		} catch (error) {
			// 会话已切换时，任何失败都属于正常收尾，不再触碰失效的 ctx 或提示用户。
			if (!sessionActive(runtime, ctx)) return;
			const failedStage = runtime.consolidationPhase ?? stage;
			let evidence: Record<string, unknown>;
			try {
				const entries = ctx.sessionManager.getBranch() as Entry[];
				const folded = foldLedger(entries);
				evidence = { branchEntries: entries.length, branchLeafId: entries.at(-1)?.id, activeObservations: folded.activeObservations.length, reflections: folded.reflections.length, observationTokens: observationPoolMetrics(folded.activeObservations, runtime.config.observationsPoolTargetTokens).observationTokens, cursor: observationProcessingState(entries), observerChunkMaxTokens: runtime.config.observerChunkMaxTokens };
			} catch { evidence = { contextCaptureFailed: true }; }
			debugLog(`${failedStage}.error`, { errorMessage: runtime.recordConsolidationStageError(ctx, failedStage, error, evidence) });
			if (failedStage === "observer") return;
			// 维护是可选增强；反思失败不妨碍清理，次数已在请求前落盘。
		}
	}
}

async function runObserverStage(
	pi: ExtensionAPI, runtime: Runtime, ctx: ConsolidationCtx,
	resolveModel: (stage: "observer") => Promise<ResolvedModel | undefined>,
	throughEntryId?: string,
	retryObserver = false,
): Promise<StageOutcome> {
	if (!sessionActive(runtime, ctx)) return "abort";
	const entries = ctx.sessionManager.getBranch() as Entry[];
	if (!throughEntryId && !retryObserver && !stageDue(runtime, entries, realContextTokens(runtime, ctx), "observations", runtime.config.observeAfterTokens)) return "continue";
	const cursor = observationProcessingState(entries);
	const end = throughEntryId ? entries.findIndex((entry) => entry.id === throughEntryId) + 1 : entries.length;
	if (cursor.nextEntryIndex < 0 || cursor.nextEntryIndex >= end) return "continue";
	if (!retryObserver && workerAttempted(entries, "observer", entries[cursor.nextEntryIndex].id, cursor.startOffset)) return "continue";
	const resolved = await resolveModel("observer");
	if (!resolved || !sessionActive(runtime, ctx)) return "abort";
	pi.appendEntry(OM_WORKER_ATTEMPTED, { stage: "observer", sourceEntryId: entries[cursor.nextEntryIndex].id, sourceOffset: cursor.startOffset });
	const memory = fullProjection(entries);
	const priorReflections = memory.reflections.map(reflectionToSummaryLine);
	const priorObservations = memory.observations.map(observationToSummaryLine);
	const maxChunkTokens = observerChunkBudget(resolved.model as any, priorReflections, priorObservations,
		resolveObserverChunkMaxTokens(runtime.config, (resolved.model as { contextWindow?: number }).contextWindow));
	const chunk = serializeSourceAddressedBranchEntries(entries.slice(cursor.nextEntryIndex, end), {
		maxTokens: maxChunkTokens, startOffset: cursor.startOffset,
	});
	if (!chunk.text || !chunk.sourceEntryIds.length) throw new Error("观察器输入预算不足，无法读取下一个源片段");
	if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(`观察式记忆：观察器正在处理约 ${chunk.estimatedTokens.toLocaleString()} token 的分块`, "info");
	debugLog("observer.start", { sourceEntryIds: chunk.sourceEntryIds, startSourceOffset: cursor.startOffset, chunkTokens: chunk.estimatedTokens });
	const result = await runObserver({
		onUsage: (message) => { try { publishUsage(pi.events, message); } catch (error) { recordDiagnosticError("usage.publish_error", error); } },
		model: resolved.model as any, apiKey: resolved.apiKey, headers: resolved.headers, env: resolved.env,
		priorReflections, priorObservations, chunk: chunk.text, allowedSourceEntryIds: chunk.sourceEntryIds,
		sourceOffset: cursor.startOffset, thinkingLevel: runtime.config.model?.thinking ?? "low", signal: ctx.signal,
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
	runtime.lastObserverError = undefined;
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
	if (workerAttempted(entries, "reflector")) return "continue";
	const cycleId = workerCycleId(entries);
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
	pi.appendEntry(OM_WORKER_ATTEMPTED, { stage: "reflector" });
	const result = await runReflector({
		onUsage: (message) => { try { publishUsage(pi.events, message); } catch (error) { recordDiagnosticError("usage.publish_error", error); } },
		model: resolved.model as any, apiKey: resolved.apiKey, headers: resolved.headers, env: resolved.env,
		reflections: folded.reflections, observations: folded.activeObservations,
		thinkingLevel: runtime.config.model?.thinking ?? "low", signal: ctx.signal,
	});
	if (!sessionActive(runtime, ctx) || workerCycleId(ctx.sessionManager.getBranch() as Entry[]) !== cycleId) return "abort";
	if (!result) throw new Error("反思器未返回审阅结果");
	const data = buildReflectionsRecordedData(result.reflections, observationCoverageId, result.retirements, result.reviewedObservationIds);
	if (!data) throw new Error("反思维护记录非法");
	if (!sessionActive(runtime, ctx)) return "abort";
	pi.appendEntry(OM_REFLECTIONS_RECORDED, data);
	runtime.lastReflectorError = undefined;
	debugLog("reflector.appended", { added: result.reflections.length, retired: result.retirements.length, coversUpToId: observationCoverageId });
	return "continue";
}

async function runDropperStage(
	pi: ExtensionAPI, runtime: Runtime, ctx: ConsolidationCtx,
	resolveModel: (stage: "dropper") => Promise<ResolvedModel | undefined>,
): Promise<StageOutcome> {
	if (!sessionActive(runtime, ctx)) return "abort";
	const entries = ctx.sessionManager.getBranch() as Entry[];
	if (workerAttempted(entries, "dropper")) return "continue";
	const cycleId = workerCycleId(entries);
	const folded = foldLedger(entries);
	const metrics = observationPoolMetrics(folded.activeObservations, runtime.config.observationsPoolTargetTokens);
	if (!metrics.ready) return "continue";
	const coverageId = latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED);
	if (!coverageId) return "continue";
	const resolved = await resolveModel("dropper");
	if (!resolved || !sessionActive(runtime, ctx)) return "abort";
	if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(`观察式记忆：精简器正在检查——活跃观察池约 ${metrics.observationTokens.toLocaleString()} / ${metrics.targetTokens.toLocaleString()} 目标 token`, "info");
	debugLog("dropper.start", metrics);
	pi.appendEntry(OM_WORKER_ATTEMPTED, { stage: "dropper" });
	const drops = await runDropper({
		onUsage: (message) => { try { publishUsage(pi.events, message); } catch (error) { recordDiagnosticError("usage.publish_error", error); } },
		model: resolved.model as any, apiKey: resolved.apiKey, headers: resolved.headers, env: resolved.env,
		reflections: folded.reflections, observations: folded.activeObservations, targetTokens: runtime.config.observationsPoolTargetTokens,
		thinkingLevel: runtime.config.model?.thinking ?? "low", signal: ctx.signal,
	});
	if (!sessionActive(runtime, ctx) || workerCycleId(ctx.sessionManager.getBranch() as Entry[]) !== cycleId) return "abort";
	if (!drops) throw new Error("精简器缺少完成回执");
	if (!drops.length) { runtime.lastDropperError = undefined; return "continue"; }
	const data = buildObservationsDroppedData(drops.map((item) => item.observationId), coverageId, drops);
	if (!data) throw new Error("精简记录非法");
	if (!sessionActive(runtime, ctx)) return "abort";
	pi.appendEntry(OM_OBSERVATIONS_DROPPED, data);
	runtime.lastDropperError = undefined;
	debugLog("dropper.appended", { count: drops.length, coversUpToId: coverageId });
	return "continue";
}
