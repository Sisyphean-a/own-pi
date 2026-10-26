import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, statSync, unlinkSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const DEBUG_LOG_MAX_BYTES = 10 * 1024 * 1024;
export const DEBUG_LOG_RELATIVE_PATH = join("observational-memory", "debug.ndjson");
export const DEBUG_LOG_SESSION_DIR_RELATIVE_PATH = join("observational-memory", "debug");

export interface DebugLogContext {
	enabled: boolean;
	cwd?: string;
	sessionId?: string;
	sessionFile?: string;
	runId?: string;
}

const storage = new AsyncLocalStorage<DebugLogContext>();

export function withDebugLogContext<T>(context: DebugLogContext, fn: () => T): T {
	const parent = storage.getStore();
	return storage.run({ ...parent, ...context }, fn);
}

export function safeDebugLogSessionId(sessionId: string | undefined): string | undefined {
	const trimmed = sessionId?.trim();
	if (!trimmed) return undefined;
	const sanitized = trimmed
		.replace(/[^A-Za-z0-9._-]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 128);
	if (!/[A-Za-z0-9]/.test(sanitized)) return undefined;
	return sanitized;
}

export function debugLogRelativePath(context: Pick<DebugLogContext, "sessionId">): string {
	const safeSessionId = safeDebugLogSessionId(context.sessionId);
	return safeSessionId
		? join(DEBUG_LOG_SESSION_DIR_RELATIVE_PATH, `${safeSessionId}.ndjson`)
		: DEBUG_LOG_RELATIVE_PATH;
}

export interface DiagnosticReference {
	id: string;
	path: string;
	writeError?: string;
}

const errorReferences = new WeakMap<object, { reference: DiagnosticReference; scope: string; workerId?: string }>();

export function diagnosticLogPath(sessionId?: string): string {
	return join(getAgentDir(), debugLogRelativePath({ sessionId }));
}

/** 错误文本只保留有界片段，并遮蔽常见凭据；调用方不得传入提示词、参数或响应正文。 */
export function diagnosticText(value: string): string {
	return value.split("\n\nReceived arguments:")[0]
		.replace(/\bBearer\s+[^\s"',;]+/gi, "Bearer [已隐藏]")
		.replace(/(\b(?:api[-_]?key|authorization|access_token|refresh_token|password)\b["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi, "$1[已隐藏]")
		.replace(/\bsk-[A-Za-z0-9_-]+\b/g, "[已隐藏]")
		.slice(0, 4_000);
}

export function diagnosticError(error: unknown): { name: string; message: string; stack?: string } {
	try {
		const details = error as { name?: unknown; message?: unknown; stack?: unknown } | null;
		return typeof details?.message === "string"
			? { name: typeof details.name === "string" ? details.name : "Error", message: diagnosticText(details.message), stack: typeof details.stack === "string" ? diagnosticText(details.stack) : undefined }
			: { name: "NonError", message: diagnosticText(String(error)) };
	} catch {
		return { name: "UnreadableError", message: "异常对象无法读取；原始异常仍由调用方保留" };
	}
}

/** 基本运行摘要和错误始终落盘，不进入会话、记忆或模型上下文。 */
export function diagnosticLog(event: string, data: Record<string, unknown> = {}): DiagnosticReference {
	const context = storage.getStore();
	const reference: DiagnosticReference = { id: randomUUID().replaceAll("-", "").slice(0, 12), path: "" };
	try {
		reference.path = diagnosticLogPath(context?.sessionId);
		mkdirSync(dirname(reference.path), { recursive: true });
		rotateIfNeeded(reference.path);
		appendFileSync(reference.path, `${JSON.stringify({
			ts: new Date().toISOString(), schemaVersion: 1, event, diagnosticId: reference.id,
			cwd: context?.cwd, sessionId: context?.sessionId, sessionFile: context?.sessionFile, runId: context?.runId, data,
		})}\n`, "utf-8");
	} catch (error) {
		// 日志失败不替换原始异常；错误提示会明确说明诊断未能落盘。
		reference.writeError = (error as { code?: string })?.code ?? "LOG_WRITE_FAILED";
	}
	return reference;
}

/** 对话只显示短原因与编号，完整证据留在本地日志。 */
export function diagnosticNotice(error: unknown, reference: DiagnosticReference): string {
	const message = diagnosticError(error).message.replace(/\s+/g, " ").slice(0, 180);
	return `${message}（诊断 ${reference.id}${reference.writeError ? `，日志写入失败：${reference.writeError}` : ""}）`;
}

export function recordDiagnosticError(event: string, error: unknown, data: Record<string, unknown> = {}): DiagnosticReference {
	const object = error !== null && (typeof error === "object" || typeof error === "function") ? error : undefined;
	const context = storage.getStore();
	const scope = `${context?.sessionId ?? ""}:${context?.runId ?? ""}`;
	const workerId = typeof data.workerId === "string" ? data.workerId : undefined;
	const previous = object ? errorReferences.get(object) : undefined;
	if (previous?.scope === scope && (!workerId || previous.workerId === workerId)) return previous.reference;
	const reference = diagnosticLog(event, { ...data, error: diagnosticError(error) });
	if (object) errorReferences.set(object, { reference, scope, workerId });
	return reference;
}

export function debugLog(event: string, data: Record<string, unknown> = {}): void {
	if (storage.getStore()?.enabled === true) diagnosticLog(event, data);
}

function rotateIfNeeded(path: string): void {
	if (!existsSync(path)) return;
	if (statSync(path).size < DEBUG_LOG_MAX_BYTES) return;
	const backupPath = `${path}.1`;
	if (existsSync(backupPath)) unlinkSync(backupPath);
	renameSync(path, backupPath);
}
