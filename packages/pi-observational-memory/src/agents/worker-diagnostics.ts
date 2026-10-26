import { randomUUID } from "node:crypto";
import type { AgentEvent, AgentTool } from "@earendil-works/pi-agent-core";
import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { diagnosticError, diagnosticLog, recordDiagnosticError } from "../debug-log.js";

type Stage = "observer" | "reflector" | "dropper";
type FailureCode = "max_turns" | "output_limit" | "tool_rejected" | "missing_completion" | "stream_error" | "cancelled" | "exception";
type ToolStats = { name: string; calls: number; successes: number; errors: number };

class CompletionError extends Error {
	constructor(message: string, readonly failureCode: FailureCode) { super(message); this.name = "WorkerCompletionError"; }
}

/** SDK 校验正文附带原始参数；只提取本插件 schema 中的字段路径和规则类型。 */
function sdkValidationEvidence(result: unknown): unknown {
	const content = (result as { content?: unknown })?.content;
	if (!Array.isArray(content)) return undefined;
	const text = content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n");
	if (!text.startsWith("Validation failed for tool")) return undefined;
	const fields = new Set(["observations", "timestamp", "content", "relevance", "sourceEntryIds", "processedSourceEntryIds", "reflections", "retirements", "reviewedObservationIds", "supportingObservationIds", "reflectionId", "reason", "drops", "observationId", "replacementIds"]);
	const header = text.split("\n\nReceived arguments:")[0];
	const issues = [...header.matchAll(/^\s*-\s+([\w.\[\]/-]+):\s+([^\n]*)/gm)].map((match) => ({
		path: match[1].split(/[.\[\]/0-9-]+/).filter(Boolean).every((field) => fields.has(field)) ? match[1].slice(0, 120) : "unknown_field",
		rule: ["required", "array", "string", "object", "number", "integer", "literal", "pattern", "format", "length", "union"].find((rule) => match[2].toLowerCase().includes(rule)) ?? "schema",
	}));
	return { kind: "schema_validation", issues };
}

/** 集中采集三类 worker 的控制流证据，不接管循环、校验、重试或账本提交。 */
export class WorkerDiagnostics {
	readonly workerId = randomUUID();
	turns = 0;
	private readonly started = performance.now();
	private assistantMessages = 0;
	private lastStopReason?: string;
	private lastResponse?: { provider?: string; model?: string; responseModel?: string; responseId?: string };
	private readonly stats = new Map<string, ToolStats>();
	private readonly calls = new Set<string>();
	private readonly executed = new Set<string>();
	private readonly failed = new Set<string>();
	private validationRejections = 0;
	private completionInvalidations = 0;
	private readonly usage: Record<string, number> = {};

	constructor(private readonly stage: Stage, private readonly options: {
		model: Model<any>; maxTurns?: number; thinkingLevel?: ModelThinkingLevel; signal?: AbortSignal;
	}, private readonly input: Record<string, number | readonly string[]>) {}

	private key(name: string, id: string): string { return `${this.assistantMessages}:${name}:${id}`; }

	private call(name: string, id: string): string {
		const key = this.key(name, id);
		const stats = this.stats.get(name)!;
		if (!this.calls.has(key)) { this.calls.add(key); stats.calls++; }
		return key;
	}

	tools(tools: AgentTool<any>[]): AgentTool<any>[] {
		for (const tool of tools) this.stats.set(tool.name, { name: tool.name, calls: 0, successes: 0, errors: 0 });
		this.stats.set("unknown_tool", { name: "unknown_tool", calls: 0, successes: 0, errors: 0 });
		return tools.map((tool): AgentTool<any> => ({
			...tool,
			execute: async (...args) => {
				const key = this.call(tool.name, args[0]);
				this.executed.add(key);
				try {
					const result = await tool.execute(...args);
					this.stats.get(tool.name)!.successes++;
					return result;
				} catch (error) {
					this.toolFailed(tool.name, key, "execute", error);
					throw error;
				}
			},
		}));
	}

	private toolFailed(tool: string, key: string, executionPhase: string, error?: unknown, sdkValidation?: unknown): void {
		if (this.failed.has(key)) return;
		this.failed.add(key);
		this.stats.get(tool)!.errors++;
		diagnosticLog("worker.tool_failed", {
			workerId: this.workerId, stage: this.stage, tool, executionPhase, sdkValidation,
			// SDK 错误正文可能包含完整参数，只有本地工具抛出的错误才采集文本。
			error: error === undefined ? undefined : diagnosticError(error),
		});
	}

	observe(event: AgentEvent): void {
		if (event.type === "message_end" && event.message.role === "assistant") {
			this.assistantMessages++;
			this.lastStopReason = event.message.stopReason;
			const response = event.message as { provider?: string; model?: string; responseModel?: string; responseId?: string };
			this.lastResponse = { provider: response.provider, model: response.model, responseModel: response.responseModel, responseId: response.responseId };
			const usage = event.message.usage;
			for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
				if (typeof usage?.[key] === "number") this.usage[key] = (this.usage[key] ?? 0) + usage[key];
			}
		}
		if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
			const name = this.stats.has(event.toolName) ? event.toolName : "unknown_tool";
			const key = this.call(name, event.toolCallId);
			if (event.type === "tool_execution_end" && event.isError) {
				this.toolFailed(name, key, this.executed.has(key) ? "after_execute" : "before_execute", undefined, sdkValidationEvidence(event.result));
			}
		}
	}

	invalidated(): void {
		this.completionInvalidations++;
		diagnosticLog("worker.completion_invalidated", { workerId: this.workerId, stage: this.stage, reason: "later_tool_error" });
	}

	validation(tool: string, evidence: Record<string, unknown>): void {
		this.validationRejections++;
		diagnosticLog("worker.validation_rejected", { workerId: this.workerId, stage: this.stage, tool, ...evidence });
	}

	private reason(): FailureCode {
		if (this.options.signal?.aborted || this.lastStopReason === "aborted") return "cancelled";
		if (this.lastStopReason === "error") return "stream_error";
		if (this.lastStopReason === "length") return "output_limit";
		if (this.options.maxTurns && this.turns >= this.options.maxTurns) return "max_turns";
		if (this.failed.size || this.validationRejections) return "tool_rejected";
		return "missing_completion";
	}

	completionError(message: string): Error {
		const code = this.reason();
		const labels: Record<FailureCode, string> = {
			max_turns: `已达轮数上限 ${this.turns}/${this.options.maxTurns}`,
			output_limit: "模型输出截断", tool_rejected: "工具调用被拒绝或校验失败",
			missing_completion: this.lastStopReason ? "模型已结束但未提交有效完成确认" : "未收到完成确认，模型结束原因未上报",
			stream_error: "模型流失败", cancelled: "模型调用已取消", exception: "worker 执行异常",
		};
		return new CompletionError(`${message}；${labels[code]}`, code);
	}

	private snapshot(): Record<string, unknown> {
		const model = this.options.model;
		return {
			workerId: this.workerId, stage: this.stage, model: { provider: model.provider, id: model.id, api: model.api, contextWindow: model.contextWindow, maxTokens: model.maxTokens },
			thinking: this.options.thinkingLevel ?? "low", reasoningEnabled: Boolean(model.reasoning && this.options.thinkingLevel !== "off"), maxTurns: this.options.maxTurns, lastResponse: this.lastResponse,
			turns: this.turns, assistantMessages: this.assistantMessages, lastStopReason: this.lastStopReason,
			elapsedMs: Math.round(performance.now() - this.started), input: this.input, usage: this.usage,
			tools: [...this.stats.values()].filter((tool) => tool.calls > 0), validationRejections: this.validationRejections, completionInvalidations: this.completionInvalidations,
		};
	}

	async run<T>(work: () => Promise<T>): Promise<T> {
		diagnosticLog("worker.started", this.snapshot());
		try {
			const result = await work();
			diagnosticLog("worker.finished", { ...this.snapshot(), completed: true });
			return result;
		} catch (error) {
			const reason = this.reason();
			const failureCode = error instanceof CompletionError ? error.failureCode
				: reason === "missing_completion" ? "exception" : reason;
			recordDiagnosticError("worker.failed", error, { ...this.snapshot(), completed: false, failureCode });
			throw error;
		}
	}
}
