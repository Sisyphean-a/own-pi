import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { debugLog } from "../debug-log.js";

/**
 * 把 agent 循环事件流中的 LLM 失败暴露出来。
 *
 * 底层 LLM 调用失败时，循环会用一条 stopReason 为 "error"（或 "aborted"）的最终助手消息
 * 结束事件流——不会抛异常。没有这个钩子，排空循环会把这类运行完全当成“模型选择不调用
 * 工具”，从而把真实原因（限流、提示词过大、认证失败等）从调试日志中隐藏掉。
 */
export function logAgentStreamError(stage: "observer" | "reflector" | "dropper", event: AgentEvent): void {
	if (event.type !== "message_end") return;
	const message = event.message;
	if (message.role !== "assistant") return;
	if (message.stopReason !== "error" && message.stopReason !== "aborted") return;
	debugLog(`${stage}.stream_error`, {
		stopReason: message.stopReason,
		errorMessage: message.errorMessage,
	});
}
