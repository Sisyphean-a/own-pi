import { describe, expect, it, vi } from "vitest";

import { isStaleSessionError, Runtime } from "../src/runtime.js";

function modelRegistry(args: { found?: unknown; auth?: unknown } = {}) {
	return {
		find: vi.fn(() => args.found),
		getApiKeyAndHeaders: vi.fn(async () => args.auth ?? { ok: true, apiKey: "key", headers: { test: "yes" } }),
	};
}

describe("Runtime V3 behavior", () => {
	it("旧任务结束不能释放新会话的运行锁，并真正取消旧请求", async () => {
		const runtime = new Runtime();
		let releaseOld!: () => void, releaseNew!: () => void;
		let oldSignal: AbortSignal | undefined;
		const old = runtime.launchConsolidationTask({ hasUI: false }, async (signal: AbortSignal) => {
			oldSignal = signal;
			await new Promise<void>((resolve) => { releaseOld = resolve; });
		});
		runtime.endSession();
		expect(oldSignal?.aborted).toBe(true);
		const current = runtime.launchConsolidationTask({ hasUI: false }, () => new Promise<void>((resolve) => { releaseNew = resolve; }));
		releaseOld(); await old;
		expect(runtime.consolidationInFlight).toBe(true);
		expect(runtime.consolidationPromise).toBe(current);
		releaseNew(); await current;
		expect(runtime.consolidationInFlight).toBe(false);
	});
	it("旧会话晚到的普通异常不通知旧 UI，也不覆盖新会话状态", async () => {
		const runtime = new Runtime();
		let releaseOld!: () => void, releaseNew!: () => void;
		let replaced = false;
		const notify = vi.fn();
		const ctx = { hasUI: true, get ui() { if (replaced) throw new Error("旧 UI 不可访问"); return { notify }; } };
		const old = runtime.launchConsolidationTask(ctx, async () => {
			await new Promise<void>((resolve) => { releaseOld = resolve; });
			throw new Error("旧请求晚到的失败");
		});
		runtime.endSession(); replaced = true;
		const current = runtime.launchConsolidationTask({ hasUI: false }, () => new Promise<void>((resolve) => { releaseNew = resolve; }));
		releaseOld(); await old;
		expect(notify).not.toHaveBeenCalled();
		expect(runtime.lastDiagnostic).toBeUndefined();
		expect(runtime.lastObserverError).toBeUndefined();
		expect(runtime.consolidationInFlight).toBe(true);
		releaseNew(); await current;
	});
	it("uses configured model when present", async () => {
		const runtime = new Runtime();
		const configured = { provider: "anthropic", id: "configured" };
		const registry = modelRegistry({ found: configured });
		runtime.config = { ...runtime.config, model: { provider: "anthropic", id: "configured" } };

		const result = await runtime.resolveModel({ model: { provider: "openai" }, modelRegistry: registry, hasUI: false });

		expect(registry.find).toHaveBeenCalledWith("anthropic", "configured");
		expect(result).toEqual({ ok: true, model: configured, apiKey: "key", headers: { test: "yes" } });
	});

	it("falls back to session model and notifies when configured model is missing", async () => {
		const runtime = new Runtime();
		const notify = vi.fn();
		const sessionModel = { provider: "openai" };
		const registry = modelRegistry();
		runtime.config = { ...runtime.config, model: { provider: "anthropic", id: "missing" } };

		const result = await runtime.resolveModel({ model: sessionModel, modelRegistry: registry, hasUI: true, ui: { notify } });

		expect(result).toMatchObject({ ok: true, model: sessionModel });
		expect(notify).toHaveBeenCalledWith(
			"观察式记忆：配置的模型 anthropic/missing 不存在，改用当前会话模型",
			"warning",
		);
	});

	it("returns model resolution failures", async () => {
		const runtime = new Runtime();
		await expect(runtime.resolveModel({ model: undefined, modelRegistry: modelRegistry(), hasUI: false })).resolves.toEqual({
			ok: false,
			reason: "没有可用模型（当前会话没有模型，也未配置观察式记忆模型）",
		});

		const registry = modelRegistry({ auth: { ok: false } });
		await expect(runtime.resolveModel({ model: { provider: "anthropic" }, modelRegistry: registry, hasUI: false })).resolves.toEqual({
			ok: false,
			reason: 'provider "anthropic" 没有 API key 或认证头',
		});
	});

	it("accepts OAuth-shaped auth (headers only, no apiKey)", async () => {
		const runtime = new Runtime();
		const model = { provider: "kimi-coding", id: "kimi-for-coding" };
		const registry = modelRegistry({
			auth: { ok: true, apiKey: undefined, headers: { Authorization: "Bearer oauth-token" } },
		});

		const result = await runtime.resolveModel({ model, modelRegistry: registry, hasUI: false });

		expect(result).toEqual({
			ok: true,
			model,
			apiKey: undefined,
			headers: { Authorization: "Bearer oauth-token" },
		});
	});

	it("accepts apiKey auth unchanged", async () => {
		const runtime = new Runtime();
		const model = { provider: "anthropic", id: "claude" };
		const registry = modelRegistry({ auth: { ok: true, apiKey: "sk-ant-key" } });

		const result = await runtime.resolveModel({ model, modelRegistry: registry, hasUI: false });

		expect(result).toEqual({ ok: true, model, apiKey: "sk-ant-key", headers: undefined });
	});

	it("rejects auth that carries neither apiKey nor usable headers", async () => {
		const runtime = new Runtime();
		const model = { provider: "xai" };

		for (const auth of [
			{ ok: true },
			{ ok: true, apiKey: "" },
			{ ok: true, headers: {} },
			{ ok: true, headers: { Authorization: "" } },
		]) {
			const registry = modelRegistry({ auth });
			await expect(runtime.resolveModel({ model, modelRegistry: registry, hasUI: false })).resolves.toEqual({
				ok: false,
				reason: 'provider "xai" 没有 API key 或认证头',
			});
		}
	});

	it("points OAuth providers at /login when auth resolution fails", async () => {
		const runtime = new Runtime();
		const model = { provider: "openai-codex", id: "gpt-5-codex" };
		const registry = {
			...modelRegistry({ auth: { ok: false, error: "refresh failed" } }),
			isUsingOAuth: vi.fn((candidate: { provider?: string }) => candidate?.provider === "openai-codex"),
		};

		const result = await runtime.resolveModel({ model, modelRegistry: registry, hasUI: false });

		expect(registry.isUsingOAuth).toHaveBeenCalledWith(model);
		expect(result).toEqual({
			ok: false,
			reason: 'provider "openai-codex" 认证失败——OAuth 凭据可能已过期；请运行 \'/login openai-codex\' 重新登录',
		});
	});

	it("tracks consolidation task state", async () => {
		const runtime = new Runtime();
		let release: (() => void) | undefined;
		const work = new Promise<void>((resolve) => {
			release = resolve;
		});

		const promise = runtime.launchConsolidationTask({ hasUI: false }, async () => {
			runtime.consolidationPhase = "observer";
			await work;
		});

		expect(runtime.consolidationInFlight).toBe(true);
		expect(runtime.consolidationPromise).toBe(promise);
		expect(runtime.consolidationPhase).toBe("observer");
		release?.();
		await promise;
		expect(runtime.consolidationInFlight).toBe(false);
		expect(runtime.consolidationPromise).toBeNull();
		expect(runtime.consolidationPhase).toBeUndefined();
	});

	it("records stage-specific consolidation errors", () => {
		const runtime = new Runtime();
		const notify = vi.fn();

		expect(runtime.recordConsolidationStageError({ hasUI: true, ui: { notify } }, "observer", new Error("observe failed"))).toBe("observe failed");
		expect(runtime.recordConsolidationStageError({ hasUI: true, ui: { notify } }, "reflector", new Error("reflect failed"))).toBe("reflect failed");
		expect(runtime.recordConsolidationStageError({ hasUI: true, ui: { notify } }, "dropper", "drop failed")).toBe("drop failed");

		expect(runtime.lastObserverError).toBe("observe failed");
		expect(runtime.lastReflectorError).toBe("reflect failed");
		expect(runtime.lastDropperError).toBe("drop failed");
		expect(notify).toHaveBeenCalledExactlyOnceWith("观察式记忆：记忆暂未更新，当前任务可继续；详情见 /om:status", "warning");
		expect(runtime.lastDiagnostic?.id).toBeTruthy();
	});

	it.each(["observer", "reflector", "dropper"] as const)("关闭通知仍保存阶段错误与诊断：%s", (phase) => {
		const runtime = new Runtime();
		runtime.config.showWorkerNotifications = false;
		const notify = vi.fn();
		runtime.recordConsolidationStageError({ hasUI: true, ui: { notify } }, phase, new Error("实际失败原因"));
		expect(notify).not.toHaveBeenCalled();
		expect(runtime[phase === "observer" ? "lastObserverError" : phase === "reflector" ? "lastReflectorError" : "lastDropperError"]).toBe("实际失败原因");
		expect(runtime.lastDiagnostic?.id).toBeTruthy();
	});
	it("启动新整理不清空未恢复的错误，同次观察暂停只提醒一次", async () => {
		const runtime = new Runtime();
		const notify = vi.fn();
		const ctx = { hasUI: true, ui: { notify } };
		runtime.recordConsolidationStageError(ctx, "observer", new Error("首次失败"));
		runtime.recordConsolidationStageError(ctx, "reflector", new Error("维护失败"));
		await runtime.launchConsolidationTask(ctx, async () => {});
		runtime.recordConsolidationStageError(ctx, "observer", new Error("再次失败"));
		expect(notify).toHaveBeenCalledTimes(1);
		expect(runtime.lastObserverError).toBe("再次失败");
		expect(runtime.lastReflectorError).toBe("维护失败");
	});
	it("切换会话后清空旧错误，允许提醒新会话的首次暂停", () => {
		const runtime = new Runtime();
		const notify = vi.fn();
		const ctx = { hasUI: true, ui: { notify } };
		runtime.recordConsolidationStageError(ctx, "observer", new Error("旧会话失败"));
		runtime.endSession();
		expect(runtime.lastObserverError).toBeUndefined();
		runtime.recordConsolidationStageError(ctx, "observer", new Error("新会话失败"));
		expect(notify).toHaveBeenCalledTimes(2);
	});
	it.each([
		{ phase: "observer" as const, notifications: false },
		{ phase: "reflector" as const, notifications: true },
		{ phase: "dropper" as const, notifications: true },
	])("外层任务错误也遵守阶段通知策略：$phase", async ({ phase, notifications }) => {
		const runtime = new Runtime();
		runtime.config.showWorkerNotifications = notifications;
		const notify = vi.fn();
		await runtime.launchConsolidationTask({ hasUI: true, ui: { notify } }, async () => {
			runtime.consolidationPhase = phase;
			throw new Error("任务异常");
		});
		expect(notify).not.toHaveBeenCalled();
		expect(runtime[phase === "observer" ? "lastObserverError" : phase === "reflector" ? "lastReflectorError" : "lastDropperError"]).toBe("任务异常");
		expect(runtime.lastDiagnostic?.id).toBeTruthy();
	});
	it("提示 UI 失败不替换观察阶段的原始错误", () => {
		const runtime = new Runtime();
		const ctx = { hasUI: true, ui: { notify: () => { throw new Error("UI 不可用"); } } };
		expect(() => runtime.recordConsolidationStageError(ctx, "observer", new Error("原始失败"))).not.toThrow();
		expect(runtime.lastObserverError).toBe("原始失败");
	});
	it("关闭通知时模型回退不额外弹提示", async () => {
		const runtime = new Runtime();
		runtime.config.showWorkerNotifications = false;
		runtime.config.model = { provider: "test", id: "missing" };
		const notify = vi.fn();
		const model = { provider: "test", id: "session" };
		expect(await runtime.resolveModel({ model, modelRegistry: modelRegistry(), hasUI: true, ui: { notify } })).toMatchObject({ ok: true, model });
		expect(notify).not.toHaveBeenCalled();
	});
	it("keeps compaction flags independent", () => {
		const runtime = new Runtime();
		runtime.compactInFlight = true;
		runtime.compactHookInFlight = true;
		expect(runtime.consolidationInFlight).toBe(false);
		expect(runtime.consolidationPhase).toBeUndefined();
	});

	it("forwards env and baseUrl from model registry", async () => {
		const runtime = new Runtime();
		const model = { provider: "cloudflare-workers-ai", id: "@cf/mistralai/mistral-small-3.1-24b-instruct" };
		const registry = modelRegistry({
			auth: {
				ok: true,
				apiKey: "test-key",
				headers: { Authorization: "Bearer test" },
				env: { CLOUDFLARE_ACCOUNT_ID: "abc123" },
				baseUrl: "https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1"
			}
		});

		const result = await runtime.resolveModel({ model, modelRegistry: registry, hasUI: false });

		expect(result).toEqual({
			ok: true,
			model,
			apiKey: "test-key",
			headers: { Authorization: "Bearer test" },
			env: { CLOUDFLARE_ACCOUNT_ID: "abc123" },
			baseUrl: "https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1"
		});
	});
});

describe("session lifecycle", () => {
	it("invalidates in-flight background work when the session ends", () => {
		const runtime = new Runtime();
		const epoch = runtime.sessionEpoch;
		expect(runtime.isSessionCurrent(epoch)).toBe(true);

		runtime.consolidationInFlight = true;
		runtime.consolidationPhase = "reflector";
		runtime.compactInFlight = true;
		runtime.compactHookInFlight = true;

		runtime.endSession();

		expect(runtime.isSessionCurrent(epoch)).toBe(false);
		expect(runtime.consolidationInFlight).toBe(false);
		expect(runtime.consolidationPhase).toBeUndefined();
		expect(runtime.compactInFlight).toBe(false);
		expect(runtime.compactHookInFlight).toBe(false);
	});

	it("recognizes Pi's stale-ctx error as a benign cancellation", () => {
		expect(isStaleSessionError(new Error("This extension ctx is stale after session replacement or reload."))).toBe(true);
		expect(isStaleSessionError(new Error("boom"))).toBe(false);
		expect(isStaleSessionError("ctx is stale")).toBe(true);
	});

	it("records a stale-ctx stage failure without notifying a warning", () => {
		const runtime = new Runtime();
		const notify = vi.fn();

		runtime.recordConsolidationStageError(
			{ hasUI: true, ui: { notify } },
			"reflector",
			new Error("This extension ctx is stale after session replacement or reload."),
		);

		expect(runtime.lastReflectorError).toContain("stale");
		expect(notify).not.toHaveBeenCalled();
	});
});
