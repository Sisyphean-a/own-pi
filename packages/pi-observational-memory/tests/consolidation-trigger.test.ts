import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAgents = vi.hoisted(() => ({
	runObserver: vi.fn(),
	runReflector: vi.fn(),
	runDropper: vi.fn(),
}));

vi.mock("../src/agents/observer/agent.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/agents/observer/agent.js")>()),
	runObserver: mockAgents.runObserver,
}));
vi.mock("../src/agents/reflector/agent.js", () => ({ runReflector: mockAgents.runReflector }));
vi.mock("../src/agents/dropper/agent.js", () => ({ runDropper: mockAgents.runDropper }));

import { ObserverStreamError } from "../src/agents/observer/agent.js";
import { registerConsolidationTrigger } from "../src/hooks/consolidation-trigger.js";
import { Runtime } from "../src/runtime.js";
import { JournalTokenProgress } from "../src/session-ledger/token-progress.js";
import {
	OM_OBSERVATIONS_DROPPED,
	OM_OBSERVATIONS_RECORDED,
	OM_REFLECTIONS_RECORDED,
} from "../src/session-ledger/index.js";
import {
	observation,
	rawMessage,
	observationsRecordedEntry,
	reflection,
	reflectionsRecordedEntry,
	textCustomMessage,
	type TestEntry,
} from "./fixtures/session.js";

beforeEach(() => {
	mockAgents.runObserver.mockReset();
	mockAgents.runReflector.mockReset();
	mockAgents.runDropper.mockReset();
	mockAgents.runObserver.mockResolvedValue({ observations: [], complete: true });
	mockAgents.runReflector.mockImplementation(async (args) => ({ reflections: [], retirements: [], reviewedObservationIds: args.observations.map((item: any) => item.id) }));
	mockAgents.runDropper.mockResolvedValue([]);
});

function setup(args: {
	entries: TestEntry[];
	observeAfterTokens?: number;
	reflectAfterTokens?: number;
	observerChunkMaxTokens?: number;
	observationsPoolMaxTokens?: number;
	observationsPoolTargetTokens?: number;
	showWorkerNotifications?: boolean;
	passive?: boolean;
	consolidationInFlight?: boolean;
	appendEntryReturnsId?: boolean;
	sessionId?: string;
	contextTokens?: number;
}) {
	let entries = [...args.entries];
	let sessionId = args.sessionId ?? "session-1";
	const handlers: Record<string, ((event: unknown, ctx: any) => void) | undefined> = {};
	const pi = {
		on: vi.fn((eventName: string, cb: (event: unknown, ctx: any) => void) => {
			handlers[eventName] = cb;
		}),
		appendEntry: vi.fn((customType: string, data: unknown) => {
			const id = `appended-${pi.appendEntry.mock.calls.length}`;
			entries = [...entries, { type: "custom", id, parentId: entries.at(-1)?.id ?? null, timestamp: "2026-05-02T10:00:00.000Z", customType, data }];
			return args.appendEntryReturnsId === false ? undefined : id;
		}),
	};
	let launchedWork: (() => Promise<void>) | undefined;
	const runtime: any = {
		config: {
			showWorkerNotifications: args.showWorkerNotifications ?? true,
			passive: args.passive ?? false,
			debugLog: false,
			observeAfterTokens: args.observeAfterTokens ?? 1,
			reflectAfterTokens: args.reflectAfterTokens ?? 1,
			observerChunkMaxTokens: args.observerChunkMaxTokens,
			observationsPoolMaxTokens: args.observationsPoolMaxTokens ?? 100,
			observationsPoolTargetTokens: args.observationsPoolTargetTokens ?? Math.floor((args.observationsPoolMaxTokens ?? 100) / 2),
			agentMaxTurns: 9,
			model: { provider: "anthropic", id: "memory", thinking: "minimal" },
		},
		consolidationInFlight: args.consolidationInFlight ?? false,
		tokenProgress: new JournalTokenProgress(),
		sessionEpoch: 0,
		isSessionCurrent: (epoch: number) => runtime.sessionEpoch === epoch,
		consolidationPhase: undefined as "observer" | "reflector" | "dropper" | undefined,
		resolveFailureNotified: false,
		lastObserverError: undefined as string | undefined,
		lastReflectorError: undefined as string | undefined,
		lastDropperError: undefined as string | undefined,
		ensureConfig: vi.fn(),
		resolveModel: vi.fn(async () => ({ ok: true, model: { reasoning: true }, apiKey: "key", headers: { h: "v" } })),
		launchConsolidationTask: vi.fn((_ctx, work) => {
			runtime.consolidationInFlight = true;
			launchedWork = work;
			return Promise.resolve();
		}),
	};
	// 使用真实实现，保证 stale 会话的失败处理与生产路径一致。
	runtime.recordConsolidationStageError = Runtime.prototype.recordConsolidationStageError.bind(runtime);
	runtime.endSession = Runtime.prototype.endSession.bind(runtime);
	runtime.observationProgress = Runtime.prototype.observationProgress.bind(runtime);
	runtime.reflectionProgress = Runtime.prototype.reflectionProgress.bind(runtime);
	runtime.maintenanceDue = Runtime.prototype.maintenanceDue.bind(runtime);
	runtime.finishMaintenance = Runtime.prototype.finishMaintenance.bind(runtime);
	registerConsolidationTrigger(pi as any, runtime as any);
	if (!handlers.agent_start) throw new Error("agent_start consolidation handler not registered");
	if (!handlers.turn_end) throw new Error("turn_end consolidation handler not registered");
	const ctx = {
		cwd: "/tmp/project",
		hasUI: true,
		ui: { notify: vi.fn() },
		model: { provider: "session" },
		modelRegistry: {},
		getContextUsage: () => ({ tokens: args.contextTokens }),
		sessionManager: {
			getBranch: () => entries,
			getSessionId: () => sessionId,
		},
	};
	return {
		pi,
		runtime,
		ctx,
		fire: (eventName = "turn_end") => handlers[eventName]!(undefined, ctx),
		fireAgentStart: () => handlers.agent_start!(undefined, ctx),
		fireTurnEnd: () => handlers.turn_end!(undefined, ctx),
		runLaunchedWork: async () => launchedWork?.(),
		addEntries: (...more: TestEntry[]) => {
			entries = [...entries, ...more];
		},
		setSessionId: (next: string) => {
			sessionId = next;
		},
		getEntries: () => entries,
	};
}

describe("记忆整理编排", () => {
	const obsA = observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-1"] });
	const refA = reflection("eeeeeeeeeeee", [obsA.id]);

	it.each(["agent_start", "turn_end"])("阈值以下不启动 worker：%s", (event) => {
		const run = setup({ entries: [textCustomMessage("raw-1", "aaaa")], observeAfterTokens: 100, reflectAfterTokens: 100 });
		run.fire(event);
		expect(run.runtime.launchConsolidationTask).not.toHaveBeenCalled();
	});
	it.each([{ passive: true }, { consolidationInFlight: true }])("禁用或已运行时不重复启动 %#", (options) => {
		const run = setup({ entries: [textCustomMessage("raw-1", "aaaaaaaa")], ...options });
		run.fire();
		expect(run.runtime.launchConsolidationTask).not.toHaveBeenCalled();
	});
	it.each([["agent_start", "turn_end"], ["turn_end", "agent_start"]])("两个入口共享运行锁：%s → %s", (first, second) => {
		const run = setup({ entries: [textCustomMessage("raw-1", "aaaaaaaa")] });
		run.fire(first); run.fire(second);
		expect(run.runtime.launchConsolidationTask).toHaveBeenCalledOnce();
	});
	it("原子写入观察与显式处理回执，并向 worker 传递运行参数", async () => {
		mockAgents.runObserver.mockResolvedValueOnce({ observations: [obsA], complete: true });
		const run = setup({ entries: [textCustomMessage("raw-1", "aaaaaaaa")], reflectAfterTokens: 999 });
		run.fire(); await run.runLaunchedWork();
		expect(mockAgents.runObserver).toHaveBeenCalledWith(expect.objectContaining({ allowedSourceEntryIds: ["raw-1"], maxTurns: 9, thinkingLevel: "minimal" }));
		expect(run.pi.appendEntry).toHaveBeenCalledWith(OM_OBSERVATIONS_RECORDED, { observations: [obsA], coversUpToId: "raw-1", processing: { processedSourceEntryIds: ["raw-1"] } });
	});
	it("仅 headers 的 OAuth 认证仍完整透传", async () => {
		const run = setup({ entries: [textCustomMessage("raw-1", "aaaaaaaa")], reflectAfterTokens: 999 });
		run.runtime.resolveModel.mockResolvedValue({ ok: true, model: {}, headers: { Authorization: "Bearer oauth-token" } });
		run.fire(); await run.runLaunchedWork();
		expect(mockAgents.runObserver).toHaveBeenCalledWith(expect.objectContaining({ apiKey: undefined, headers: { Authorization: "Bearer oauth-token" } }));
	});
	it.each([{ provider: "opencode-go" }, { provider: "custom", baseUrl: "https://opencode.ai/zen" }])("保留 OpenCode 会话头 %#", async (model) => {
		const run = setup({ entries: [textCustomMessage("raw-1", "aaaaaaaa")], reflectAfterTokens: 999 });
		run.runtime.resolveModel.mockResolvedValue({ ok: true, model, headers: { Authorization: "Bearer oauth" } });
		run.fire(); await run.runLaunchedWork();
		expect(mockAgents.runObserver.mock.calls[0][0].headers).toEqual({ Authorization: "Bearer oauth", "x-opencode-session": "session-1", "x-opencode-client": "pi" });
	});
	it("无会话 id 时保持认证头不变", async () => {
		const run = setup({ entries: [textCustomMessage("raw-1", "aaaaaaaa")], reflectAfterTokens: 999 });
		delete (run.ctx.sessionManager as any).getSessionId;
		run.runtime.resolveModel.mockResolvedValue({ ok: true, model: { provider: "opencode-go" }, headers: { h: "v" } });
		run.fire(); await run.runLaunchedWork();
		expect(mockAgents.runObserver.mock.calls[0][0].headers).toEqual({ h: "v" });
	});
	it("零观察推进处理游标，后续运行只检查新增源消息", async () => {
		const run = setup({ entries: [textCustomMessage("raw-1", "aaaaaaaa")], reflectAfterTokens: 999 });
		run.fire(); await run.runLaunchedWork();
		expect(run.pi.appendEntry.mock.calls[0][1]).toMatchObject({ observations: [], processing: { processedSourceEntryIds: ["raw-1"] } });
		run.runtime.consolidationInFlight = false;
		run.addEntries(textCustomMessage("raw-2", "新的重要约束"));
		run.fire(); await run.runLaunchedWork();
		expect(mockAgents.runObserver.mock.calls[1][0].allowedSourceEntryIds).toEqual(["raw-2"]);
	});
	it("没有完成回执不写任何内容，也不启动后续阶段", async () => {
		mockAgents.runObserver.mockResolvedValueOnce(undefined);
		const run = setup({ entries: [textCustomMessage("raw-1", "aaaaaaaa")] });
		run.fire(); await run.runLaunchedWork();
		expect(run.pi.appendEntry).not.toHaveBeenCalled();
		expect(run.runtime.lastObserverError).toContain("完成回执");
		expect(mockAgents.runReflector).not.toHaveBeenCalled();
	});
	it("同轮重新读取观察后原子提交反思及旧结论撤回", async () => {
		mockAgents.runObserver.mockResolvedValueOnce({ observations: [obsA], complete: true });
		const run = setup({ entries: [textCustomMessage("raw-1", "aaaaaaaa")] });
		run.fire(); await run.runLaunchedWork();
		expect(mockAgents.runReflector).toHaveBeenCalledWith(expect.objectContaining({ observations: [obsA] }));
		expect(run.pi.appendEntry.mock.calls[1][1]).toMatchObject({ reflections: [], reviewedObservationIds: [obsA.id] });
	});
	it("即使没有新反思，压力下仍可运行精简器", async () => {
		const run = setup({ entries: [textCustomMessage("raw-1", "aaaaaaaa"), observationsRecordedEntry("obs", { observations: [obsA], coversUpToId: "raw-1" })], observeAfterTokens: 999, reflectAfterTokens: 999, observationsPoolTargetTokens: 5 });
		run.fire(); await run.runLaunchedWork();
		expect(mockAgents.runReflector).not.toHaveBeenCalled();
		expect(mockAgents.runDropper).toHaveBeenCalled();
	});
	it("池压力达到上限时提前维护反思", async () => {
		const run = setup({ entries: [textCustomMessage("raw-1", "aaaaaaaa"), observationsRecordedEntry("obs", { observations: [obsA], coversUpToId: "raw-1" })], observeAfterTokens: 999, reflectAfterTokens: 999, observationsPoolMaxTokens: 10 });
		run.fire(); await run.runLaunchedWork();
		expect(mockAgents.runReflector).toHaveBeenCalled();
		expect(mockAgents.runDropper).toHaveBeenCalled();
	});
	it("没有安全候选时同一记忆修订不反复启动精简", async () => {
		const run = setup({ entries: [textCustomMessage("raw-1", "aaaaaaaa"), observationsRecordedEntry("obs", { observations: [obsA], coversUpToId: "raw-1" })], observeAfterTokens: 999, reflectAfterTokens: 999, observationsPoolTargetTokens: 5 });
		run.fire(); await run.runLaunchedWork();
		run.runtime.consolidationInFlight = false;
		run.fire();
		expect(run.runtime.launchConsolidationTask).toHaveBeenCalledOnce();
	});
	it("精简结果保留每条替代证据，且不依赖 appendEntry 返回 id", async () => {
		const drop = { observationId: obsA.id, reason: "redundant", replacementIds: [refA.id] };
		mockAgents.runDropper.mockResolvedValueOnce([drop]);
		const run = setup({ entries: [textCustomMessage("raw-1", "aaaaaaaa"), observationsRecordedEntry("obs", { observations: [obsA], coversUpToId: "raw-1" }), reflectionsRecordedEntry("ref", { reflections: [refA], coversUpToId: "raw-1" })], observeAfterTokens: 999, reflectAfterTokens: 999, observationsPoolTargetTokens: 5, appendEntryReturnsId: false });
		run.fire(); await run.runLaunchedWork();
		expect(run.pi.appendEntry).toHaveBeenCalledWith(OM_OBSERVATIONS_DROPPED, { observationIds: [obsA.id], coversUpToId: "raw-1", evidence: [drop] });
	});
	it("缺少观察覆盖时不凭空维护或精简", async () => {
		const run = setup({ entries: [textCustomMessage("raw-1", "aaaaaaaa")], observeAfterTokens: 999 });
		run.fire(); await run.runLaunchedWork();
		expect(mockAgents.runReflector).not.toHaveBeenCalled(); expect(mockAgents.runDropper).not.toHaveBeenCalled();
	});
	it.each([true, false])("例行通知遵守设置，错误始终报告：%s", async (showWorkerNotifications) => {
		const run = setup({ entries: [textCustomMessage("raw-1", "aaaaaaaa")], reflectAfterTokens: 999, showWorkerNotifications });
		run.fire(); await run.runLaunchedWork();
		expect(run.ctx.ui.notify.mock.calls.length > 0).toBe(showWorkerNotifications);
		mockAgents.runObserver.mockRejectedValueOnce(new ObserverStreamError("error", "gateway timeout"));
		const failed = setup({ entries: [textCustomMessage("raw-1", "aaaaaaaa")], showWorkerNotifications });
		failed.fire(); await failed.runLaunchedWork();
		expect(failed.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("gateway timeout"), "warning");
	});
	it("模型不可用只提示一次且不写伪记忆", async () => {
		const run = setup({ entries: [textCustomMessage("raw-1", "aaaaaaaa")] });
		run.runtime.resolveModel.mockResolvedValue({ ok: false, reason: "no model" });
		run.fire(); await run.runLaunchedWork(); run.runtime.consolidationInFlight = false;
		run.fire(); await run.runLaunchedWork();
		expect(run.pi.appendEntry).not.toHaveBeenCalled();
		expect(run.ctx.ui.notify.mock.calls.filter((call) => call[1] === "warning")).toHaveLength(1);
	});
	it.each(["observer", "reflector", "dropper"] as const)("阶段失败保持先前已提交记录，停止后续阶段：%s", async (stage) => {
		mockAgents.runObserver.mockResolvedValue({ observations: [obsA], complete: true });
		mockAgents.runReflector.mockImplementation(async (args) => ({ reflections: [refA], retirements: [], reviewedObservationIds: args.observations.map((item: any) => item.id) }));
		mockAgents[stage === "observer" ? "runObserver" : stage === "reflector" ? "runReflector" : "runDropper"].mockRejectedValueOnce(new Error(stage + " failed"));
		const run = setup({ entries: [textCustomMessage("raw-1", "aaaaaaaa")], observationsPoolTargetTokens: 5 });
		run.fire(); await run.runLaunchedWork();
		expect(run.runtime["last" + stage[0].toUpperCase() + stage.slice(1) + "Error"]).toContain("failed");
		expect(run.pi.appendEntry).toHaveBeenCalledTimes(stage === "observer" ? 0 : stage === "reflector" ? 1 : 2);
	});
	it("provider 真实增量到期时，阶段内准入与入口使用相同口径", async () => {
		const first = rawMessage("raw-1", "done", { message: { role: "assistant", content: "done", stopReason: "end_turn", usage: { totalTokens: 1_000 } } });
		const run = setup({ entries: [first, observationsRecordedEntry("obs", { observations: [], coversUpToId: "raw-1" }), textCustomMessage("raw-2", "short")], contextTokens: 1_100, observeAfterTokens: 50, reflectAfterTokens: 999 });
		run.fire(); await run.runLaunchedWork();
		expect(mockAgents.runObserver).toHaveBeenCalledOnce();
	});
	it("记忆前缀已超预算时显式报错，不推进进度", async () => {
		const run = setup({ entries: [textCustomMessage("raw-1", "原始事实"), observationsRecordedEntry("obs", { observations: [observation("aaaaaaaaaaaa", { content: "中文".repeat(20_000) })], coversUpToId: "raw-1" }), textCustomMessage("raw-2", "新要求")], reflectAfterTokens: 999 });
		run.runtime.resolveModel.mockResolvedValue({ ok: true, model: { contextWindow: 32_000, maxTokens: 8_000 } });
		run.fire(); await run.runLaunchedWork();
		expect(mockAgents.runObserver).not.toHaveBeenCalled();
		expect(run.pi.appendEntry).not.toHaveBeenCalled();
		expect(run.runtime.lastObserverError).toContain("预算");
	});
	it("预算内的完整分块从旧到新逐次排空", async () => {
		const run = setup({ entries: [textCustomMessage("raw-1", "a".repeat(800)), textCustomMessage("raw-2", "b".repeat(800))], observerChunkMaxTokens: 256, reflectAfterTokens: 999 });
		run.fire(); await run.runLaunchedWork(); run.runtime.consolidationInFlight = false;
		run.fire(); await run.runLaunchedWork();
		expect(mockAgents.runObserver.mock.calls.map((call) => call[0].allowedSourceEntryIds)).toEqual([["raw-1"], ["raw-2"]]);
	});
	it("超长源条目跨轮续读，处理完尾部后才读取下一条", async () => {
		const run = setup({ entries: [textCustomMessage("huge", "HEAD:" + "x".repeat(2_000) + ":MIDDLE:" + "y".repeat(2_000) + ":TAIL"), textCustomMessage("next", "下一条")], observerChunkMaxTokens: 256, reflectAfterTokens: 999 });
		for (let i = 0; i < 20; i++) {
			run.runtime.consolidationInFlight = false; run.fire(); await run.runLaunchedWork();
			if (mockAgents.runObserver.mock.calls.at(-1)?.[0].allowedSourceEntryIds.includes("next")) break;
		}
		const calls = mockAgents.runObserver.mock.calls.map((call) => call[0]);
		expect(calls[1].sourceOffset).toBeGreaterThan(0);
		expect(calls.map((call) => call.chunk).join("")).toContain(":MIDDLE:");
		expect(calls.at(-1).allowedSourceEntryIds).toContain("next");
		expect((run.pi.appendEntry.mock.calls[0][1] as any).processing.nextSourceOffset).toBeGreaterThan(0);
	});
	it("会话代次变化后放弃已排队的后台任务", async () => {
		const run = setup({ entries: [textCustomMessage("raw-1", "aaaaaaaa")] });
		run.fire(); run.runtime.endSession(); await run.runLaunchedWork();
		expect(run.pi.appendEntry).not.toHaveBeenCalled(); expect(run.ctx.ui.notify).not.toHaveBeenCalled();
	});
	it("会话在模型执行期间被替换时不写回旧结果", async () => {
		const run = setup({ entries: [textCustomMessage("raw-1", "aaaaaaaa")] });
		mockAgents.runObserver.mockImplementationOnce(async () => { run.runtime.endSession(); return { observations: [obsA], complete: true }; });
		run.fire(); await run.runLaunchedWork();
		expect(run.pi.appendEntry).not.toHaveBeenCalled();
	});
	it("stale-ctx 作为取消处理，不打扰用户", async () => {
		mockAgents.runObserver.mockRejectedValueOnce(new Error("This extension ctx is stale after session replacement or reload."));
		const run = setup({ entries: [textCustomMessage("raw-1", "aaaaaaaa")] });
		run.fire(); await run.runLaunchedWork();
		expect(run.ctx.ui.notify.mock.calls.every((call) => call[1] !== "warning")).toBe(true);
		expect(run.pi.appendEntry).not.toHaveBeenCalled();
	});
});
