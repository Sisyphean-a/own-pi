import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { registerCompactionTrigger } from "../src/hooks/compaction-trigger.js";
import { Runtime } from "../src/runtime.js";
import { OM_OBSERVATIONS_RECORDED } from "../src/session-ledger/index.js";
import { observation } from "./fixtures/session.js";

function setup(options: { passive?: boolean; keepRecentTokens?: number; covered?: boolean; partial?: boolean; missingReceipt?: boolean; settings?: object } = {}) {
	const manager = SessionManager.inMemory("/test");
	const oldId = manager.appendMessage({ role: "user", content: "旧任务事实".repeat(2_000), timestamp: 1 });
	const callId = manager.appendMessage({
		role: "assistant", content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "source.ts" } }],
		stopReason: "toolUse", timestamp: 2,
	} as any);
	const resultId = manager.appendMessage({ role: "toolResult", toolCallId: "tool-1", toolName: "read", content: [{ type: "text", text: "尚未处理的新约束".repeat(300) }], isError: false, timestamp: 3 });
	if (options.covered !== false) manager.appendCustomEntry(OM_OBSERVATIONS_RECORDED, {
		observations: [observation("aaaaaaaaaaaa", { sourceEntryIds: [oldId], content: "旧任务事实" })], coversUpToId: callId,
		processing: { processedSourceEntryIds: options.missingReceipt ? [callId] : [oldId, callId], ...(options.partial ? { nextSourceOffset: 10, startSourceOffset: 0 } : {}) },
	});
	const runtime = new Runtime();
	runtime.configLoaded = true;
	runtime.config.compactAfterTokens = 1_000;
	runtime.config.passive = options.passive ?? false;
	vi.spyOn(runtime, "resolveModel").mockRejectedValue(new Error("不得在压缩路径调用模型"));
	const handlers: Record<string, (event: any, ctx: any) => any> = {};
	const pi = {
		on: (name: string, handler: any) => { handlers[name] = handler; },
		getSettings: () => ({ compaction: { keepRecentTokens: options.keepRecentTokens ?? 1 }, ...options.settings }),
	};
	registerCompactionTrigger(pi as any, runtime);
	const ctx = { cwd: "/test", sessionManager: manager, hasUI: true, ui: { notify: vi.fn() }, compact: vi.fn(), model: { provider: "test", id: "main", contextWindow: 200_000 } };
	const event = () => ({ type: "turn_end", entries: [], continue: false, outcome: "completed", message: { role: "assistant", stopReason: "toolUse" }, context: { contextEntries: manager.buildSessionProjection().entries } });
	return { manager, runtime, ctx, pi, oldId, callId, resultId, event, run: (e: any = event()) => handlers.turn_end?.(e, ctx) };
}

describe("长任务回合边界压缩", () => {
	it.each(["reflector", "dropper", "observer"] as const)("边界压缩取消旧周期维护但不取消观察尾部：%s", async (stage) => {
		const run = setup();
		let release!: () => void;
		let signal!: AbortSignal;
		const task = run.runtime.launchConsolidationTask({ hasUI: false }, async (currentSignal) => {
			signal = currentSignal;
			run.runtime.consolidationPhase = stage;
			await new Promise<void>((resolve) => { release = resolve; });
		});
		expect(run.run()?.entries).toHaveLength(1);
		expect(signal.aborted).toBe(stage !== "observer");
		release(); await task;
	});
	it("立即折叠已覆盖旧历史，完整保留尚未覆盖的工具调用与结果", () => {
		const run = setup();
		const result = run.run();
		expect(result).not.toBeInstanceOf(Promise);
		expect(result?.entries).toHaveLength(1);
		const draft = result.entries[0];
		expect(draft).toMatchObject({ type: "compaction", firstKeptEntryId: run.callId, details: { type: "om.folded" } });
		expect(draft.summary).toContain("旧任务事实");
		run.manager.appendCompaction(draft.summary, draft.firstKeptEntryId, 5_000, draft.details, true);
		const projection = run.manager.buildSessionProjection();
		expect(projection.entries.some((entry) => entry.sourceEntry.id === run.oldId)).toBe(false);
		expect(projection.entries.find((entry) => entry.sourceEntry.id === run.callId)?.messages[0]).toMatchObject({ role: "assistant" });
		expect(projection.entries.find((entry) => entry.sourceEntry.id === run.resultId)?.messages[0]).toMatchObject({ role: "toolResult", toolCallId: "tool-1" });
		expect(run.run()).toBeUndefined();
		expect(run.ctx.compact).not.toHaveBeenCalled();
		expect(run.runtime.resolveModel).not.toHaveBeenCalled();
	});

	it.each([{ passive: true }, { covered: false }, { missingReceipt: true }, { keepRecentTokens: 100_000 }])("不能安全压缩时不等待、不请求原生压缩：%j", (options) => {
		const run = setup(options);
		expect(run.run()).toBeUndefined();
		expect(run.ctx.compact).not.toHaveBeenCalled();
		expect(run.runtime.resolveModel).not.toHaveBeenCalled();
	});

	it("部分处理的工具调用仍与全部结果一起保留", () => {
		const run = setup({ partial: true });
		expect(run.run()?.entries[0].firstKeptEntryId).toBe(run.callId);
	});

	it.each(["aborted", "error"])("失败或取消的回合交由 Pi 恢复：%s", (outcome) => {
		const run = setup();
		expect(run.run({ ...run.event(), outcome })).toBeUndefined();
	});

	it("长度截断和其他扩展的边界修改不被抢先压缩", () => {
		const run = setup();
		expect(run.run({ ...run.event(), message: { role: "assistant", stopReason: "length" } })).toBeUndefined();
		expect(run.run({ ...run.event(), entries: [{ type: "custom", customType: "other" }] })).toBeUndefined();
	});

	it("积压仍超阈值时不对同一切点反复压缩", () => {
		const run = setup();
		run.runtime.config.compactAfterTokens = 1;
		const draft = run.run().entries[0];
		run.manager.appendCompaction(draft.summary, draft.firstKeptEntryId, 5_000, draft.details, true);
		expect(run.run()).toBeUndefined();
	});

	it("按 ratio 阈值判断，不因固定阈值较低而提前压缩", () => {
		const run = setup();
		run.runtime.config.compactAfterTokensMode = "ratio";
		expect(run.run()).toBeUndefined();
	});

	it("模型上下文中的省略条目不被当成待替换的大段正文", () => {
		const run = setup();
		run.manager.appendContextEdit(run.oldId, null);
		expect(run.run()).toBeUndefined();
	});

	it("摘要超过可释放的正文时不做无收益压缩", () => {
		const run = setup();
		run.manager.appendCustomEntry(OM_OBSERVATIONS_RECORDED, {
			observations: [observation("bbbbbbbbbbbb", { sourceEntryIds: [run.oldId], content: "更多旧记忆".repeat(3_000) })], coversUpToId: run.oldId,
		});
		expect(run.run()).toBeUndefined();
	});

	it("继续运行的决定不被覆盖", () => {
		const run = setup();
		expect(run.run({ ...run.event(), continue: true })).not.toHaveProperty("continue");
	});

	it("缺少宿主设置能力时仅跳过边界优化", () => {
		const run = setup();
		delete (run.pi as any).getSettings;
		expect(run.run()).toBeUndefined();
	});

	it("沿用宿主当前模型的近期历史保留配置", () => {
		const run = setup({ settings: { compaction: { keepRecentTokens: 1, modelOverrides: { "test/main": { keepRecentTokens: 100_000 } } } } });
		expect(run.run()).toBeUndefined();
	});
});
