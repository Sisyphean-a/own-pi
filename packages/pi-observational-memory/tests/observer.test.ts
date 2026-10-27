import { describe, expect, it, vi } from "vitest";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { normalizeSourceEntryIds, OBSERVATION_TIMESTAMP_PATTERN, ObserverStreamError, observerChunkBudget, runObserver } from "../src/agents/observer/agent.js";
import { observationLineTokenCount } from "../src/tokens.js";

function fake(handler: (context: any, config: any) => Promise<void> | void, events: any[] = []): any {
	return (_prompts: unknown, context: any, config: any) => ({
		async *[Symbol.asyncIterator]() { await handler(context, config); yield* events; }, async result() { return {}; },
	});
}
const proposal = { timestamp: "2026-05-02 10:30", content: "用户明确选择 Postgres", relevance: "high", sourceEntryIds: ["entry-a"] };
const base = { model: {} as any, priorReflections: [], priorObservations: [], chunk: "[Source entry id: entry-a]\n用户选择 Postgres", allowedSourceEntryIds: ["entry-a"] };
const finish = (context: any, ids = ["entry-a"]) => context.tools[1].execute("finish", { processedSourceEntryIds: ids });

describe("观察协议", () => {
	it("每批最多一次模型响应，变化时间位于可复用记忆之后", async () => {
		const loop: any = (prompts: any, context: any, config: any) => ({
			async *[Symbol.asyncIterator]() {
				const text = prompts[0].content[0].text;
				expect(text.startsWith("当前反思：")).toBe(true);
				expect(text.indexOf("当前本地时间：")).toBeGreaterThan(text.indexOf(base.chunk));
				expect(config.finishTurn({})).toEqual({ action: "end" });
				await finish(context);
			},
			async result() { return {}; },
		});
		await runObserver({ ...base, agentLoop: loop });
	});
	it("用量只发布助手回复，不把用户与工具消息误算为模型调用", async () => {
		const onUsage = vi.fn();
		const assistant = { role: "assistant", stopReason: "toolUse", usage: { input: 10, output: 2 } };
		await runObserver({ ...base, onUsage, agentLoop: fake((context) => finish(context), [
			{ type: "message_end", message: { role: "user" } },
			{ type: "message_end", message: assistant },
			{ type: "message_end", message: { role: "toolResult" } },
		]) });
		expect(onUsage).toHaveBeenCalledExactlyOnceWith(assistant);
	});
	it("系统消息和工具声明一起送入真实 agent context", async () => {
		await runObserver({ ...base, agentLoop: fake(async (context) => {
			expect(getCurrentSystemPrompt(context.messages)).toBeTruthy();
			expect(context.tools.map((item: any) => item.name)).toEqual(["record_observations", "finish_observation"]);
			await finish(context);
		}) });
	});
	it("记录来源、独立事件 id 与代码计算的完整行 token 数", async () => {
		const result = await runObserver({ ...base, agentLoop: fake(async (context) => {
			await context.tools[0].execute("record", { observations: [proposal] }); await finish(context);
		}) });
		expect(result?.complete).toBe(true);
		const observation = result!.observations[0];
		expect(observation).toMatchObject(proposal);
		expect(observation.id).toMatch(/^[a-f0-9]{12}$/);
		expect(observation.tokenCount).toBe(observationLineTokenCount(observation));
	});
	it("零观察也有可验证的成功结果", async () => {
		await expect(runObserver({ ...base, agentLoop: fake((context) => finish(context)) })).resolves.toEqual({ complete: true, observations: [] });
	});
	it("没有完成回执不能把零结果解释成已处理", async () => {
		await expect(runObserver({ ...base, agentLoop: fake(() => {}) })).rejects.toThrow("完成回执");
	});
	it("记录被 SDK 拒绝后，合法完成调用也不能掩盖整批失败", async () => {
		const loop: any = (_prompts: unknown, context: any) => ({
			async *[Symbol.asyncIterator]() {
				yield { type: "tool_execution_end", toolName: "record_observations", toolCallId: "bad-record", isError: true };
				await finish(context);
				yield { type: "tool_execution_end", toolName: "finish_observation", toolCallId: "finish", isError: false };
			},
			async result() { return {}; },
		});
		await expect(runObserver({ ...base, agentLoop: loop })).rejects.toThrow("完成回执");
	});
	it("同次响应中的后续合法记录不能清除之前被拒绝的观察", async () => {
		await expect(runObserver({ ...base, agentLoop: fake(async (context) => {
			await context.tools[0].execute("invalid", { observations: [{ ...proposal, sourceEntryIds: ["invented"] }] });
			await context.tools[0].execute("valid", { observations: [proposal] });
			await finish(context);
		}) })).rejects.toThrow("修正");
	});
	it("完成回执必须覆盖全部提供的源 id", async () => {
		await expect(runObserver({ ...base, allowedSourceEntryIds: ["entry-a", "entry-b"], agentLoop: fake((context) => finish(context)) })).rejects.toThrow("全部");
	});
	it.each([
		{ ...proposal, sourceEntryIds: ["invented"] },
		{ ...proposal, content: "第一行\n第二行" },
		{ ...proposal, content: "x".repeat(10_001) },
	])("非法提议须修正，不能直接确认完成 %#", async (invalid) => {
		await expect(runObserver({ ...base, agentLoop: fake(async (context) => {
			const ack = await context.tools[0].execute("record", { observations: [invalid] });
			expect(ack.details.rejected).toBe(1); await finish(context);
		}) })).rejects.toThrow("修正");
	});
	it("同一次事件的重复工具提交只保留一条", async () => {
		const result = await runObserver({ ...base, agentLoop: fake(async (context) => {
			await context.tools[0].execute("record", { observations: [proposal, proposal] }); await finish(context);
		}) });
		expect(result?.observations).toHaveLength(1);
	});
	it.each(["error", "aborted"])("%s 时即便已产生观察也不提交部分成功", async (stopReason) => {
		await expect(runObserver({ ...base, agentLoop: fake(async (context) => {
			await context.tools[0].execute("record", { observations: [proposal] }); await finish(context);
		}, [{ type: "message_end", message: { role: "assistant", stopReason, errorMessage: "测试失败" } }]) })).rejects.toBeInstanceOf(ObserverStreamError);
	});
	it.each(["minimal", "off"] as const)("保留思考设置与回合上限：%s", async (thinkingLevel) => {
		await runObserver({ ...base, model: { reasoning: true } as any, thinkingLevel, agentLoop: fake(async (context, config) => {
			expect(config.reasoning).toBe(thinkingLevel === "off" ? undefined : thinkingLevel);
			expect(config.finishTurn({})).toEqual({ action: "end" }); await finish(context);
		}) });
	});
	it("完成后出现工具校验错误时不复用旧回执", async () => {
		await expect(runObserver({ ...base, agentLoop: fake((context) => finish(context), [{ type: "tool_execution_end", isError: true }]) })).rejects.toThrow("完成回执");
	});
	it("分块预算包含既有记忆，不只限制新源文本", () => {
		const model = { contextWindow: 32_000, maxTokens: 8_000 } as any;
		expect(observerChunkBudget(model, [], [], 6_000)).toBeGreaterThan(0);
		expect(() => observerChunkBudget(model, ["中文".repeat(20_000)], [], 6_000)).toThrow("预算");
	});
	it("保持本地分钟时间格式", () => {
		const pattern = new RegExp(OBSERVATION_TIMESTAMP_PATTERN);
		expect(pattern.test("2026-05-02 10:30")).toBe(true);
		expect(pattern.test("2026-5-02T10:30:00")).toBe(false);
	});
	it("规范来源集合时去重、保持源顺序并拒绝未知 id", () => {
		expect(normalizeSourceEntryIds(["b", "a", "a"], ["a", "b"])).toEqual(["a", "b"]);
		for (const ids of [undefined, [], ["missing"]]) expect(normalizeSourceEntryIds(ids, ["a"])).toBeUndefined();
	});
});
