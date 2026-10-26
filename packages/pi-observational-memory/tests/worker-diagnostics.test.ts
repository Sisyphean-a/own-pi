import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ agentDir: "" }));
vi.mock("@earendil-works/pi-coding-agent", () => ({ getAgentDir: () => mock.agentDir }));
import { withDebugLogContext } from "../src/debug-log.js";
import { runObserver, ObserverStreamError } from "../src/agents/observer/agent.js";
import { runReflector } from "../src/agents/reflector/agent.js";
import { runDropper } from "../src/agents/dropper/agent.js";
import { isRetryableWorkerError } from "../src/agents/worker-retry.js";
import { observation } from "./fixtures/session.js";

const base = {
	model: { provider: "test-provider", id: "test-model", contextWindow: 100_000, maxTokens: 8_000, reasoning: true } as any,
	apiKey: "PRIVATE_API_KEY", headers: { Authorization: "Bearer PRIVATE_HEADER" },
	priorReflections: [], priorObservations: [], chunk: "PRIVATE_PROMPT_CONTENT", allowedSourceEntryIds: ["source-a", "source-b"], maxTurns: 16,
};
function loop(handler: (ctx: any, config: any) => AsyncGenerator<any>): any {
	return (_prompts: unknown, ctx: any, config: any) => ({ [Symbol.asyncIterator]: () => handler(ctx, config), result: async () => ({}) });
}
const message = (stopReason = "stop") => ({ type: "message_end", message: { role: "assistant", stopReason, content: [{ type: "text", text: "PRIVATE_MODEL_TEXT" }] } });
const run = <T>(work: () => T) => withDebugLogContext({ enabled: false, sessionId: "diag-session", runId: "pipeline-1" }, work);
function records(): any[] {
	const file = join(mock.agentDir, "observational-memory", "debug", "diag-session.ndjson");
	return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
}
const failure = () => records().find((r) => r.event === "worker.failed");

beforeEach(() => { mock.agentDir = mkdtempSync(join(tmpdir(), "om-worker-diag-")); });
afterEach(() => { rmSync(mock.agentDir, { recursive: true, force: true }); });

describe("自动 worker 诊断", () => {
	it("即使关闭 debug，也能定位模型正常结束但未确认完成", async () => {
		await expect(run(() => runObserver({ ...base, agentLoop: loop(async function* (_ctx, config) { yield message(); config.finishTurn({}); }) }))).rejects.toThrow("完成回执");
		expect(failure()).toMatchObject({ sessionId: "diag-session", runId: "pipeline-1", data: { stage: "observer", failureCode: "missing_completion", turns: 1, lastStopReason: "stop", model: { provider: "test-provider", id: "test-model" } } });
		expect(failure().diagnosticId).toBeTruthy();
	});

	it("明确记录轮数耗尽，而不是泛称缺回执", async () => {
		await expect(run(() => runObserver({ ...base, maxTurns: 2, agentLoop: loop(async function* (_ctx, config) {
			for (let i = 0; i < 2; i++) { yield message("toolUse"); config.finishTurn({}); }
		}) }))).rejects.toThrow("轮数上限");
		expect(failure().data).toMatchObject({ failureCode: "max_turns", turns: 2, maxTurns: 2 });
	});

	it("输出截断不被误判为模型主动放弃", async () => {
		await expect(run(() => runObserver({ ...base, agentLoop: loop(async function* () { yield message("length"); }) }))).rejects.toThrow("输出截断");
		expect(failure().data.failureCode).toBe("output_limit");
	});

	it("记录完成回执缺少哪些内部来源 id，不保存原始参数", async () => {
		await expect(run(() => runObserver({ ...base, agentLoop: loop(async function* (ctx) {
			try { await ctx.tools[1].execute("finish-1", { processedSourceEntryIds: ["source-a", "PRIVATE_ARGUMENT"] }); } catch {}
			yield message();
		}) }))).rejects.toThrow("完成回执");
		expect(failure().data.failureCode).toBe("tool_rejected");
		expect(records().find((r) => r.event === "worker.validation_rejected")?.data).toMatchObject({ tool: "finish_observation", missingIds: ["source-b"] });
		const text = JSON.stringify(records());
		for (const secret of ["PRIVATE_API_KEY", "PRIVATE_HEADER", "PRIVATE_PROMPT_CONTENT", "PRIVATE_MODEL_TEXT", "PRIVATE_ARGUMENT"]) expect(text).not.toContain(secret);
	});

	it("能发现 SDK 在进入工具前就拒绝调用，且不抄录错误中的参数正文", async () => {
		await expect(run(() => runObserver({ ...base, agentLoop: loop(async function* () {
			yield { type: "tool_execution_start", toolName: "finish_observation", toolCallId: "bad-1", args: { secret: "PRIVATE_ARGUMENT" } };
			yield { type: "tool_execution_end", toolName: "finish_observation", toolCallId: "bad-1", isError: true, result: { content: [{ type: "text", text: 'Validation failed for tool "finish_observation":\n  - processedSourceEntryIds: Expected array\n\nReceived arguments:\nPRIVATE_ARGUMENT' }] } };
		}) }))).rejects.toThrow("完成回执");
		expect(failure().data.failureCode).toBe("tool_rejected");
		expect(records().find((r) => r.event === "worker.tool_failed")?.data).toMatchObject({ executionPhase: "before_execute", sdkValidation: { kind: "schema_validation", issues: [{ path: "processedSourceEntryIds", rule: "array" }] } });
		expect(JSON.stringify(records())).not.toContain("PRIVATE_ARGUMENT");
	});

	it("反思工具的语义校验错误也会自动留下具体原因", async () => {
		const obs = observation("aaaaaaaaaaaa");
		await expect(run(() => runReflector({ ...base, observations: [obs], reflections: [], agentLoop: loop(async function* (ctx) {
			await ctx.tools[0].execute("review", { reflections: [], retirements: [], reviewedObservationIds: [] });
		}) }))).rejects.toThrow("全部当前观察");
		expect(failure().data).toMatchObject({ stage: "reflector", failureCode: "tool_rejected" });
		expect(records().find((r) => r.event === "worker.tool_failed")?.data.error.message).toContain("全部当前观察");
	});

	it("精简失败不再只知道缺回执", async () => {
		await expect(run(() => runDropper({ ...base, observations: [observation("aaaaaaaaaaaa", { content: "x".repeat(200) })], reflections: [], targetTokens: 1, agentLoop: loop(async function* () { yield message(); }) }))).rejects.toThrow("完成回执");
		expect(failure().data).toMatchObject({ stage: "dropper", failureCode: "missing_completion" });
	});

	it("保留流错误类型及重试判定，同时关联自动诊断", async () => {
		let error: unknown;
		try { await run(() => runObserver({ ...base, agentLoop: loop(async function* () { yield { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "Connection error." } }; }) })); } catch (e) { error = e; }
		expect(error).toBeInstanceOf(ObserverStreamError);
		expect(isRetryableWorkerError(error)).toBe(true);
		expect(failure().data.failureCode).toBe("stream_error");
	});

	it("完成确认被后续工具错误作废时能直接查到原因", async () => {
		await expect(run(() => runObserver({ ...base, agentLoop: loop(async function* (ctx) {
			await ctx.tools[1].execute("finish", { processedSourceEntryIds: base.allowedSourceEntryIds });
			yield { type: "tool_execution_end", toolName: "unknown", toolCallId: "later", isError: true };
		}) }))).rejects.toThrow("完成回执");
		expect(failure().data.completionInvalidations).toBe(1);
		expect(records().some((r) => r.event === "worker.completion_invalidated")).toBe(true);
	});

	it("流创建之前抛异常也会收集，不误判成模型主动结束", async () => {
		await expect(run(() => runObserver({ ...base, agentLoop: (() => { throw new Error("adapter failed"); }) as any }))).rejects.toThrow("adapter failed");
		expect(failure().data).toMatchObject({ failureCode: "exception", turns: 0, assistantMessages: 0 });
	});

	it("取消保留真实终止原因，不被当成可重试的服务端失败", async () => {
		let error: unknown;
		try { await run(() => runObserver({ ...base, agentLoop: loop(async function* () { yield message("aborted"); }) })); } catch (e) { error = e; }
		expect(isRetryableWorkerError(error)).toBe(false);
		expect(failure().data).toMatchObject({ failureCode: "cancelled", lastStopReason: "aborted" });
	});

	it("成功也保留轻量结果摘要，能区分恢复成功和仍未结束", async () => {
		await run(() => runObserver({ ...base, agentLoop: loop(async function* (ctx) { await ctx.tools[1].execute("finish", { processedSourceEntryIds: base.allowedSourceEntryIds }); yield message(); }) }));
		expect(records().map((r) => r.event)).toContain("worker.started");
		expect(records().find((r) => r.event === "worker.finished")?.data).toMatchObject({ stage: "observer", completed: true });
		expect(failure()).toBeUndefined();
	});
});
