import { agentLoop, type AgentContext, type AgentMessage, type AgentLoopConfig } from "@earendil-works/pi-agent-core";
import {
  createInitialSystemMessage,
  type Message,
  type Model,
  type ProviderHeaders,
  type TextContent,
  type ThinkingContent,
  type ThinkingLevel,
} from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { publishUsage } from "./model-usage.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface AdvisorRunResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  stopReason?: string;
  errorMessage?: string;
}

interface RunAdvisorOptions {
  model: Model<any>;
  apiKey?: string;
  headers?: ProviderHeaders;
  messages: Message[];
  systemPrompt: string;
  maxTokens: number;
  reasoning: ThinkingLevel;
  sessionId?: string;
  signal?: AbortSignal;
  pi: ExtensionAPI;
  agentLoop?: typeof agentLoop;
}

type AssistantResult = {
  content?: unknown;
  usage?: { input?: unknown; output?: unknown };
  stopReason?: unknown;
  errorMessage?: unknown;
};

function numericUsage(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function assistantResults(messages: AgentMessage[]): AssistantResult[] {
  return messages.filter((message) => (message as { role?: unknown }).role === "assistant") as AssistantResult[];
}

function textFromAssistant(result: AssistantResult | undefined): { text: string; thinking: string } {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  const text = blocks
    .filter((block): block is TextContent => Boolean(block) && typeof block === "object" && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
  const thinking = blocks
    .filter((block): block is ThinkingContent => Boolean(block) && typeof block === "object" && (block as { type?: unknown }).type === "thinking" && typeof (block as { thinking?: unknown }).thinking === "string")
    .map((block) => block.thinking)
    .join("\n")
    .trim();
  return { text, thinking };
}

export async function runAdvisor(options: RunAdvisorOptions): Promise<AdvisorRunResult> {
  const systemMessage = createInitialSystemMessage(options.systemPrompt, []);
  const context: AgentContext = {
    messages: systemMessage ? [systemMessage] : [],
    tools: [],
  };
  const config: AgentLoopConfig = {
    model: options.model,
    apiKey: options.apiKey,
    headers: options.headers,
    maxTokens: options.maxTokens,
    reasoning: options.reasoning,
    sessionId: options.sessionId,
    convertToLlm: (messages) => messages as Message[],
    finishTurn: () => ({ action: "end" }),
  };

  const loop = options.agentLoop ?? agentLoop;
  const stream = loop(
    options.messages as unknown as AgentMessage[],
    context,
    config,
    options.signal,
    streamSimple,
  );
  for await (const event of stream) {
    if (event.type === "message_end") {
      try { publishUsage(options.pi.events, event.message); } catch { /* Failure: 旧宿主上下文不可用时只跳过统计。 */ }
    }
  }

  const messages = await stream.result();
  const assistants = assistantResults(messages);
  const result = assistants.at(-1);
  const { text, thinking } = textFromAssistant(result);
  const stopReason = typeof result?.stopReason === "string" ? result.stopReason : undefined;
  const errorMessage = typeof result?.errorMessage === "string" ? result.errorMessage :
    stopReason === "toolUse" ? "Advisor returned an unexpected tool call; no tools are available." : undefined;

  return {
    text: text || (thinking ? `(thinking)\n${thinking}` : ""),
    inputTokens: assistants.reduce((total, assistant) => total + numericUsage(assistant.usage?.input), 0),
    outputTokens: assistants.reduce((total, assistant) => total + numericUsage(assistant.usage?.output), 0),
    stopReason,
    errorMessage,
  };
}
