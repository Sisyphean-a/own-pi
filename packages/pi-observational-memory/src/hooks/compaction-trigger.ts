import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveCompactAfterTokens } from "../config.js";
import { isStaleSessionError } from "../runtime.js";
import { rawTokensSinceLastCompaction, type Entry } from "../session-ledger/index.js";
import type { Runtime } from "../runtime.js";

export function registerCompactionTrigger(pi: ExtensionAPI, runtime: Runtime): void {
	// Pi 只在重试、自动压缩和排队续跑都完成后才发出 agent_settled，因此重试策略仍由 Pi 拥有。
	pi.on("agent_settled", (_event, ctx) => {
		runtime.ensureConfig(ctx.cwd);
		if (runtime.config.passive === true) return;
		if (runtime.compactInFlight) return;

		const entries = ctx.sessionManager?.getBranch?.() as Entry[] | undefined;
		if (!entries) return;
		const progress = rawTokensSinceLastCompaction(entries);
		const contextWindow = typeof ctx.model?.contextWindow === "number" ? ctx.model.contextWindow : undefined;
		const threshold = resolveCompactAfterTokens(runtime.config, contextWindow);
		if (progress < threshold) return;

		// 同步捕获 ctx 属性——下面的 setTimeout 和异步工作可能比扩展 ctx 活得更久
		// （会话替换/重载后会失效）。
		const hasUI = ctx.hasUI;
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
				const currentProgress = rawTokensSinceLastCompaction(currentEntries);
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
						if (hasUI && sessionCurrent()) ui?.notify(`观察式记忆：${error.message}`, "error");
					},
				});
			} catch (error) {
				runtime.compactInFlight = false;
				const msg = error instanceof Error ? error.message : String(error);
				// 会话替换/重载导致的 stale 错误属于正常收尾，不打扰用户。
				if (!isStaleSessionError(error) && hasUI && sessionCurrent()) {
					ui?.notify(`观察式记忆：压缩调用抛出异常：${msg}`, "error");
				}
			}
		}, 0);
	});
}
