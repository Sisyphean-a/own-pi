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
	OM_WORKER_ATTEMPTED,
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
	compactAfterTokens?: number;
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
	let retryHandler: any;
	const pi = {
		registerCommand: vi.fn((_name, options) => { retryHandler = options.handler; }),
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
			compactAfterTokens: args.compactAfterTokens ?? 81_000,
			compactAfterTokensMode: "calibrated",
			observationsPoolMaxTokens: args.observationsPoolMaxTokens ?? 100,
			observationsPoolTargetTokens: args.observationsPoolTargetTokens ?? Math.floor((args.observationsPoolMaxTokens ?? 100) / 2),
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
			const controller = new AbortController();
			runtime.consolidationController = controller;
			launchedWork = () => work(controller.signal);
			return Promise.resolve();
		}),
	};
	// 使用真实实现，保证 stale 会话的失败处理与生产路径一致。
	runtime.recordConsolidationStageError = Runtime.prototype.recordConsolidationStageError.bind(runtime);
	runtime.endSession = Runtime.prototype.endSession.bind(runtime);
	runtime.cancelConsolidation = Runtime.prototype.cancelConsolidation.bind(runtime);
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
		retry: async () => {
			const previous = launchedWork;
			await retryHandler("", { ...ctx, isIdle: () => true });
			if (launchedWork !== previous) await launchedWork?.();
		},
		addEntries: (...more: TestEntry[]) => {
			entries = [...entries, ...more];
		},
		setSessionId: (next: string) => {
			sessionId = next;
		},
		getEntries: () => entries,
	};
}

function memoryWrites(run: ReturnType<typeof setup>) {
	return run.pi.appendEntry.mock.calls.filter(([type]) => type !== OM_WORKER_ATTEMPTED);
}

describe("记忆整理编排", () => {
	it("反思和清理失败各自消耗本周期机会，重载和新消息都不补跑", async () => {
		mockAgents.runObserver.mockResolvedValue({ observations: [observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-1"] })], complete: true });
		mockAgents.runReflector.mockRejectedValue(new Error("反思失败"));
		mockAgents.runDropper.mockRejectedValue(new Error("清理失败"));
		const run = setup({ entries: [textCustomMessage("raw-1", "原始事实")], observationsPoolTargetTokens: 5 });
		run.fire(); await run.runLaunchedWork();
		expect(mockAgents.runReflector).toHaveBeenCalledTimes(1);
		expect(mockAgents.runDropper).toHaveBeenCalledTimes(1);
		const restored = setup({ entries: [...run.getEntries(), textCustomMessage("raw-2", "新增事实")], observationsPoolTargetTokens: 5 });
		restored.fire(); await restored.runLaunchedWork();
		expect(mockAgents.runReflector).toHaveBeenCalledTimes(1);
		expect(mockAgents.runDropper).toHaveBeenCalledTimes(1);
		restored.runtime.consolidationInFlight = false;
		restored.addEntries({ type: "compaction", id: "next-cycle", parentId: null, timestamp: "2026-05-02T10:01:00Z" }, textCustomMessage("raw-3", "压缩后新增事实"));
		restored.fire(); await restored.runLaunchedWork();
		expect(mockAgents.runReflector).toHaveBeenCalledTimes(2);
		expect(mockAgents.runDropper).toHaveBeenCalledTimes(2);
	});
	it("被动模式下手动重试只运行观察，不顺带请求可选维护", async () => {
		const run = setup({ passive: true, entries: [textCustomMessage("raw-1", "需要保存的约束")], observationsPoolTargetTokens: 1 });
		mockAgents.runObserver.mockResolvedValueOnce({ observations: [observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-1"] })], complete: true });
		run.fire();
		expect(mockAgents.runObserver).not.toHaveBeenCalled();
		await run.retry();
		expect(mockAgents.runObserver).toHaveBeenCalledTimes(1);
		expect(mockAgents.runReflector).not.toHaveBeenCalled();
		expect(mockAgents.runDropper).not.toHaveBeenCalled();
	});
	it("已有任务运行时手动重试不能再启动一次请求", async () => {
		const run = setup({ consolidationInFlight: true, entries: [textCustomMessage("raw-1", "事实")] });
		await run.retry();
		expect(mockAgents.runObserver).not.toHaveBeenCalled();
		expect(run.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("等待"), "warning");
	});
	it("尝试记录必须先落盘，落盘失败不得发起模型请求", async () => {
		const run = setup({ entries: [textCustomMessage("raw-1", "事实")] });
		run.pi.appendEntry.mockImplementationOnce(() => { throw new Error("磁盘不可写"); });
		run.fire(); await run.runLaunchedWork();
		expect(mockAgents.runObserver).not.toHaveBeenCalled();
		expect(run.runtime.lastObserverError).toContain("磁盘不可写");
	});
	it("压缩成功取消旧周期维护请求，不把结果写进新周期", async () => {
		const run = setup({ entries: [textCustomMessage("raw-1", "事实")] });
		mockAgents.runObserver.mockResolvedValueOnce({ observations: [observation("aaaaaaaaaaaa")], complete: true });
		mockAgents.runReflector.mockImplementationOnce(async (args) => {
			run.addEntries({ type: "compaction", id: "committed-compact", parentId: null, timestamp: "2026-05-02T10:01:00Z" });
			run.fire("session_compact");
			expect(args.signal.aborted).toBe(true);
			return { reflections: [], retirements: [], reviewedObservationIds: ["aaaaaaaaaaaa"] };
		});
		run.fire(); await run.runLaunchedWork();
		expect(memoryWrites(run).map(([type]) => type)).toEqual([OM_OBSERVATIONS_RECORDED]);
	});
	it("观察失败后同一未读位置暂停，重载或追加消息不能自动重发", async () => {
		mockAgents.runObserver.mockRejectedValue(new Error("content_filter"));
		const run = setup({ entries: [textCustomMessage("raw-1", "原始事实")], reflectAfterTokens: 999 });
		run.fire(); await run.runLaunchedWork();
		expect(mockAgents.runObserver).toHaveBeenCalledTimes(1);
		const restored = setup({ entries: [...run.getEntries(), textCustomMessage("raw-2", "新增消息")], reflectAfterTokens: 999 });
		restored.fire(); await restored.runLaunchedWork();
		expect(mockAgents.runObserver).toHaveBeenCalledTimes(1);
	});
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
		expect(mockAgents.runObserver).toHaveBeenCalledWith(expect.objectContaining({ allowedSourceEntryIds: ["raw-1"], thinkingLevel: "minimal" }));
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
		expect(memoryWrites(run)[0][1]).toMatchObject({ observations: [], processing: { processedSourceEntryIds: ["raw-1"] } });
		run.runtime.consolidationInFlight = false;
		run.addEntries(textCustomMessage("raw-2", "新的重要约束"));
		run.fire(); await run.runLaunchedWork();
		expect(mockAgents.runObserver.mock.calls[1][0].allowedSourceEntryIds).toEqual(["raw-2"]);
	});
	it("旧会话的空失败消息不使已审阅历史在后续回合重复付费处理", async () => {
		const empty = rawMessage("empty", "", { message: { role: "assistant", content: [], stopReason: "error", errorMessage: "Connection error." } });
		const run = setup({ entries: [
			empty,
			textCustomMessage("raw-1", "已经处理过的长历史"),
			observationsRecordedEntry("receipt", { observations: [], coversUpToId: "raw-1", processing: { processedSourceEntryIds: ["raw-1"] } }),
			textCustomMessage("raw-2", "新约束"),
		], reflectAfterTokens: 999 });
		run.fire(); await run.runLaunchedWork();
		expect(mockAgents.runObserver).toHaveBeenCalledOnce();
		expect(mockAgents.runObserver.mock.calls[0][0].allowedSourceEntryIds).toEqual(["raw-2"]);
		run.runtime.consolidationInFlight = false;
		run.addEntries(textCustomMessage("raw-3", "又一条新约束"));
		run.fire(); await run.runLaunchedWork();
		expect(mockAgents.runObserver).toHaveBeenCalledTimes(2);
		expect(mockAgents.runObserver.mock.calls[1][0].allowedSourceEntryIds).toEqual(["raw-3"]);
		expect(run.getEntries()[0]).toBe(empty);
	});
	it("没有完成回执只保留尝试记录，不提交观察或启动后续阶段", async () => {
		mockAgents.runObserver.mockResolvedValueOnce(undefined);
		const run = setup({ entries: [textCustomMessage("raw-1", "aaaaaaaa")] });
		run.fire(); await run.runLaunchedWork();
		expect(memoryWrites(run)).toHaveLength(0);
		expect(run.runtime.lastObserverError).toContain("完成回执");
		expect(mockAgents.runReflector).not.toHaveBeenCalled();
	});
	it("同轮重新读取观察后原子提交反思及旧结论撤回", async () => {
		mockAgents.runObserver.mockResolvedValueOnce({ observations: [obsA], complete: true });
		const run = setup({ entries: [textCustomMessage("raw-1", "aaaaaaaa")] });
		run.fire(); await run.runLaunchedWork();
		expect(mockAgents.runReflector).toHaveBeenCalledWith(expect.objectContaining({ observations: [obsA] }));
		expect(memoryWrites(run)[1][1]).toMatchObject({ reflections: [], reviewedObservationIds: [obsA.id] });
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
		mockAgents.runObserver.mockRejectedValue(new ObserverStreamError("error", "gateway timeout"));
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
	it.each(["observer", "reflector", "dropper"] as const)("失败不提交本阶段结果；只有观察失败中止后续阶段：%s", async (stage) => {
		mockAgents.runObserver.mockResolvedValue({ observations: [obsA], complete: true });
		mockAgents.runReflector.mockImplementation(async (args) => ({ reflections: [refA], retirements: [], reviewedObservationIds: args.observations.map((item: any) => item.id) }));
		mockAgents[stage === "observer" ? "runObserver" : stage === "reflector" ? "runReflector" : "runDropper"].mockRejectedValueOnce(new Error(stage + " failed"));
		const run = setup({ entries: [textCustomMessage("raw-1", "aaaaaaaa")], observationsPoolTargetTokens: 5 });
		run.fire(); await run.runLaunchedWork();
		expect(run.runtime["last" + stage[0].toUpperCase() + stage.slice(1) + "Error"]).toContain("failed");
		expect(memoryWrites(run)).toHaveLength(stage === "observer" ? 0 : stage === "reflector" ? 1 : 2);
	});
	it("瞬态失败也不自动重试，只允许用户显式重试当前批次", async () => {
		mockAgents.runObserver.mockRejectedValueOnce(new ObserverStreamError("error", "Connection error."));
		const run = setup({ entries: [textCustomMessage("raw-1", "aaaaaaaa")] });
		run.fire(); await run.runLaunchedWork();
		expect(mockAgents.runObserver).toHaveBeenCalledTimes(1);
		expect(memoryWrites(run)).toHaveLength(0);
		expect(run.runtime.lastObserverError).toContain("Connection error.");
		run.runtime.consolidationInFlight = false;
		await run.retry();
		expect(mockAgents.runObserver).toHaveBeenCalledTimes(2);
		expect(memoryWrites(run)).toHaveLength(1);
	});
	it("瞬态失败一次即停止，不提交观察或启动后续阶段", async () => {
		mockAgents.runObserver.mockRejectedValue(new ObserverStreamError("error", "Connection error."));
		const run = setup({ entries: [textCustomMessage("raw-1", "aaaaaaaa")] });
		run.fire(); await run.runLaunchedWork();
		expect(mockAgents.runObserver).toHaveBeenCalledTimes(1);
		expect(memoryWrites(run)).toHaveLength(0);
		expect(mockAgents.runReflector).not.toHaveBeenCalled();
		expect(run.runtime.lastObserverError).toContain("Connection error.");
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
		expect(memoryWrites(run)).toHaveLength(0);
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
		expect((memoryWrites(run)[0][1] as any).processing.nextSourceOffset).toBeGreaterThan(0);
	});
	it("清理次数已用完时，仍可运行有额度且达到压力阈值的反思", async () => {
		const run = setup({ entries: [
			textCustomMessage("old-source", "旧事实"),
			observationsRecordedEntry("old-record", { observations: [observation("aaaaaaaaaaaa", { sourceEntryIds: ["old-source"] })], coversUpToId: "old-source" }),
			{ type: "custom", id: "used-dropper", parentId: null, timestamp: "2026-05-02T10:00:00Z", customType: OM_WORKER_ATTEMPTED, data: { stage: "dropper" } },
		], observeAfterTokens: 99_999, reflectAfterTokens: 99_999, observationsPoolMaxTokens: 10, observationsPoolTargetTokens: 5 });
		run.fire(); await run.runLaunchedWork();
		expect(mockAgents.runObserver).not.toHaveBeenCalled();
		expect(mockAgents.runReflector).toHaveBeenCalledTimes(1);
		expect(mockAgents.runDropper).not.toHaveBeenCalled();
	});
	it.each([
		{ name: "两种维护次数都已用完", reflectorUsed: true, reflectAfterTokens: 1, observationsPoolMaxTokens: 100 },
		{ name: "清理已用完且反思未到期", reflectorUsed: false, reflectAfterTokens: 99_999, observationsPoolMaxTokens: 1_000 },
	])("不可运行的维护不能挡住固定快照追赶：$name", async (options) => {
		const entries = [
			textCustomMessage("old-source", "旧事实"),
			observationsRecordedEntry("old-record", { observations: [observation("aaaaaaaaaaaa", { sourceEntryIds: ["old-source"] })], coversUpToId: "old-source" }),
			...(options.reflectorUsed ? [{ type: "custom", id: "used-reflector", parentId: null, timestamp: "2026-05-02T10:00:00Z", customType: OM_WORKER_ATTEMPTED, data: { stage: "reflector" } }] : []),
			{ type: "custom", id: "used-dropper", parentId: null, timestamp: "2026-05-02T10:00:00Z", customType: OM_WORKER_ATTEMPTED, data: { stage: "dropper" } },
			textCustomMessage("raw-1", "a".repeat(800)), textCustomMessage("raw-2", "b".repeat(800)),
		];
		const run = setup({ entries, compactAfterTokens: 300, observerChunkMaxTokens: 256, reflectAfterTokens: options.reflectAfterTokens, observationsPoolMaxTokens: options.observationsPoolMaxTokens, observationsPoolTargetTokens: 5 });
		run.fire(); await run.runLaunchedWork();
		expect(mockAgents.runObserver.mock.calls.map((call) => call[0].allowedSourceEntryIds)).toEqual([["raw-1"], ["raw-2"]]);
		expect(mockAgents.runReflector).not.toHaveBeenCalled();
		expect(mockAgents.runDropper).not.toHaveBeenCalled();
	});
	it("接近压缩时先追赶观察，暂缓反思与精简", async () => {
		const run = setup({ entries: [textCustomMessage("raw-1", "a".repeat(800)), textCustomMessage("raw-2", "b".repeat(800))], compactAfterTokens: 300, observerChunkMaxTokens: 256 });
		mockAgents.runObserver.mockImplementation(async (args) => ({ observations: args.allowedSourceEntryIds.includes("raw-1") ? [obsA] : [], complete: true }));
		run.fire(); await run.runLaunchedWork();
		expect(mockAgents.runObserver.mock.calls.map((call) => call[0].allowedSourceEntryIds)).toEqual([["raw-1"], ["raw-2"]]);
		expect(mockAgents.runReflector).not.toHaveBeenCalled();
		expect(mockAgents.runDropper).not.toHaveBeenCalled();
	});
	it("压力追赶固定快照，不无限追逐主任务新增消息", async () => {
		const run = setup({ entries: [textCustomMessage("raw-1", "a".repeat(800)), textCustomMessage("raw-2", "b".repeat(800))], compactAfterTokens: 300, observerChunkMaxTokens: 256 });
		mockAgents.runObserver.mockImplementation(async (args) => {
			run.addEntries(textCustomMessage("later-" + mockAgents.runObserver.mock.calls.length, "稍后处理"));
			return { observations: args.allowedSourceEntryIds.includes("raw-1") ? [obsA] : [], complete: true };
		});
		run.fire(); await run.runLaunchedWork();
		expect(mockAgents.runObserver.mock.calls.map((call) => call[0].allowedSourceEntryIds)).toEqual([["raw-1"], ["raw-2"]]);
		expect(mockAgents.runReflector).not.toHaveBeenCalled();
	});
	it("积压追上后恢复维护，不让反思永久饥饿", async () => {
		const run = setup({ entries: [textCustomMessage("raw-1", "a".repeat(800))], compactAfterTokens: 100 });
		mockAgents.runObserver.mockResolvedValue({ observations: [obsA], complete: true });
		run.fire(); await run.runLaunchedWork();
		expect(mockAgents.runReflector).not.toHaveBeenCalled();
		run.runtime.consolidationInFlight = false;
		run.fire(); await run.runLaunchedWork();
		expect(mockAgents.runReflector).toHaveBeenCalledOnce();
	});
	it("观察池压力升高时让维护插入，不为追赶耗尽后续输入预算", async () => {
		const run = setup({ entries: [textCustomMessage("raw-1", "a".repeat(800)), textCustomMessage("raw-2", "b".repeat(800))], compactAfterTokens: 300, observerChunkMaxTokens: 256, observationsPoolMaxTokens: 10, observationsPoolTargetTokens: 5 });
		mockAgents.runObserver.mockResolvedValue({ observations: [obsA], complete: true });
		run.fire(); await run.runLaunchedWork();
		expect(mockAgents.runObserver).toHaveBeenCalledOnce();
		expect(mockAgents.runReflector).toHaveBeenCalledOnce();
		expect(mockAgents.runDropper).toHaveBeenCalledOnce();
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
		expect(memoryWrites(run)).toHaveLength(0);
	});
	it("stale-ctx 作为取消处理，不打扰用户", async () => {
		mockAgents.runObserver.mockRejectedValueOnce(new Error("This extension ctx is stale after session replacement or reload."));
		const run = setup({ entries: [textCustomMessage("raw-1", "aaaaaaaa")] });
		run.fire(); await run.runLaunchedWork();
		expect(run.ctx.ui.notify.mock.calls.every((call) => call[1] !== "warning")).toBe(true);
		expect(memoryWrites(run)).toHaveLength(0);
	});
});
