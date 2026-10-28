import { agentLoop, type AgentContext, type AgentMessage, type AgentLoopConfig } from "@earendil-works/pi-agent-core";
import {
  createInitialSystemMessage,
  type Message,
  type Model,
  type ProviderHeaders,
  type TextContent,
  type ThinkingLevel,
  type Usage,
} from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { publishUsage } from "./model-usage.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

export async function runAdvisor(options: RunAdvisorOptions): Promise<AdvisorRunResult> {
  const started = performance.now();
  const timeout = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal;
  const timer = setTimeout(() => timeout.abort(new Error("Advisor request timed out")), options.timeoutMs);
  let result: AssistantResult | undefined;
  let failure: string | undefined;
  const record = (message: AssistantResult) => {
    result = message;
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
    const systemMessage = createInitialSystemMessage(options.systemPrompt, []);
    const context: AgentContext = { messages: systemMessage ? [systemMessage] : [], tools: [] };
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
    const stream = (options.agentLoop ?? agentLoop)(
      options.messages as unknown as AgentMessage[], context, config, signal, streamSimple,
    );
    for await (const event of stream) {
      if (event.type === "message_end" && event.message.role === "assistant") record(event.message);
    }
    const messages = await stream.result();
    // Rule: 仅使用本次响应，不累计输入 transcript 里已有的 assistant 用量。
    if (!result) {
      const inputMessages = new Set<unknown>(options.messages);
      const generated = messages.filter((message) => !inputMessages.has(message) && message.role === "assistant");
      const last = generated.at(-1);
      if (last) record(last as AssistantResult);
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
    : failure || result?.errorMessage || (stopReason === "toolUse" ? "Advisor returned an unexpected tool call; no tools are available."
      : stopReason === "length" ? "Advisor output limit reached; advice is incomplete."
      : stopReason && stopReason !== "stop" ? `Advisor stopped: ${stopReason}; advice is incomplete.`
      : undefined);
  let u = result?.usage;
  // Rule: Pi 为失败响应初始化的全零计数不是供应商明确上报的零消耗。
  if ((stopReason === "error" || stopReason === "aborted") &&
    ![u?.input, u?.output, u?.cacheRead, u?.cacheWrite].some((value) => (numericUsage(value) ?? 0) > 0)) u = undefined;
  // Rule: 未报告的计数保持未知；只有完整 Usage 才交给 Pi 的工具用量汇总。
  const completeUsage = u && [u.input, u.output, u.cacheRead, u.cacheWrite, u.totalTokens,
    u.cost?.input, u.cost?.output, u.cost?.cacheRead, u.cost?.cacheWrite, u.cost?.total,
  ].every((value) => numericUsage(value) !== undefined) ? u as Usage : undefined;
  return {
    text, durationMs, stopReason, errorMessage, usage: completeUsage,
    inputTokens: numericUsage(u?.input), outputTokens: numericUsage(u?.output),
    cacheReadTokens: numericUsage(u?.cacheRead), cacheWriteTokens: numericUsage(u?.cacheWrite),
    cacheWrite1hTokens: numericUsage(u?.cacheWrite1h), totalTokens: numericUsage(u?.totalTokens),
    reasoningTokens: numericUsage(u?.reasoning),
  };
}
