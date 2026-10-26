import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ agentDir: "" }));

vi.mock("@earendil-works/pi-coding-agent", () => ({
	getAgentDir: () => mock.agentDir,
}));

import {
	DEBUG_LOG_RELATIVE_PATH,
	DEBUG_LOG_MAX_BYTES,
	diagnosticLog,
	diagnosticNotice,
	recordDiagnosticError,
	debugLog,
	debugLogRelativePath,
	safeDebugLogSessionId,
	withDebugLogContext,
} from "../src/debug-log.js";

describe("debug logging", () => {
	let root: string;
	let agentDir: string;

	beforeEach(() => {
		root = `${tmpdir()}/om-debug-log-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
		agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		mock.agentDir = agentDir;
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function readJsonLines(path: string): any[] {
		return readFileSync(path, "utf-8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	}

	it("writes enabled events to a session-scoped debug file with session metadata", () => {
		withDebugLogContext({
			enabled: true,
			cwd: "/tmp/project",
			sessionId: "session-123",
			sessionFile: "/tmp/session.jsonl",
			runId: "run-1",
		}, () => {
			debugLog("dropper.result", { reason: "no_tool_call" });
		});

		const logPath = join(agentDir, "observational-memory", "debug", "session-123.ndjson");
		expect(existsSync(logPath)).toBe(true);
		expect(existsSync(join(agentDir, DEBUG_LOG_RELATIVE_PATH))).toBe(false);
		expect(readJsonLines(logPath)).toMatchObject([
			{
				event: "dropper.result",
				cwd: "/tmp/project",
				sessionId: "session-123",
				sessionFile: "/tmp/session.jsonl",
				runId: "run-1",
				data: { reason: "no_tool_call" },
			},
		]);
	});

	it("appends multiple runs for the same session to the same debug file", () => {
		withDebugLogContext({ enabled: true, sessionId: "session-abc", runId: "run-1" }, () => debugLog("one"));
		withDebugLogContext({ enabled: true, sessionId: "session-abc", runId: "run-2" }, () => debugLog("two"));

		const logPath = join(agentDir, "observational-memory", "debug", "session-abc.ndjson");
		expect(readJsonLines(logPath).map((row) => row.runId)).toEqual(["run-1", "run-2"]);
	});

	it("uses different debug files for different sessions", () => {
		withDebugLogContext({ enabled: true, sessionId: "session-a" }, () => debugLog("event"));
		withDebugLogContext({ enabled: true, sessionId: "session-b" }, () => debugLog("event"));

		expect(existsSync(join(agentDir, "observational-memory", "debug", "session-a.ndjson"))).toBe(true);
		expect(existsSync(join(agentDir, "observational-memory", "debug", "session-b.ndjson"))).toBe(true);
	});

	it("falls back to the legacy global debug file without a usable session id", () => {
		withDebugLogContext({ enabled: true, cwd: "/tmp/project", runId: "run-1" }, () => debugLog("observer.start"));
		withDebugLogContext({ enabled: true, sessionId: "---" }, () => debugLog("observer.start"));

		const logPath = join(agentDir, DEBUG_LOG_RELATIVE_PATH);
		expect(readJsonLines(logPath)).toMatchObject([
			{ event: "observer.start", cwd: "/tmp/project", runId: "run-1" },
			{ event: "observer.start" },
		]);
	});

	it("sanitizes session ids before using them as filenames", () => {
		expect(safeDebugLogSessionId(" session/../id:value ")).toBe("session_.._id_value");
		expect(debugLogRelativePath({ sessionId: " session/../id:value " })).toBe(join("observational-memory", "debug", "session_.._id_value.ndjson"));
		expect(debugLogRelativePath({ sessionId: "---" })).toBe(DEBUG_LOG_RELATIVE_PATH);
	});

	it("基本诊断不依赖 debug，分层捕获同一异常只生成一个诊断编号", () => {
		const error = new Error("缺少完成确认");
		withDebugLogContext({ enabled: false, sessionId: "auto" }, () => {
			const first = recordDiagnosticError("worker.failed", error, { failureCode: "missing_completion" });
			const second = recordDiagnosticError("extension.error", error);
			expect(second).toBe(first);
			expect(readJsonLines(first.path)).toHaveLength(1);
			expect(readJsonLines(first.path)[0]).toMatchObject({ diagnosticId: first.id, data: { failureCode: "missing_completion" } });
		});
	});

	it("重试复用同一个异常对象时每次调用仍分别留痕，外层捕获只复用本轮编号", () => {
		withDebugLogContext({ enabled: false, sessionId: "retry", runId: "pipeline" }, () => {
			const error = new Error("shared failure");
			const first = recordDiagnosticError("worker.failed", error, { workerId: "attempt-1" });
			const second = recordDiagnosticError("worker.failed", error, { workerId: "attempt-2" });
			expect(first.id).not.toBe(second.id);
			expect(recordDiagnosticError("stage.error", error)).toBe(second);
			expect(readJsonLines(second.path)).toHaveLength(2);
		});
	});

	it("同一个异常对象跨会话复用时不会串到旧日志", () => {
		const error = new Error("shared failure");
		const first = withDebugLogContext({ enabled: false, sessionId: "first" }, () => recordDiagnosticError("error", error));
		const second = withDebugLogContext({ enabled: false, sessionId: "second" }, () => recordDiagnosticError("error", error));
		expect(first.path).not.toBe(second.path);
		expect(readJsonLines(second.path)[0].sessionId).toBe("second");
	});

	it("错误中的常见凭据和 SDK 原始参数不会进入诊断，通知不展开堆栈", () => {
		const error = new Error('Authorization: Bearer SUPER_SECRET apiKey=PRIVATE_KEY sk-private123\n\nReceived arguments:\nPRIVATE_ARGUMENT');
		const reference = recordDiagnosticError("error", error);
		const text = readFileSync(reference.path, "utf8");
		for (const secret of ["SUPER_SECRET", "PRIVATE_KEY", "sk-private123", "PRIVATE_ARGUMENT"]) expect(text).not.toContain(secret);
		expect(diagnosticNotice(error, reference)).toContain(reference.id);
		expect(diagnosticNotice(error, reference)).not.toContain(" at ");
		expect(diagnosticNotice(new Error("x".repeat(10_000)), reference).length).toBeLessThan(240);
	});

	it("异常对象本身无法读取时，采集器不会再抛出新异常", () => {
		const error = { get message() { throw new Error("getter failed"); } };
		const reference = recordDiagnosticError("error", error);
		expect(readJsonLines(reference.path)[0].data.error.name).toBe("UnreadableError");
	});

	it("写入失败显式可见，但不替换原始异常", () => {
		const blocked = join(root, "blocked");
		writeFileSync(blocked, "not a directory");
		mock.agentDir = blocked;
		const reference = recordDiagnosticError("error", new Error("original failure"));
		expect(reference.writeError).toBeTruthy();
		expect(diagnosticNotice(new Error("original failure"), reference)).toContain("日志写入失败");
	});

	it("自动诊断复用既有轮转上限，只保留一个备份", () => {
		const first = diagnosticLog("first");
		writeFileSync(first.path, "a".repeat(DEBUG_LOG_MAX_BYTES));
		diagnosticLog("second");
		expect(existsSync(first.path + ".1")).toBe(true);
		writeFileSync(first.path, "b".repeat(DEBUG_LOG_MAX_BYTES));
		diagnosticLog("third");
		expect(readFileSync(first.path + ".1", "utf8")[0]).toBe("b");
		expect(existsSync(first.path + ".2")).toBe(false);
	});

	it("does not write logs when disabled", () => {
		withDebugLogContext({ enabled: false, sessionId: "session-123" }, () => debugLog("dropper.result"));

		expect(existsSync(join(agentDir, "observational-memory"))).toBe(false);
	});
});
