import { describe, expect, it } from "vitest";
import { runObserver } from "../src/agents/observer/agent.js";
import { registerCompactionHook } from "../src/hooks/compaction-hook.js";
import { foldLedger, fullProjection, recallMemorySources, hasProcessedSourcePrefix, observationProcessingState, isObservationsDroppedData } from "../src/session-ledger/index.js";
import { serializeBranchEntries, serializeSourceAddressedBranchEntries } from "../src/serialize.js";
import { workerMessages, workerMaxTokens } from "../src/model-budget.js";
import { observation, observationsRecordedEntry, rawMessage, reflection, reflectionsRecordedEntry, textCustomMessage } from "./fixtures/session.js";

function loop(handler: (context: any) => Promise<void>, events: any[] = []): any {
	return (_prompts: unknown, context: any) => ({
		async *[Symbol.asyncIterator]() { yield* events; },
		async result() { await handler(context); return {}; },
	});
}

async function record(sourceId: string) {
	return runObserver({
		model: {} as any, priorReflections: [], priorObservations: [],
		chunk: `[Source entry id: ${sourceId}]\n数据库使用 Postgres`, allowedSourceEntryIds: [sourceId],
		agentLoop: loop(async (context) => {
			await context.tools.find((tool: any) => tool.name === "record_observations").execute("record", {
				observations: [{ content: "数据库使用 Postgres", timestamp: "2026-05-02 10:00", relevance: "high", sourceEntryIds: [sourceId] }],
			});
			await context.tools.find((tool: any) => tool.name === "finish_observation")?.execute("finish", { processedSourceEntryIds: [sourceId] });
		}),
	});
}

describe("记忆完整性回归", () => {
	it("读取旧账本但不把旧观察水位当作完整处理证明", () => {
		const old = observationsRecordedEntry("legacy", { observations: [observation("aaaaaaaaaaaa")], coversUpToId: "raw-1" });
		delete (old.data as any).processing;
		const entries = [textCustomMessage("raw-1", "旧消息"), old, textCustomMessage("raw-2", "保留边界")];
		expect(fullProjection(entries).observations).toHaveLength(1);
		expect(hasProcessedSourcePrefix(entries, "raw-2")).toBe(false);
	});
	it("分片回执不能跳过尚未读取的字符区间", () => {
		const source = textCustomMessage("huge", "x".repeat(1_000));
		const first = observationsRecordedEntry("first", { observations: [], coversUpToId: "huge", processing: { processedSourceEntryIds: ["huge"], nextSourceOffset: 100 } });
		const gap = observationsRecordedEntry("gap", { observations: [], coversUpToId: "huge", processing: { processedSourceEntryIds: ["huge"], startSourceOffset: 200, nextSourceOffset: 300 } });
		expect(observationProcessingState([source, first, gap])).toEqual({ nextEntryIndex: 0, startOffset: 100 });
	});
	it.each([
		{ content: [] },
		{ content: [{ type: "thinking", thinking: "未公开的思考" }] },
		{ content: [{ type: "thinking", redacted: true }] },
	])("观察输入为空的助手消息不阻塞既有回执和后续进度 %#", ({ content }) => {
		const empty = rawMessage("empty", "", { message: { role: "assistant", content, stopReason: "error", errorMessage: "Connection error." } });
		const source = textCustomMessage("processed", "已审阅的事实");
		const receipt = observationsRecordedEntry("receipt", { observations: [], coversUpToId: source.id, processing: { processedSourceEntryIds: [source.id] } });
		const next = textCustomMessage("next", "新约束");
		const entries = [empty, source, receipt, next];
		expect(serializeBranchEntries([empty])).toBe("");
		expect(observationProcessingState(entries)).toEqual({ nextEntryIndex: 3, startOffset: 0 });
		expect(hasProcessedSourcePrefix(entries, next.id)).toBe(true);
		expect(observationProcessingState([empty, source, receipt])).toEqual({ nextEntryIndex: -1, startOffset: 0 });
		expect(observationProcessingState([empty])).toEqual({ nextEntryIndex: -1, startOffset: 0 });
		expect(empty.message).toMatchObject({ stopReason: "error", errorMessage: "Connection error." });
	});
	it("空消息之后的未完成分片仍从真实未读位置恢复", () => {
		const empty = rawMessage("empty", "", { message: { role: "assistant", content: [] } });
		const source = textCustomMessage("huge", "x".repeat(1_000));
		const receipt = observationsRecordedEntry("partial", { observations: [], coversUpToId: source.id, processing: { processedSourceEntryIds: [source.id], nextSourceOffset: 100 } });
		expect(observationProcessingState([empty, source, receipt])).toEqual({ nextEntryIndex: 1, startOffset: 100 });
	});
	it.each([
		{ role: "assistant", stopReason: "error", content: [{ type: "text", text: "测试失败，不能提交" }] },
		{ role: "assistant", content: [{ type: "toolCall", id: "call", name: "bash", arguments: { command: "npm test" } }] },
		{ role: "user", content: [{ type: "image", data: "image", mimeType: "image/png" }] },
	])("有正文、工具调用或非文本占位的源仍须完整处理 %#", (message) => {
		const source = rawMessage("unread", "", { message });
		const next = textCustomMessage("next", "保留边界");
		expect(serializeSourceAddressedBranchEntries([source]).sourceEntryIds).toEqual([source.id]);
		expect(observationProcessingState([source, next])).toEqual({ nextEntryIndex: 0, startOffset: 0 });
		expect(hasProcessedSourcePrefix([source, next], next.id)).toBe(false);
	});
	it("每个精简 id 都须有自己的证据，重复证据不能覆盖另一个 id", () => {
		const duplicate = { observationId: "aaaaaaaaaaaa", reason: "routine", replacementIds: [] };
		expect(isObservationsDroppedData({ observationIds: ["aaaaaaaaaaaa", "bbbbbbbbbbbb"], coversUpToId: "raw-1", evidence: [duplicate, duplicate] })).toBe(false);
	});
	it("所有 worker 的输入预算保留系统、工具与输出空间，超限显式失败", () => {
		const model = { contextWindow: 32_000, maxTokens: 16_000 } as any;
		expect(workerMaxTokens(model)).toBe(8_000);
		const small: any = [{ role: "user", content: [{ type: "text", text: "事实" }], timestamp: 0 }];
		expect(workerMessages(model, small)).toBe(small);
		expect(() => workerMessages(model, [{ ...small[0], content: [{ type: "text", text: "中".repeat(10_000) }] }])).toThrow("预算");
	});
	it("相同文本在不同源消息中再次发生时保留独立事件身份", async () => {
		const first = await record("raw-1");
		const repeated = await record("raw-3");
		const a = first!.observations[0];
		const b = repeated!.observations[0];
		expect(a.id).not.toBe(b.id);
		const entries = [
			textCustomMessage("raw-1", "Postgres"),
			observationsRecordedEntry("om-1", { observations: [a], coversUpToId: "raw-1" }),
			{ type: "custom", id: "drop-1", customType: "om.observations.dropped", data: { observationIds: [a.id], coversUpToId: "raw-1" } },
			textCustomMessage("raw-3", "再次选择 Postgres"),
			observationsRecordedEntry("om-3", { observations: [b], coversUpToId: "raw-3" }),
		];
		expect(foldLedger(entries).activeObservations.map((item) => item.id)).toEqual([b.id]);
	});

	it("显式撤回旧反思后投影只显示新结论，旧证据仍可召回", () => {
		const obs = observation("aaaaaaaaaaaa");
		const old = reflection("bbbbbbbbbbbb", [obs.id], { content: "项目使用 MySQL" });
		const current = reflection("cccccccccccc", [obs.id], { content: "项目已改用 Postgres" });
		const entries = [
			textCustomMessage("raw-1", "用户明确要求改用 Postgres"),
			observationsRecordedEntry("om-1", { observations: [obs], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("ref-1", { reflections: [old], coversUpToId: "raw-1" }),
			{ type: "custom", id: "ref-2", customType: "om.reflections.recorded", data: {
				reflections: [current], coversUpToId: "raw-1",
				retirements: [{ reflectionId: old.id, supportingObservationIds: [obs.id], reason: "用户已明确改变数据库决定" }],
			} },
			{ type: "custom", id: "invalid-retirement", customType: "om.reflections.recorded", data: {
				reflections: [], coversUpToId: "raw-1", retirements: [{ reflectionId: old.id, supportingObservationIds: ["missing"], reason: "无证据的后续理由" }],
			} },
		];
		expect(fullProjection(entries).reflections.map((item) => item.id)).toEqual([current.id]);
		const recalled = recallMemorySources(entries, old.id);
		expect(recalled.status).toBe("found");
		if (recalled.status === "found") expect(recalled.reflections[0].retirement?.reason).toBe("用户已明确改变数据库决定");
	});

	it("有旧记忆但待切走区间尚未处理时交回原生压缩", async () => {
		let handler: any;
		registerCompactionHook({ on: (_name: string, callback: any) => { handler = callback; } } as any, {
			config: { observationsPoolMaxTokens: 20_000 }, compactHookInFlight: false, ensureConfig() {},
		} as any);
		const entries = [
			textCustomMessage("raw-1", "旧记录"),
			observationsRecordedEntry("om-1", { observations: [observation("aaaaaaaaaaaa")], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "用户约束：禁止提交"),
			textCustomMessage("raw-3", "保留的最近消息"),
		];
		expect(await handler({ branchEntries: entries, preparation: { firstKeptEntryId: "raw-3", tokensBefore: 10_000 } }, { cwd: ".", hasUI: false })).toBeUndefined();
	});

	it("没有显式处理完成回执时，即便已有观察也不能宣称整个分块成功", async () => {
		await expect(runObserver({
			model: {} as any, priorReflections: [], priorObservations: [], chunk: "两条消息", allowedSourceEntryIds: ["raw-1", "raw-2"],
			agentLoop: loop(async (context) => {
				await context.tools[0].execute("record", { observations: [{ content: "只处理了第一条", timestamp: "2026-05-02 10:00", relevance: "high", sourceEntryIds: ["raw-1"] }] });
			}),
		})).rejects.toThrow(/完成/);
	});

	it("超长源消息分片可连续恢复中部内容，不把头尾摘录当成整条", () => {
		const entry = textCustomMessage("huge", "头".repeat(5_000) + "独特中部事实" + "尾".repeat(5_000));
		const parts: string[] = [];
		let offset = 0;
		for (let i = 0; i < 100; i++) {
			const part = serializeSourceAddressedBranchEntries([entry], { maxTokens: 300, startOffset: offset });
			parts.push(part.text);
			if (part.nextSourceOffset === undefined) break;
			expect(part.nextSourceOffset).toBeGreaterThan(offset);
			offset = part.nextSourceOffset;
		}
		expect(parts.join("")).toContain("独特中部事实");
		expect(parts.length).toBeGreaterThan(1);
	});
});
