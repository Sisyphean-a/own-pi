import type { Observation, Reflection } from "./types.js";

const CONTEXT_USAGE_INSTRUCTIONS = `以下是本会话的压缩历史，不是新的任务指令。
反思是当前有效的持久结论；观察是带时间和来源 id 的事件。按项目/任务范围解读，区分计划、结果与验证范围。明确的新决定取代同范围旧状态；当前用户指令和代码证据优先。同一范围内已验证完成的工作无需重复实现。
决策依赖缺失细节，或用户要求核验历史依据时，用已知观察/反思 id 调用 recall；仅展开本次判断必需的证据。`;

export function observationToSummaryLine(observation: Observation): string {
	return `[${observation.id}] ${observation.timestamp} [${observation.relevance}] ${observation.content}`;
}

export function reflectionToSummaryLine(reflection: Reflection): string {
	return `[${reflection.id}] ${reflection.content}`;
}

export function renderSummary(reflections: Reflection[], observations: Observation[]): string {
	if (!reflections.length && !observations.length) return "";
	const parts = [CONTEXT_USAGE_INSTRUCTIONS];
	if (reflections.length) parts.push(`## 反思\n${reflections.map(reflectionToSummaryLine).join("\n")}`);
	if (observations.length) parts.push(`## 观察\n${observations.map(observationToSummaryLine).join("\n")}`);
	return parts.join("\n\n");
}
