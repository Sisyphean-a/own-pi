import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { recordDiagnosticError, withDebugLogContext, type DebugLogContext } from "./debug-log.js";

type Handler = (...args: any[]) => any;

function observed(operation: string, handler: Handler, contextIndex: number, getEpoch: () => number): Handler {
	return (...args) => {
		const ctx = args[contextIndex] as ExtensionContext | undefined;
		const epoch = getEpoch();
		let notify: ((message: string) => void) | undefined;
		const metadata: DebugLogContext = { enabled: false, runId: randomUUID() };
		try {
			if (ctx?.hasUI) { const ui = ctx.ui; notify = (message) => ui.notify(message, "warning"); }
			metadata.cwd = ctx?.cwd;
			metadata.sessionId = ctx?.sessionManager?.getSessionId?.();
			metadata.sessionFile = ctx?.sessionManager?.getSessionFile?.();
		} catch { /* 会话已作废时，仍记录原始异常，不为诊断再次访问旧 ctx。 */ }
		return withDebugLogContext(metadata, () => {
			const failed = (error: unknown): never => {
				const reference = recordDiagnosticError("extension.error", error, { operation });
				if (reference.writeError && getEpoch() === epoch) {
					try { notify?.(`观察式记忆：诊断日志写入失败：${reference.writeError}`); } catch { /* 诊断提示不得替换原始异常。 */ }
				}
				throw error;
			};
			try {
				const result = handler(...args);
				return result && typeof result.then === "function" ? Promise.resolve(result).catch(failed) : result;
			} catch (error) { return failed(error); }
		});
	};
}

/** 统一兜住本插件事件、命令和 recall 的未捕获异常，保留同步返回值及原始异常身份。 */
export function withDiagnosticBoundary(pi: ExtensionAPI, getEpoch: () => number = () => 0): ExtensionAPI {
	return new Proxy(pi, {
		get(target, key, receiver) {
			if (key === "on") return (event: string, handler: Handler) => (target.on as Handler)(event, observed(`event:${event}`, handler, 1, getEpoch));
			if (key === "registerCommand") return (name: string, command: { handler: Handler }) =>
				target.registerCommand(name, { ...command, handler: observed(`command:${name}`, command.handler, 1, getEpoch) });
			if (key === "registerTool") return (tool: { name: string; execute: Handler }) =>
				(target.registerTool as Handler)({ ...tool, execute: observed(`tool:${tool.name}`, tool.execute, 4, getEpoch) });
			return Reflect.get(target, key, receiver);
		},
	});
}
