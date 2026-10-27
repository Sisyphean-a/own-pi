import { describe, expect, it } from "vitest";
import { runReflector, normalizeSupportingObservationIds } from "../src/agents/reflector/agent.js";
import { foldLedger, recallMemorySources } from "../src/session-ledger/index.js";
import { observation, reflection, observationsRecordedEntry, reflectionsRecordedEntry, textCustomMessage } from "./fixtures/session.js";

const obs = observation("aaaaaaaaaaaa", { content: "用户明确将此项目从 MySQL 改为 Postgres" });
const old = reflection("bbbbbbbbbbbb", [obs.id], { content: "此项目使用 MySQL" });
const base = { model: {} as any, observations: [obs], reflections: [old] };
const empty = { reflections: [], retirements: [], reviewedObservationIds: [obs.id] };
function fake(params: unknown, events: any[] = []): any {
	return (_prompts: unknown, context: any) => ({
		async *[Symbol.asyncIterator]() { await context.tools[0].execute("maintain", params); yield* events; },
		async result() { return {}; },
	});
}
const retirement = { reflectionId: old.id, supportingObservationIds: [obs.id], reason: "同项目数据库决定已被明确取代" };

describe("反思维护协议", () => {
	it("原子提交替代结论与旧结论撤回，旧证据仍可召回", async () => {
		const result = await runReflector({ ...base, agentLoop: fake({ ...empty, reflections: [{ content: "此项目改用 Postgres", supportingObservationIds: [obs.id] }], retirements: [retirement] }) });
		expect(result!.reflections).toHaveLength(1);
		expect(result!.retirements).toEqual([retirement]);
		const entries = [textCustomMessage("raw-1", "改用 Postgres"), observationsRecordedEntry("obs", { observations: [obs], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("old", { reflections: [old], coversUpToId: "raw-1" }),
			{ id: "new", type: "custom", customType: "om.reflections.recorded", data: { ...result, coversUpToId: "raw-1" } }];
		expect(foldLedger(entries).reflections.map((item) => item.content)).toEqual(["此项目改用 Postgres"]);
		const recalled = recallMemorySources(entries, old.id);
		expect(recalled.status).toBe("found");
		if (recalled.status === "found") expect(recalled.reflections[0]).toMatchObject({ status: "retired", retirement });
	});
	it("允许只撤回已失效结论，无需编造替代事实", async () => {
		expect(await runReflector({ ...base, agentLoop: fake({ ...empty, retirements: [retirement] }) })).toMatchObject({ reflections: [], retirements: [retirement] });
	});
	it("无新结论仍返回审阅完成状态", async () => {
		await expect(runReflector({ ...base, agentLoop: fake(empty) })).resolves.toEqual(empty);
	});
	it.each([
		{ ...empty, reviewedObservationIds: [] },
		{ ...empty, retirements: [{ ...retirement, reflectionId: "cccccccccccc" }] },
		{ ...empty, retirements: [{ ...retirement, supportingObservationIds: ["missing"] }] },
		{ ...empty, reflections: [{ content: "假来源", supportingObservationIds: ["missing"] }] },
		{ ...empty, reflections: [{ content: "第一行\n第二行", supportingObservationIds: [obs.id] }] },
	])("拒绝无效维护并保持整批原子性 %#", async (invalid) => {
		await expect(runReflector({ ...base, agentLoop: fake(invalid) })).rejects.toThrow();
	});
	it.each([false, true])("大量观察漏报时返回精确差异，修正后才完成（含非法 id：%s）", async (includeUnknown) => {
		const observations = Array.from({ length: 144 }, (_, index) => observation(index.toString(16).padStart(12, "0")));
		const ids = observations.map((item) => item.id);
		const missingId = ids.at(-1)!;
		const unknownId = "ffffffffffff";
		const submitted = ids.slice(0, -1).concat(includeUnknown ? [unknownId] : []);
		const loop: any = (prompts: any, context: any) => ({
			async *[Symbol.asyncIterator]() {
				expect(JSON.stringify(prompts)).toContain(`[${missingId}]`);
				let feedback = "";
				try {
					await context.tools[0].execute("incomplete", { ...empty, reviewedObservationIds: submitted });
				} catch (error) { feedback = (error as Error).message; }
				expect(feedback).toContain(`缺失 id：${JSON.stringify([missingId])}`);
				expect(feedback).toContain(`非法 id：${JSON.stringify(includeUnknown ? [unknownId] : [])}`);
				await context.tools[0].execute("corrected", { ...empty, reviewedObservationIds: ids });
			},
			async result() { return {}; },
		});
		await expect(runReflector({ ...base, observations, agentLoop: loop })).resolves.toEqual({ ...empty, reviewedObservationIds: ids });
	});
	it("已存在的同文结论不会为了覆盖计数被重写", async () => {
		const result = await runReflector({ ...base, agentLoop: fake({ ...empty, reflections: [{ content: old.content, supportingObservationIds: [obs.id] }] }) });
		expect(result?.reflections).toEqual([]);
	});
	it("一条观察可以支撑多条反思，但引用次数不生成覆盖等级", async () => {
		const loop: any = (prompts: any, context: any) => ({
			async *[Symbol.asyncIterator]() {},
			async result() {
				expect(JSON.stringify(prompts)).not.toContain("coverage:");
				await context.tools[0].execute("record", { ...empty, reflections: [{ content: "同项目迁移", supportingObservationIds: [obs.id] }, { content: "目标数据库是 Postgres", supportingObservationIds: [obs.id] }] }); return {};
			},
		});
		expect((await runReflector({ ...base, agentLoop: loop }))?.reflections).toHaveLength(2);
	});
	it("后续工具错误使先前提交失效，允许模型修正后再完成", async () => {
		await expect(runReflector({ ...base, agentLoop: fake(empty, [{ type: "tool_execution_end", isError: true }]) })).rejects.toThrow("完成回执");
	});
	it("流失败不提交已提议的撤回", async () => {
		await expect(runReflector({ ...base, agentLoop: fake({ ...empty, retirements: [retirement] }, [{ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "gateway timeout" } }]) })).rejects.toThrow("未提交");
	});
	it("来源集合依照当前观察顺序规范化", () => {
		expect(normalizeSupportingObservationIds(["b", "a", "b"], ["a", "b"])).toEqual(["a", "b"]);
	});
	it("无观察时不启动模型", async () => {
		await expect(runReflector({ ...base, observations: [] })).resolves.toBeUndefined();
	});
});
