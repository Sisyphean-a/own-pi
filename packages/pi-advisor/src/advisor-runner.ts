import { agentLoop, type AgentContext, type AgentMessage, type AgentLoopConfig } from "@earendil-works/pi-agent-core";
import {
  createInitialSystemMessage,
  toToolDeclaration,
  type Message,
  type Model,
  type ProviderHeaders,
  type TextContent,
  type ThinkingLevel,
  type Usage,
} from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { createAdvisorReader, MAX_ADVISOR_READS, type AdvisorRead } from "./advisor-read.ts";
import { publishUsage } from "./model-usage.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const MAX_ADVISOR_TURNS = 6;

export interface AdvisorRunResult {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheWrite1hTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  usage?: Usage;
  durationMs: number;
  modelRequests: number;
  readCalls: number;
  stopReason?: string;
  errorMessage?: string;
}

interface RunAdvisorOptions {
  model: Model<any>;
  apiKey?: string;
  headers?: ProviderHeaders;
  messages: Message[];
  systemPrompt: string;
  cwd: string;
  read: AdvisorRead;
  maxTokens: number;
  reasoning: ThinkingLevel;
  timeoutMs: number;
  sessionId?: string;
  signal?: AbortSignal;
  pi: ExtensionAPI;
  agentLoop?: typeof agentLoop;
}

type AssistantResult = {
  role?: string;
  provider?: string;
  model?: string;
  durationMs?: number;
  content?: unknown;
  usage?: Partial<Usage>;
  stopReason?: string;
  errorMessage?: string;
};

function numericUsage(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function reportedUsage(message: AssistantResult): Partial<Usage> | undefined {
  const u = message.usage;
  // Rule: Pi 为失败响应初始化的全零计数不是供应商明确上报的零消耗。
  if ((message.stopReason === "error" || message.stopReason === "aborted") &&
    ![u?.input, u?.output, u?.cacheRead, u?.cacheWrite].some((value) => (numericUsage(value) ?? 0) > 0)) return undefined;
  return u;
}

export async function runAdvisor(options: RunAdvisorOptions): Promise<AdvisorRunResult> {
  const started = performance.now();
  const timeout = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal;
  const timer = setTimeout(() => timeout.abort(new Error("Advisor request timed out")), options.timeoutMs);
  const reader = createAdvisorReader(options.read);
  let modelRequests = 0;
  let result: AssistantResult | undefined;
  let failure: string | undefined;
  const usages: Array<Partial<Usage> | undefined> = [];
  const record = (message: AssistantResult) => {
    result = message;
    usages.push(reportedUsage(message));
    // Effect: 每个最终响应只发布一次；消费者故障和旧上下文不得改变咨询结果。
    try {
      publishUsage(options.pi.events, {
        ...message,
        provider: message.provider ?? options.model.provider,
        model: message.model ?? options.model.id,
        durationMs: message.durationMs ?? performance.now() - started,
      });
    } catch { /* Failure: 旧宿主上下文不可用时只跳过统计。 */ }
  };

  try {
    const systemPrompt = `${options.systemPrompt}\n\nExecutor working directory: ${JSON.stringify(options.cwd)}\nYou can read text files using read (up to ${MAX_ADVISOR_READS} calls and ${MAX_ADVISOR_TURNS} model responses per consultation). Read missing source yourself before declining to judge. Only request executor help for evidence unavailable through read, such as running tests. No shell, file modification, or other tools are available.`;
    const systemMessage = createInitialSystemMessage(systemPrompt, [toToolDeclaration(reader.tool)]);
    const context: AgentContext = { messages: systemMessage ? [systemMessage] : [], tools: [reader.tool] };
    const config: AgentLoopConfig = {
      model: options.model,
      apiKey: options.apiKey,
      headers: options.headers,
      maxTokens: options.maxTokens,
      reasoning: options.reasoning,
      sessionId: options.sessionId,
      convertToLlm: (messages) => messages as Message[],
      prepareRequest: ({ context }) => {
        modelRequests++;
        if (modelRequests >= MAX_ADVISOR_TURNS || reader.reads >= MAX_ADVISOR_READS) {
          // Rule: 留出一次无工具的最终判断，不能在读完后直接截断成“没有结论”。
          const finalSystem = createInitialSystemMessage(`${systemPrompt}\nReading phase is over. No tools remain. Answer the decision question now using evidence already read; distinguish findings from any remaining uncertainty.`, []);
          return { context: { messages: finalSystem ? [finalSystem, ...context.messages.slice(1)] : context.messages, tools: [] } };
        }
      },
      finishTurn: ({ message }) => ({ action: message.content.some((block) => block.type === "toolCall") && modelRequests < MAX_ADVISOR_TURNS ? "continue" : "end" }),
    };
    const stream = (options.agentLoop ?? agentLoop)(
      options.messages as unknown as AgentMessage[], context, config, signal, streamSimple,
    );
    for await (const event of stream) {
      if (event.type === "message_end" && event.message.role === "assistant") record(event.message);
    }
    const messages = await stream.result();
    // Rule: 仅累计本次新响应，不累计输入 transcript 中已有的 assistant 用量。
    if (!result) {
      const inputMessages = new Set<unknown>(options.messages);
      for (const message of messages) {
        if (!inputMessages.has(message) && message.role === "assistant") record(message as AssistantResult);
      }
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(timer);
  }

  const durationMs = Math.round(performance.now() - started);
  const blocks = Array.isArray(result?.content) ? result.content : [];
  const text = blocks
    .filter((block): block is TextContent => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text).join("\n").trim();
  const stopReason = signal.aborted ? "aborted" : result?.stopReason;
  const errorMessage = timeout.signal.aborted ? `Advisor timed out after ${options.timeoutMs}ms; advice is incomplete.`
    : options.signal?.aborted ? "Advisor cancelled; advice is incomplete."
    : failure || result?.errorMessage || (stopReason === "toolUse" ? "Advisor stopped before a final assessment; reading/turn budget may be exhausted."
      : stopReason === "length" ? "Advisor output limit reached; advice is incomplete."
      : stopReason && stopReason !== "stop" ? `Advisor stopped: ${stopReason}; advice is incomplete.`
      : undefined);
  // Rule: 请求已经发起但没有最终响应时，总用量也不能只算已完成部分。
  if (usages.length < modelRequests) usages.push(undefined);
  const sum = (get: (usage: Partial<Usage> | undefined) => unknown): number | undefined => {
    const values = usages.map((usage) => numericUsage(get(usage)));
    return values.length && values.every((value) => value !== undefined) ? values.reduce<number>((total, value) => total + value!, 0) : undefined;
  };
  const inputTokens = sum((u) => u?.input), outputTokens = sum((u) => u?.output);
  const cacheReadTokens = sum((u) => u?.cacheRead), cacheWriteTokens = sum((u) => u?.cacheWrite);
  const cacheWrite1hTokens = sum((u) => u?.cacheWrite1h), totalTokens = sum((u) => u?.totalTokens);
  const reasoningTokens = sum((u) => u?.reasoning);
  const cost = {
    input: sum((u) => u?.cost?.input), output: sum((u) => u?.cost?.output),
    cacheRead: sum((u) => u?.cost?.cacheRead), cacheWrite: sum((u) => u?.cost?.cacheWrite), total: sum((u) => u?.cost?.total),
  };
  // Rule: 任一响应缺项，则对应汇总保持未知；只有完整 Usage 才交给 Pi 工具统计。
  const complete = [inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens, ...Object.values(cost)].every((value) => value !== undefined);
  const usage = complete ? {
    input: inputTokens, output: outputTokens, cacheRead: cacheReadTokens, cacheWrite: cacheWriteTokens,
    totalTokens, cost,
    ...(cacheWrite1hTokens === undefined ? {} : { cacheWrite1h: cacheWrite1hTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoning: reasoningTokens }),
  } as Usage : undefined;
  return {
    text, durationMs, stopReason, errorMessage, usage, modelRequests, readCalls: reader.reads,
    inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, cacheWrite1hTokens, totalTokens, reasoningTokens,
  };
}
