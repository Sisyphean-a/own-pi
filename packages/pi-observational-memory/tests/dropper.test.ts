import { describe, expect, it } from "vitest";
import { runDropper, selectDropCandidates } from "../src/agents/dropper/agent.js";
import { foldLedger, type ObservationDrop } from "../src/session-ledger/index.js";
import { observation, reflection, observationsRecordedEntry, observationsDroppedEntry, reflectionsRecordedEntry, textCustomMessage } from "./fixtures/session.js";
import { observationLineTokenCount } from "../src/tokens.js";

const low = observation("aaaaaaaaaaaa", { relevance: "low" });
const high = observation("bbbbbbbbbbbb", { relevance: "critical" });
const ref = reflection("cccccccccccc", [high.id]);
const base = { model: {} as any, observations: [low, high], reflections: [ref], targetTokens: 0 };
const routine: ObservationDrop = { observationId: low.id, reason: "routine", replacementIds: [] };
const covered: ObservationDrop = { observationId: high.id, reason: "redundant", replacementIds: [ref.id] };
function fake(drops: unknown, events: any[] = []): any {
	return (_prompts: unknown, context: any) => ({
		async *[Symbol.asyncIterator]() { await context.tools[0].execute("drop", { drops }); yield* events; }, async result() { return {}; },
	});
}

describe("有依据的精简", () => {
	it("重要观察可以精简，但必须提供当前替代证据", async () => {
		await expect(runDropper({ ...base, agentLoop: fake([covered]) })).resolves.toEqual([covered]);
	});
	it("low 例行回执允许无替代证据", async () => {
		await expect(runDropper({ ...base, agentLoop: fake([routine]) })).resolves.toEqual([routine]);
	});
	it.each([
		[{ ...covered, replacementIds: [] }],
		[{ ...covered, replacementIds: ["missing"] }],
		[{ ...covered, replacementIds: [high.id] }],
		[{ ...covered, reason: "routine", replacementIds: [] }],
		[{ ...covered, observationId: "missing" }],
	])("拒绝无效精简而非伪装成安全结果 %#", async (invalid) => {
		await expect(runDropper({ ...base, agentLoop: fake(invalid) })).rejects.toThrow();
	});
	it("同批相互引用不构成保留证明", () => {
		const proposals: ObservationDrop[] = [{ ...covered, replacementIds: [low.id] }, { ...routine, reason: "redundant", replacementIds: [high.id] }];
		expect(selectDropCandidates(proposals, [low, high], 0, [])).toEqual([]);
	});
	it("按实际完整行 token 达到目标即停止，不使用平均长度估算删除条数", () => {
		const large = observation("dddddddddddd", { relevance: "low", content: "x".repeat(800) });
		const target = observationLineTokenCount(high);
		const drops = selectDropCandidates([{ ...routine, observationId: large.id }, covered], [large, high], target, [ref]);
		expect(drops.map((item) => item.observationId)).toEqual([large.id]);
	});
	it("共同替代证据中任一观察同批被删时，原观察不能精简", () => {
		const joint = { ...covered, replacementIds: [ref.id, low.id] };
		expect(selectDropCandidates([routine, joint], [low, high], 0, [ref])).toEqual([routine]);
	});
	it("同 id 的重复提议去重", () => {
		expect(selectDropCandidates([routine, routine], [low], 0, [])).toEqual([routine]);
	});
	it("预算压力不能强迫产生精简", async () => {
		await expect(runDropper({ ...base, agentLoop: fake([]) })).resolves.toEqual([]);
	});
	it("未超过目标时不发起模型请求", async () => {
		await expect(runDropper({ ...base, targetTokens: 1_000 })).resolves.toBeUndefined();
	});
	it("后续工具错误使先前精简回执失效", async () => {
		await expect(runDropper({ ...base, agentLoop: fake([routine], [{ type: "tool_execution_end", isError: true }]) })).rejects.toThrow("完成回执");
	});
	it("流失败不能提交删除", async () => {
		await expect(runDropper({ ...base, agentLoop: fake([covered], [{ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "timeout" } }]) })).rejects.toThrow("未提交");
	});
	it("共同替代证据中任一反思被撤回后恢复原观察", () => {
		const evidence = observation("eeeeeeeeeeee", { content: "旧结论已经被纠正" });
		const other = reflection("ffffffffffff", [high.id]);
		const entries = [textCustomMessage("raw-1", "用户原文"), observationsRecordedEntry("obs", { observations: [high, evidence], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("ref", { reflections: [ref, other], coversUpToId: "raw-1" }),
			{ ...observationsDroppedEntry("drop", { observationIds: [high.id], coversUpToId: "raw-1" }), data: { observationIds: [high.id], coversUpToId: "raw-1", evidence: [{ ...covered, replacementIds: [ref.id, other.id] }] } },
			{ id: "retire", type: "custom", customType: "om.reflections.recorded", data: { reflections: [], retirements: [{ reflectionId: ref.id, supportingObservationIds: [evidence.id], reason: "明确纠正" }], coversUpToId: "raw-1" } }];
		expect(foldLedger(entries).activeObservations.map((item) => item.id)).toContain(high.id);
	});
});
