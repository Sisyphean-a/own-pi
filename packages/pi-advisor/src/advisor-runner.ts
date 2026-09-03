import { agentLoop, type AgentMessage, type AgentTool, type AgentLoopConfig } from "@earendil-works/pi-agent-core";
import type { Message, Model, TextContent, ThinkingContent, ThinkingLevel } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAdvisorTools, summarizeAdvisorToolCall } from "./advisor-tools.ts";

const MAX_ADVISOR_TURNS = 6;
const MAX_ADVISOR_TOOL_CALLS = 12;

export interface AdvisorRunResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  stopReason?: string;
  errorMessage?: string;
  toolUses: Array<{ name: string; summary: string; isError: boolean }>;
}

interface RunAdvisorOptions {
  model: Model<any>;
  apiKey?: string;
  headers?: Record<string, string>;
  messages: Message[];
  systemPrompt: string;
  maxTokens: number;
  reasoning: ThinkingLevel;
  sessionId?: string;
  signal?: AbortSignal;
  maxTurns?: number;
  pi: ExtensionAPI;
  cwd: string;
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
  let toolCallCount = 0;
  const tools = createAdvisorTools(options.pi, options.cwd, () => {
    toolCallCount++;
    if (toolCallCount > MAX_ADVISOR_TOOL_CALLS) {
      throw new Error(`Advisor tool-call limit reached (${MAX_ADVISOR_TOOL_CALLS})`);
    }
  }) as AgentTool[];
  const context = {
    systemPrompt: options.systemPrompt,
    messages: [],
    tools,
  };
  const maxTurns = options.maxTurns && options.maxTurns > 0 ? options.maxTurns : MAX_ADVISOR_TURNS;
  let turnCount = 0;
  const config: AgentLoopConfig = {
    model: options.model,
    apiKey: options.apiKey,
    headers: options.headers,
    maxTokens: options.maxTokens,
    reasoning: options.reasoning,
    sessionId: options.sessionId,
    convertToLlm: (messages) => messages as Message[],
    toolExecution: "sequential",
    shouldStopAfterTurn: () => {
      turnCount++;
      return turnCount >= maxTurns;
    },
  };

  const loop = options.agentLoop ?? agentLoop;
  const stream = loop(
    options.messages as unknown as AgentMessage[],
    context,
    config,
    options.signal,
    streamSimple,
  );
  const pending = new Map<string, string>();
  const toolUses: AdvisorRunResult["toolUses"] = [];

  for await (const event of stream) {
    if (event.type === "tool_execution_start") {
      pending.set(event.toolCallId, summarizeAdvisorToolCall(event.toolName, event.args));
    } else if (event.type === "tool_execution_end") {
      toolUses.push({
        name: event.toolName,
        summary: pending.get(event.toolCallId) ?? event.toolName,
        isError: event.isError,
      });
      pending.delete(event.toolCallId);
    }
  }

  const messages = await stream.result();
  const assistants = assistantResults(messages);
  const result = assistants.at(-1);
  const { text, thinking } = textFromAssistant(result);
  const errorMessage = typeof result?.errorMessage === "string" ? result.errorMessage : undefined;
  const stopReason = typeof result?.stopReason === "string" ? result.stopReason : undefined;

  return {
    text: text || (thinking ? `(thinking)\n${thinking}` : ""),
    inputTokens: assistants.reduce((total, assistant) => total + numericUsage(assistant.usage?.input), 0),
    outputTokens: assistants.reduce((total, assistant) => total + numericUsage(assistant.usage?.output), 0),
    stopReason,
    errorMessage,
    toolUses,
  };
}
