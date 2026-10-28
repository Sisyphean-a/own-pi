import { estimateTokens, findCutPoint, SettingsManager, type ExtensionAPI, type SessionEntry, type TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { resolveCompactAfterTokens } from "../config.js";
import { diagnosticNotice, recordDiagnosticError } from "../debug-log.js";
import { isStaleSessionError } from "../runtime.js";
import { buildCompactionProjection, hasProcessedSourcePrefix, observationProcessingState, renderSummary, type Entry } from "../session-ledger/index.js";
import type { Runtime } from "../runtime.js";

export function registerCompactionTrigger(pi: ExtensionAPI, runtime: Runtime): void {
	pi.on("turn_end", (event, ctx) => {
		runtime.ensureConfig(ctx.cwd);
		if (runtime.config.passive || runtime.compactInFlight || runtime.compactHookInFlight) return;
		// 不覆盖其他扩展的提案，也不介入 Pi 的失败、截断或取消恢复。
		if (ctx.signal?.aborted || event.outcome !== "completed" || (event.message.role === "assistant" && event.message.stopReason === "length") || event.entries.length > 0) return;
		if (!event.context?.contextEntries || typeof pi.getSettings !== "function") return;
		const entries = ctx.sessionManager.getBranch() as Entry[];
		const contextWindow = ctx.model?.contextWindow;
		if (runtime.tokenProgress.compactionProgress(entries) < resolveCompactAfterTokens(runtime.config, contextWindow)) return;
		try {
			const settings = SettingsManager.inMemory(pi.getSettings()).getCompactionSettings(ctx.model);
			const compaction = readyCompaction(event, entries, settings.keepRecentTokens);
			if (!compaction) return;
			// 回合边界提交 compaction 不触发 session_compact；先终止旧周期维护，观察尾部仍可继续。
			if (runtime.consolidationPhase === "reflector" || runtime.consolidationPhase === "dropper") runtime.cancelConsolidation();
			if (runtime.config.showWorkerNotifications && ctx.hasUI) ctx.ui.notify("观察式记忆：已在回合边界折叠已处理历史，未处理消息原样保留", "info");
			return { entries: [compaction] };
		} catch (error) {
			const reference = recordDiagnosticError("compaction.error", error, { boundary: "turn_end" });
			runtime.lastDiagnostic = reference;
			if (runtime.config.showWorkerNotifications && ctx.hasUI) ctx.ui.notify(`观察式记忆：回合边界压缩失败：${diagnosticNotice(error, reference)}`, "warning");
		}
	});

	// Pi 只在重试、自动压缩和排队续跑都完成后才发出 agent_settled，因此重试策略仍由 Pi 拥有。
	pi.on("agent_settled", (_event, ctx) => {
		runtime.ensureConfig(ctx.cwd);
		if (runtime.config.passive === true) return;
		if (runtime.compactInFlight) return;

		const entries = ctx.sessionManager?.getBranch?.() as Entry[] | undefined;
		if (!entries) return;
		const progress = runtime.tokenProgress.compactionProgress(entries);
		const contextWindow = typeof ctx.model?.contextWindow === "number" ? ctx.model.contextWindow : undefined;
		const threshold = resolveCompactAfterTokens(runtime.config, contextWindow);
		if (progress < threshold) return;

		// 同步捕获 ctx 属性——下面的 setTimeout 和异步工作可能比扩展 ctx 活得更久
		// （会话替换/重载后会失效）。
		const hasUI = runtime.config.showWorkerNotifications && ctx.hasUI;
		const ui = ctx.ui;
		const epoch = runtime.sessionEpoch;
		const sessionCurrent = () => runtime.isSessionCurrent(epoch);

		if (hasUI) ui?.notify(
			`观察式记忆：已达压缩阈值（约 ${progress.toLocaleString()} 估算源 token），开始触发压缩`,
			"info",
		);

		runtime.compactInFlight = true;
		setTimeout(() => {
			try {
				// 会话已被替换/重载：旧 ctx 已失效，直接放弃这次延迟压缩。
				if (!sessionCurrent()) {
					runtime.compactInFlight = false;
					return;
				}
				if (!ctx.isIdle()) {
					runtime.compactInFlight = false;
					if (hasUI) ui?.notify(
						"观察式记忆：压缩已延后——代理在压缩前变为忙碌",
						"info",
					);
					return;
				}
				const currentEntries = ctx.sessionManager?.getBranch?.() as Entry[] | undefined;
				if (!currentEntries) {
					runtime.compactInFlight = false;
					return;
				}
				const currentProgress = runtime.tokenProgress.compactionProgress(currentEntries);
				if (currentProgress < threshold) {
					runtime.compactInFlight = false;
					if (hasUI) ui?.notify(
						"观察式记忆：压缩已跳过——延迟压缩前已有其他压缩完成",
						"info",
					);
					return;
				}
				if (!sessionCurrent()) {
					runtime.compactInFlight = false;
					return;
				}
				ctx.compact({
					onComplete: () => {
						runtime.compactInFlight = false;
						if (hasUI && sessionCurrent()) ui?.notify("观察式记忆：压缩完成", "info");
					},
					onError: (error: { message: string }) => {
						runtime.compactInFlight = false;
						if (error.message === "Compaction cancelled") {
							// 返回 { cancel: true } 之前已用真实原因通知过用户。
							return;
						}
						const reference = recordDiagnosticError("compaction.error", error, { boundary: "idle" });
						runtime.lastDiagnostic = reference;
						if (hasUI && sessionCurrent()) ui?.notify(`观察式记忆：${diagnosticNotice(error, reference)}`, "error");
					},
				});
			} catch (error) {
				const reference = recordDiagnosticError("compaction.error", error, { boundary: "deferred" });
				runtime.lastDiagnostic = reference;
				runtime.compactInFlight = false;
				const msg = diagnosticNotice(error, reference);
				// 会话替换/重载导致的 stale 错误属于正常收尾，不打扰用户。
				if (!isStaleSessionError(error) && hasUI && sessionCurrent()) {
					ui?.notify(`观察式记忆：压缩调用抛出异常：${msg}`, "error");
				}
			}
		}, 0);
	});
}

/** 只折叠已提交记忆覆盖的可见前缀；用宿主切点规则保留工具调用与结果的完整配对。 */
function readyCompaction(event: TurnEndEvent, entries: Entry[], keepRecentTokens: number) {
	const projected: SessionEntry[] = event.context.contextEntries.flatMap(({ sourceEntry, messages }) =>
		messages.map((message) => sourceEntry.type === "compaction" ? sourceEntry : { ...sourceEntry, type: "message" as const, message })
	);
	if (projected.length === 0) return;
	const indexes = new Map(entries.map((entry, index) => [entry.id, index]));
	const { nextEntryIndex } = observationProcessingState(entries);
	const firstPending = nextEntryIndex < 0 ? -1 : projected.findIndex((entry) => (indexes.get(entry.id) ?? -1) >= nextEntryIndex);
	const recentCut = findCutPoint(projected, 0, projected.length, keepRecentTokens).firstKeptEntryIndex;
	const coveredCut = firstPending < 0 ? recentCut : findCutPoint(projected, 0, firstPending + 1, 0).firstKeptEntryIndex;
	const cut = Math.min(recentCut, coveredCut);
	if (cut <= 0) return;
	const firstKeptEntryId = projected[cut].id;
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].type !== "compaction") continue;
		if (entries[i].firstKeptEntryId === firstKeptEntryId) return;
		break;
	}
	if (!hasProcessedSourcePrefix(entries, firstKeptEntryId)) return;
	const projection = buildCompactionProjection(entries, firstKeptEntryId);
	const summary = renderSummary(projection.reflections, projection.observations);
	if (!summary) return;
	const removedTokens = event.context.contextEntries
		.filter(({ sourceEntry }) => (indexes.get(sourceEntry.id) ?? Infinity) < indexes.get(firstKeptEntryId)!)
		.reduce((total, { messages }) => total + messages.reduce((sum, message) => sum + estimateTokens(message), 0), 0);
	// 摘要比待替换内容还大时，不重建上下文或制造无收益的压缩。
	if (estimateTokens({ role: "user", content: summary, timestamp: 0 }) >= removedTokens) return;
	return { type: "compaction" as const, summary, firstKeptEntryId, details: projection.details };
}
