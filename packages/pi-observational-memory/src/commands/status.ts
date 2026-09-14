import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { observationPoolMetrics } from "../agents/dropper/pool.js";
import { resolveCompactAfterTokens } from "../config.js";
import { CONSOLIDATION_PHASE_LABELS, type Runtime } from "../runtime.js";
import {
	diffProjection,
	foldLedger,
	fullProjection,
	rawTokensSinceLastCompaction,
	rawTokensSinceObservationCoverage,
	rawTokensSinceReflectionCoverage,
	visibleProjection,
	type Entry,
} from "../session-ledger/index.js";

function pct(current: number, total: number): number {
	return total > 0 ? Math.round((current / total) * 100) : 0;
}

function tokenSum(items: { tokenCount: number }[]): number {
	return items.reduce((sum, item) => sum + item.tokenCount, 0);
}

function addedSuffix(count: number): string | undefined {
	return count > 0 ? `+${count.toLocaleString()}` : undefined;
}

function removedSuffix(count: number): string | undefined {
	return count > 0 ? `-${count.toLocaleString()}` : undefined;
}

function appendSuffixes(line: string, suffixes: (string | undefined)[]): string {
	const rendered = suffixes.filter((suffix): suffix is string => suffix !== undefined);
	return rendered.length > 0 ? `${line} ${rendered.join(" ")}` : line;
}

export function registerStatusCommand(pi: ExtensionAPI, runtime: Runtime): void {
	pi.registerCommand("om:status", {
		description: "查看观察式记忆状态",
		handler: async (_args, ctx) => {
			runtime.ensureConfig(ctx.cwd);
			const entries = ctx.sessionManager.getBranch() as Entry[];
			const folded = foldLedger(entries);
			const visible = visibleProjection(entries);
			const full = fullProjection(entries);
			const drift = diffProjection(visible, full);

			const visibleObservationTokens = tokenSum(visible.observations);
			const visibleReflectionTokens = tokenSum(visible.reflections);
			const activeObservationPool = observationPoolMetrics(folded.activeObservations, runtime.config.observationsPoolTargetTokens);
			const observationLine = appendSuffixes(
				`观察：已记录 ${folded.observations.length} / 已精简 ${folded.droppedObservationIds.size} / 活跃 ${folded.activeObservations.length} / 可见 ${visible.observations.length}`,
				[
					addedSuffix(drift.observationsOnlyInFull.length),
					removedSuffix(drift.droppedOnlyInFull.length),
				],
			);
			const reflectionLine = appendSuffixes(
				`反思：已记录 ${folded.reflections.length} / 可见 ${visible.reflections.length}`,
				[addedSuffix(drift.reflectionsOnlyInFull.length)],
			);
			const obsProgress = rawTokensSinceObservationCoverage(entries);
			const reflectionProgress = rawTokensSinceReflectionCoverage(entries);
			const compactionProgress = rawTokensSinceLastCompaction(entries);
			const contextWindow = typeof ctx.model?.contextWindow === "number" ? ctx.model.contextWindow : undefined;
			const compactThreshold = resolveCompactAfterTokens(runtime.config, contextWindow);

			const passiveLines = runtime.config.passive === true
				? [
					"── 模式 ──",
					"被动模式：自动记忆 worker 与自动压缩已禁用；手动/Pi 压缩、命令和 recall 仍可用",
					"",
				]
				: [];

			const lines = [
				...passiveLines,
				"── 记忆 ──",
				observationLine,
				reflectionLine,
				"",
				"── 进度 ──",
				`下次观察：~${obsProgress.toLocaleString()} / ${runtime.config.observeAfterTokens.toLocaleString()} token（${pct(obsProgress, runtime.config.observeAfterTokens)}%）`,
				`下次反思：~${reflectionProgress.toLocaleString()} / ${runtime.config.reflectAfterTokens.toLocaleString()} token（${pct(reflectionProgress, runtime.config.reflectAfterTokens)}%）`,
				`下次压缩：~${compactionProgress.toLocaleString()} / ${compactThreshold.toLocaleString()} 估算源 token（${pct(compactionProgress, compactThreshold)}%）`,
				`可见观察池：~${visibleObservationTokens.toLocaleString()} / ${runtime.config.observationsPoolMaxTokens.toLocaleString()} token（${pct(visibleObservationTokens, runtime.config.observationsPoolMaxTokens)}%）`,
				`活跃观察池：~${activeObservationPool.observationTokens.toLocaleString()} / ${runtime.config.observationsPoolTargetTokens.toLocaleString()} 目标 token（${pct(activeObservationPool.observationTokens, runtime.config.observationsPoolTargetTokens)}%）`,
				`反思池：~${visibleReflectionTokens.toLocaleString()} token`,
			];

			if (runtime.consolidationInFlight || runtime.compactInFlight || runtime.compactHookInFlight) {
				lines.push("", "── 进行中 ──");
				if (runtime.consolidationInFlight) {
					const phase = runtime.consolidationPhase ? `（${CONSOLIDATION_PHASE_LABELS[runtime.consolidationPhase]}）` : "";
					lines.push(`记忆整理：运行中${phase}`);
				}
				if (runtime.compactInFlight) lines.push("自动压缩：运行中");
				if (runtime.compactHookInFlight) lines.push("压缩钩子：运行中");
			}

			if (runtime.lastObserverError || runtime.lastReflectorError || runtime.lastDropperError) {
				lines.push("", "── 最近错误 ──");
				if (runtime.lastObserverError) lines.push(`观察器：${runtime.lastObserverError}`);
				if (runtime.lastReflectorError) lines.push(`反思器：${runtime.lastReflectorError}`);
				if (runtime.lastDropperError) lines.push(`精简器：${runtime.lastDropperError}`);
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
