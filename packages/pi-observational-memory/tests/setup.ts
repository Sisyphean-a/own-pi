import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// 自动诊断也会在测试中触发；禁止写入开发者的真实 Pi 目录。
const previous = process.env.PI_CODING_AGENT_DIR;
const directory = mkdtempSync(join(tmpdir(), "om-test-agent-"));
process.env.PI_CODING_AGENT_DIR = directory;
afterAll(() => {
	if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previous;
	rmSync(directory, { recursive: true, force: true });
});
