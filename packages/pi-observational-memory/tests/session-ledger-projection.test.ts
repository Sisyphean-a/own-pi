import { describe, expect, it } from "vitest";
import { buildCompactionProjection, diffProjection, fullProjection, visibleProjection } from "../src/session-ledger/index.js";
import { compactionEntry, memoryDetails, observation, observationsDroppedEntry, observationsRecordedEntry, oldV2CompactionDetails, reflection, reflectionsRecordedEntry, textCustomMessage } from "./fixtures/session.js";

const a = observation("aaaaaaaaaaaa");
const b = observation("bbbbbbbbbbbb", { sourceEntryIds: ["raw-2"] });
const ref = reflection("cccccccccccc", [a.id]);
const history = () => [textCustomMessage("raw-1", "用户原文"), observationsRecordedEntry("obs-a", { observations: [a], coversUpToId: "raw-1" }), reflectionsRecordedEntry("ref-a", { reflections: [ref], coversUpToId: "raw-1" })];

describe("当前记忆投影", () => {
	it("完整投影只显示活跃观察和当前反思", () => {
		expect(fullProjection([...history(), observationsDroppedEntry("drop", { observationIds: [a.id], coversUpToId: "raw-1" })])).toEqual({ observations: [], reflections: [ref] });
	});
	it("没有压缩时可见投影为空", () => {
		expect(visibleProjection(history())).toEqual({ observations: [], reflections: [] });
	});
	it("可见投影精确对应最近一次有效压缩，而非后台最新状态", () => {
		const entries = [...history(), compactionEntry("cmp", { firstKeptEntryId: "raw-1", details: memoryDetails({ observations: [a], reflections: [] }) }), reflectionsRecordedEntry("later", { reflections: [ref], coversUpToId: "raw-1" })];
		expect(visibleProjection(entries)).toEqual({ observations: [a], reflections: [] });
	});
	it("忽略旧 V2 压缩详情", () => {
		expect(visibleProjection([compactionEntry("old", { details: oldV2CompactionDetails() })])).toEqual({ observations: [], reflections: [] });
	});
	it("按每条观察的源位置选择，不按整批末尾水位丢掉跨切点观察", () => {
		const entries = [...history(), textCustomMessage("raw-2", "待压缩决定"), textCustomMessage("raw-3", "保留边界"), textCustomMessage("raw-4", "后续消息"), observationsRecordedEntry("batch", { observations: [b], coversUpToId: "raw-4" })];
		expect(buildCompactionProjection(entries, "raw-3").observations).toEqual([a, b]);
	});
	it("每次压缩都应用新反思和精简，无需等待池压力", () => {
		const entries = [...history(), observationsDroppedEntry("drop", { observationIds: [a.id], coversUpToId: "raw-1" })];
		expect(buildCompactionProjection(entries, "raw-1")).toMatchObject({ fullFold: true, observations: [], reflections: [ref] });
	});
	it("同一批里原子撤回冲突旧结论并渲染新结论", () => {
		const current = reflection("dddddddddddd", [a.id], { content: "新决定" });
		const entries = [...history(), { id: "maintain", type: "custom", customType: "om.reflections.recorded", data: { reflections: [current], retirements: [{ reflectionId: ref.id, supportingObservationIds: [a.id], reason: "明确取代" }], coversUpToId: "raw-1" } }];
		expect(buildCompactionProjection(entries, "raw-1").reflections).toEqual([current]);
	});
	it("观察依赖切点两边的源时保留完整结论", () => {
		const combined = { ...a, sourceEntryIds: ["raw-1", "raw-2"] };
		const entries = [textCustomMessage("raw-1", "问题"), textCustomMessage("raw-2", "结果"), observationsRecordedEntry("obs", { observations: [combined], coversUpToId: "raw-2" })];
		expect(buildCompactionProjection(entries, "raw-1").observations).toEqual([combined]);
	});
	it("同一个事件 id 依旧采用首次记录，防止重放改写历史", () => {
		const entries = [...history(), observationsRecordedEntry("duplicate", { observations: [{ ...a, content: "不同内容" }], coversUpToId: "raw-1" })];
		expect(fullProjection(entries, "raw-1").observations).toEqual([a]);
	});
	it("投影详情可直接复原可见记忆", () => {
		const projection = buildCompactionProjection(history(), "raw-1");
		expect(visibleProjection([compactionEntry("cmp", { details: projection.details })])).toEqual({ observations: [a], reflections: [ref] });
	});
	it("报告新增记忆与已精简观察的可见漂移", () => {
		expect(diffProjection({ observations: [a], reflections: [] }, { observations: [b], reflections: [ref] })).toEqual({ observationsOnlyInFull: [b], reflectionsOnlyInFull: [ref], retiredOnlyInFull: [], droppedOnlyInFull: [a] });
	});
});
