import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ agentDir: "" }));
vi.mock("@earendil-works/pi-coding-agent", () => ({ getAgentDir: () => mock.agentDir }));
import { withDiagnosticBoundary } from "../src/diagnostic-boundary.js";

beforeEach(() => { mock.agentDir = mkdtempSync(join(tmpdir(), "om-boundary-diag-")); });
afterEach(() => { rmSync(mock.agentDir, { recursive: true, force: true }); });
const ctx = (id: string) => ({ cwd: "/project", sessionManager: { getSessionId: () => id, getSessionFile: () => `/sessions/${id}.jsonl` } });
const records = (id: string) => readFileSync(join(mock.agentDir, "observational-memory", "debug", `${id}.ndjson`), "utf8").trim().split("\n").map((line) => JSON.parse(line));
function setup(getEpoch = () => 0) {
	const handlers: Record<string, (...args: any[]) => any> = {};
	const raw = {
		on: (event: string, handler: any) => { handlers[event] = handler; return "unsubscribe"; },
		registerCommand: (name: string, command: any) => { handlers[name] = command.handler; },
		registerTool: (tool: any) => { handlers[tool.name] = tool.execute; },
		sendMessage: vi.fn(), sendUserMessage: vi.fn(), appendEntry: vi.fn(),
	};
	return { pi: withDiagnosticBoundary(raw as any, getEpoch), raw, handlers };
}

describe("插件异常边界", () => {
	it("事件同步返回值和取消决定保持原样，不为了日志引入等待", () => {
		const { pi, handlers } = setup();
		const result = { cancel: true };
		expect(pi.on("session_before_compact", () => result)).toBe("unsubscribe");
		expect(handlers.session_before_compact({}, ctx("sync"))).toBe(result);
	});

	it("异步事件异常自动落盘，仍抛出原来的异常，不发模型消息或记忆条目", async () => {
		const { pi, raw, handlers } = setup();
		const error = new Error("event failed");
		pi.on("turn_end", async () => { throw error; });
		await expect(handlers.turn_end({ prompt: "PRIVATE_PROMPT" }, ctx("event"))).rejects.toBe(error);
		expect(records("event")[0]).toMatchObject({ sessionId: "event", data: { operation: "event:turn_end", error: { message: "event failed" } } });
		expect(JSON.stringify(records("event"))).not.toContain("PRIVATE_PROMPT");
		for (const call of [raw.sendMessage, raw.sendUserMessage, raw.appendEntry]) expect(call).not.toHaveBeenCalled();
	});

	it("命令和 recall 未捕获异常同样收集，不记录调用参数", async () => {
		const { pi, handlers } = setup();
		pi.registerCommand("om:status", { handler: () => { throw new Error("status failed"); } });
		pi.registerTool({ name: "recall", execute: async () => { throw new Error("recall failed"); } } as any);
		expect(() => handlers["om:status"]("PRIVATE_ARGUMENT", ctx("command"))).toThrow("status failed");
		await expect(handlers.recall("call-1", { secret: "PRIVATE_ARGUMENT" }, undefined, undefined, ctx("tool"))).rejects.toThrow("recall failed");
		expect(records("command")[0].data.operation).toBe("command:om:status");
		expect(records("tool")[0].data.operation).toBe("tool:recall");
		expect(JSON.stringify([records("command"), records("tool")])).not.toContain("PRIVATE_ARGUMENT");
	});

	it("日志无法落盘时提示问题，但不替换原始异常", () => {
		writeFileSync(join(mock.agentDir, "observational-memory"), "blocked");
		const { pi, handlers } = setup();
		const notify = vi.fn();
		const error = new Error("original");
		pi.on("turn_end", () => { throw error; });
		expect(() => handlers.turn_end({}, { ...ctx("blocked"), hasUI: true, ui: { notify } })).toThrow(error);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("诊断日志写入失败"), "warning");
	});

	it("异步报错时会话已替换，不访问旧上下文或调用旧 UI", async () => {
		writeFileSync(join(mock.agentDir, "observational-memory"), "blocked");
		let epoch = 0;
		const { pi, handlers } = setup(() => epoch);
		const notify = vi.fn();
		const context = { ...ctx("old"), hasUI: true, get ui() { if (epoch) throw new Error("stale ctx"); return { notify }; } };
		const error = new Error("original");
		pi.on("turn_end", async () => { await Promise.resolve(); throw error; });
		const promise = handlers.turn_end({}, context);
		epoch++;
		await expect(promise).rejects.toBe(error);
		expect(notify).not.toHaveBeenCalled();
	});

	it("并发失败仍分别归属各自的会话", async () => {
		const { pi, handlers } = setup();
		pi.on("turn_end", async (_event, context) => { await Promise.resolve(); throw new Error(context.cwd); });
		await Promise.allSettled([handlers.turn_end({}, ctx("a")), handlers.turn_end({}, ctx("b"))]);
		for (const id of ["a", "b"]) expect(records(id)[0].sessionId).toBe(id);
	});
});
