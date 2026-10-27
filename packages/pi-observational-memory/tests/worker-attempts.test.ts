import { describe, expect, it } from "vitest";
import { foldLedger, observationProcessingState, OM_WORKER_ATTEMPTED, workerAttempted, workerCycleId, type Entry } from "../src/session-ledger/index.js";
import { compactionEntry, textCustomMessage, reflectionsRecordedEntry, reflection, observationsDroppedEntry } from "./fixtures/session.js";

const attempt = (stage: "observer" | "reflector" | "dropper", sourceEntryId = "raw", sourceOffset = 0): Entry => ({
	type: "custom", id: "attempt-" + stage, customType: OM_WORKER_ATTEMPTED,
	data: stage === "observer" ? { stage, sourceEntryId, sourceOffset } : { stage },
});

describe("持久化尝试次数", () => {
	it("旧会话没有尝试记录时仍可正常启动", () => {
		const entries = [textCustomMessage("raw", "旧事实")];
		expect(workerAttempted(entries, "observer", "raw")).toBe(false);
		expect(workerAttempted(entries, "reflector")).toBe(false);
	});
	it.each(["reflector", "dropper"] as const)("成功、失败或取消不返还 %s 的周期次数；只有真实压缩记录刷新", (stage) => {
		const entries = [textCustomMessage("raw", "事实"), attempt(stage)];
		expect(workerAttempted(JSON.parse(JSON.stringify(entries)), stage)).toBe(true);
		expect(workerAttempted([...entries, { type: "custom", id: "failed-compact", customType: "session_compact_failed" }], stage)).toBe(true);
		const compact = compactionEntry("compact");
		expect(workerAttempted([...entries, compact], stage)).toBe(false);
		expect(workerCycleId([...entries, compact])).toBe("compact");
		expect(workerAttempted([...entries, compact, attempt(stage)], stage)).toBe(true);
	});
	it("旧版本已提交的成功维护在升级后不重复执行", () => {
		const entries = [reflectionsRecordedEntry("ref", { reflections: [reflection("aaaaaaaaaaaa", ["bbbbbbbbbbbb"])], coversUpToId: "raw" }), observationsDroppedEntry("drop", { observationIds: ["bbbbbbbbbbbb"], coversUpToId: "raw" })];
		expect(workerAttempted(entries, "reflector")).toBe(true);
		expect(workerAttempted(entries, "dropper")).toBe(true);
		expect(workerAttempted([...entries, compactionEntry("next")], "reflector")).toBe(false);
	});
	it("观察暂停按源位置区分，压缩、重载和新消息不使失败批次自动重发", () => {
		const entries = [textCustomMessage("raw", "事实"), attempt("observer"), compactionEntry("compact"), textCustomMessage("new", "新消息")];
		expect(workerAttempted(JSON.parse(JSON.stringify(entries)), "observer", "raw", 0)).toBe(true);
		expect(workerAttempted(entries, "observer", "raw", 100)).toBe(false);
		expect(workerAttempted(entries, "observer", "new", 0)).toBe(false);
	});
	it("尝试记录绝不充当成功回执，不推进源覆盖或污染记忆", () => {
		const entries = [textCustomMessage("raw", "事实"), attempt("observer")];
		expect(observationProcessingState(entries)).toEqual({ nextEntryIndex: 0, startOffset: 0 });
		expect(foldLedger(entries).observations).toHaveLength(0);
	});
});
