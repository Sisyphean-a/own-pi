import type { AgentContext, AgentTool } from "@earendil-works/pi-agent-core";
import { createInitialSystemMessage, toToolDeclaration } from "@earendil-works/pi-ai";

/** Pi 0.86 的低层 agent loop 从 transcript system message 读取提示词和工具声明。 */
export function createAgentContext(
	systemPrompt: string,
	tools: AgentTool<any>[],
): AgentContext {
	const systemMessage = createInitialSystemMessage(
		systemPrompt,
		tools.map(toToolDeclaration),
	);
	return {
		messages: systemMessage ? [systemMessage] : [],
		tools,
	};
}
