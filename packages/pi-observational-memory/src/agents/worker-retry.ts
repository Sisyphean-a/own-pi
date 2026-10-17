import { isRetryableAssistantError, type AssistantMessage } from "@earendil-works/pi-ai";
import { debugLog } from "../debug-log.js";

/** 单次 worker 调用之外的额外重试次数；总尝试次数为该值加一。 */
export const WORKER_MAX_RETRIES = 2;
/** 首次重试前的等待时间；之后按两倍退避。 */
export const WORKER_RETRY_BASE_DELAY_MS = 2_000;

/**
 * worker 的 LLM 流以 error/aborted 结束。
 *
 * `stopReason` 与 `errorMessage` 保留给重试判定：只有 provider 的瞬态传输或服务端失败
 * 才重跑；额度耗尽、认证失败和确定性协议错误立即上报。
 */
export class WorkerStreamError extends Error {
	constructor(
		readonly stopReason: string,
		readonly errorMessage: string | undefined,
		message: string,
	) {
		super(message);
		this.name = "WorkerStreamError";
	}
}

/** 只有带结构化流错误的瞬态失败才重试；缺回执、校验失败和预算失败是确定性的。 */
export function isRetryableWorkerError(error: unknown): boolean {
	if (!(error instanceof WorkerStreamError)) return false;
	// 判定只读取 stopReason 与 errorMessage，不需要完整的助手消息。
	const failure = {
		stopReason: error.stopReason,
		errorMessage: error.errorMessage,
	} as unknown as AssistantMessage;
	return isRetryableAssistantError(failure);
}

export interface WorkerRetryOptions {
	maxRetries?: number;
	baseDelayMs?: number;
	/** 每次重试前调用；返回 false 表示会话已失效，放弃重试。 */
	shouldContinue?: () => boolean;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 重跑一次完整的 worker 调用。
 *
 * Rule: 重试粒度是整个 worker 调用，不是流内续传。已 yield 的 partial 消息无法安全
 * 回滚，Pi 主会话对同类错误也是重启最后一轮助手回合。
 *
 * Guarantee: worker 工具只修改本次调用内的内存状态，账本提交发生在 runX 返回之后，
 * 因此重试不会产生重复条目或部分结果。
 */
export async function runWorkerWithRetry<T>(
	label: string,
	run: () => Promise<T>,
	options: WorkerRetryOptions = {},
): Promise<T> {
	const maxRetries = options.maxRetries ?? WORKER_MAX_RETRIES;
	const baseDelayMs = options.baseDelayMs ?? WORKER_RETRY_BASE_DELAY_MS;
	for (let attempt = 0; ; attempt++) {
		try {
			return await run();
		} catch (error) {
			if (attempt >= maxRetries || !isRetryableWorkerError(error)) throw error;
			if (options.shouldContinue && !options.shouldContinue()) throw error;
			const delayMs = baseDelayMs * 2 ** attempt;
			const failure = error as WorkerStreamError;
			debugLog(`${label}.retry`, {
				attempt: attempt + 1,
				maxRetries,
				delayMs,
				stopReason: failure.stopReason,
				errorMessage: failure.errorMessage,
			});
			await delay(delayMs);
			// 退避期间会话可能已被替换：醒来后不得再用旧 ctx 发起调用。
			if (options.shouldContinue && !options.shouldContinue()) throw error;
		}
	}
}
