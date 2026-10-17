import { describe, expect, it, vi } from "vitest";
import { WorkerStreamError, isRetryableWorkerError, runWorkerWithRetry } from "../src/agents/worker-retry.js";

function connectionError(): WorkerStreamError {
	return new WorkerStreamError("error", "Connection error.", "反思器流失败，未提交维护结果：Connection error.");
}

describe("worker 瞬态失败重试", () => {
	it("Connection error 后重跑整个 worker 调用", async () => {
		const run = vi.fn().mockRejectedValueOnce(connectionError()).mockResolvedValueOnce("ok");
		await expect(runWorkerWithRetry("reflector", run, { baseDelayMs: 0 })).resolves.toBe("ok");
		expect(run).toHaveBeenCalledTimes(2);
	});

	it("确定性失败立即上报，不重试", async () => {
		const run = vi.fn().mockRejectedValue(new Error("反思器缺少审阅完成回执"));
		await expect(runWorkerWithRetry("reflector", run, { baseDelayMs: 0 })).rejects.toThrow("完成回执");
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("额度耗尽与取消不重试", () => {
		expect(isRetryableWorkerError(new WorkerStreamError("error", "insufficient_quota", "额度耗尽"))).toBe(false);
		expect(isRetryableWorkerError(new WorkerStreamError("aborted", "aborted", "取消"))).toBe(false);
	});

	it("超出重试预算后抛出最后一次失败", async () => {
		const run = vi.fn().mockRejectedValue(connectionError());
		await expect(runWorkerWithRetry("observer", run, { baseDelayMs: 0, maxRetries: 2 })).rejects.toThrow("Connection error.");
		expect(run).toHaveBeenCalledTimes(3);
	});

	it("会话失效后放弃重试", async () => {
		const run = vi.fn().mockRejectedValue(connectionError());
		await expect(runWorkerWithRetry("dropper", run, { baseDelayMs: 0, shouldContinue: () => false })).rejects.toThrow("Connection error.");
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("退避期间会话失效后不再发起调用", async () => {
		vi.useFakeTimers();
		try {
			let sessionAlive = true;
			const run = vi.fn().mockRejectedValue(connectionError());
			const settled = runWorkerWithRetry("observer", run, {
				baseDelayMs: 1_000,
				shouldContinue: () => sessionAlive,
			}).catch((error: unknown) => error);
			await vi.advanceTimersByTimeAsync(0);
			expect(run).toHaveBeenCalledTimes(1);
			sessionAlive = false;
			await vi.advanceTimersByTimeAsync(1_000);
			expect(await settled).toBeInstanceOf(WorkerStreamError);
			expect(run).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("无结构化流信息的普通错误不按瞬态处理", () => {
		expect(isRetryableWorkerError(new Error("Connection error."))).toBe(false);
		expect(isRetryableWorkerError(new WorkerStreamError("error", "invalid request", "请求非法"))).toBe(false);
	});
});
