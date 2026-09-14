import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Runtime } from "../runtime.js";
import { copyTextToClipboard } from "../clipboard.js";
import {
	fullProjection,
	observationToSummaryLine,
	reflectionToSummaryLine,
	visibleProjection,
	type Entry,
	type Projection,
} from "../session-ledger/index.js";

function firstArg(args: unknown): string | undefined {
	if (Array.isArray(args)) return typeof args[0] === "string" ? args[0] : undefined;
	if (typeof args === "string") return args.trim().split(/\s+/)[0];
	if (args && typeof args === "object" && "mode" in args) {
		const mode = (args as { mode?: unknown }).mode;
		return typeof mode === "string" ? mode : undefined;
	}
	return undefined;
}

function renderList<T>(items: T[], render: (item: T) => string, empty: string): string {
	return items.length > 0 ? items.map(render).join("\n") : empty;
}

function renderContentOnlyProjection(projection: Projection, emptyScope: "visible" | "recorded"): string {
	const scope = emptyScope === "visible" ? "可见" : "已记录";
	return [
		"── 反思 ──",
		renderList(projection.reflections, reflectionToSummaryLine, `暂无${scope}反思。`),
		"",
		"── 观察 ──",
		renderList(projection.observations, observationToSummaryLine, `暂无${scope}观察。`),
	].join("\n");
}

interface ViewCommandOptions {
	copyToClipboard?: (text: string) => Promise<boolean>;
}

export function registerViewCommand(pi: ExtensionAPI, runtime: Runtime, options: ViewCommandOptions = {}): void {
	const copyToClipboard = options.copyToClipboard ?? copyTextToClipboard;

	pi.registerCommand("om:view", {
		description: "打印并复制观察式记忆内容（默认可见范围，full 为全部已记录记忆）",
		handler: async (args, ctx) => {
			runtime.ensureConfig(ctx.cwd);
			const entries = ctx.sessionManager.getBranch() as Entry[];
			const mode = firstArg(args);

			const notifyWithCopy = async (output: string) => {
				const copied = await copyToClipboard(output).catch(() => false);
				ctx.ui.notify(
					copied
						? `${output}\n\n已复制 /om:view 输出到剪贴板。`
						: `${output}\n\n警告：复制 /om:view 输出到剪贴板失败。`,
					"info",
				);
			};

			if (mode === "full") {
				await notifyWithCopy(renderContentOnlyProjection(fullProjection(entries), "recorded"));
				return;
			}

			if (mode && mode !== "visible") {
				ctx.ui.notify("用法：/om:view [full]", "info");
				return;
			}

			await notifyWithCopy(renderContentOnlyProjection(visibleProjection(entries), "visible"));
		},
	});
}
