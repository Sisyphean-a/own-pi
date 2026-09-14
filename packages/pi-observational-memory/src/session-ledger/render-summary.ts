import type { Observation, Reflection } from "./types.js";

const CONTEXT_USAGE_INSTRUCTIONS = `这些是本次会话早些时候的压缩记忆。

- 反思：关于用户、项目、决定和约束的稳定长期事实。新的反思行可能带有方括号 id。
- 观察：来自对话历史的带时间戳事件，按时间顺序排列。观察行带有方括号 id。

把它们当作过往记录。条目冲突时，最近的观察反映最新已知状态。先前观察标记为已完成的工作不要重做，除非用户明确要求重新处理。

需要精确或可追溯的源上下文时，用相关观察或反思 id 调用 recall 工具。当某条反思实质影响决定，或压缩过度而无法有把握地继续时，尤其有用。不要用 recall 做宽泛搜索，也不要在不需要时注入原始源内容。`;

export function observationToSummaryLine(observation: Observation): string {
	return `[${observation.id}] ${observation.timestamp} [${observation.relevance}] ${observation.content}`;
}

export function reflectionToSummaryLine(reflection: Reflection): string {
	return `[${reflection.id}] ${reflection.content}`;
}

export function renderSummary(reflections: Reflection[], observations: Observation[]): string {
	if (reflections.length === 0 && observations.length === 0) return "";

	const parts: string[] = [CONTEXT_USAGE_INSTRUCTIONS];
	if (reflections.length > 0) {
		parts.push(`## 反思\n${reflections.map(reflectionToSummaryLine).join("\n")}`);
	}
	if (observations.length > 0) {
		parts.push(`## 观察\n${observations.map(observationToSummaryLine).join("\n")}`);
	}
	return parts.join("\n\n");
}
