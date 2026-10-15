import type { ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import type { Runtime } from "../runtime.js";
import { buildCompactionProjection, hasProcessedSourcePrefix, renderSummary, type Entry } from "../session-ledger/index.js";

export function registerCompactionHook(pi: ExtensionAPI, runtime: Runtime): void {
	pi.on("session_before_compact", async (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => {
		if (runtime.compactHookInFlight) {
			if (ctx.hasUI) ctx.ui.notify("观察式记忆：已有压缩正在进行，取消重复请求", "warning");
			return { cancel: true };
		}
		runtime.compactHookInFlight = true;
		try {
			runtime.ensureConfig(ctx.cwd);
			const entries = event.branchEntries as Entry[];
			const { firstKeptEntryId, tokensBefore } = event.preparation;
			// 用户指定摘要重点或历史尚未完整处理时，沿用 Pi 原生摘要，不用旧记忆冒充完整覆盖。
			if (event.customInstructions || !hasProcessedSourcePrefix(entries, firstKeptEntryId)) {
				if (ctx.hasUI) ctx.ui.notify("观察式记忆：本次交由 Pi 原生压缩（指定了摘要重点或存在未处理历史）", "info");
				return;
			}
			const projection = buildCompactionProjection(entries, firstKeptEntryId);
			const summary = renderSummary(projection.reflections, projection.observations);
			if (!summary) return;
			return { compaction: { summary, firstKeptEntryId, tokensBefore, details: projection.details } };
		} finally {
			runtime.compactHookInFlight = false;
		}
	});
}
