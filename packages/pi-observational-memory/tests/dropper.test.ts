import { describe, expect, it } from "vitest";

import {
	maxDropCountForPool,
	normalizeDropObservationIds,
	observationPoolFullness,
	runDropper,
	selectDropCandidates,
} from "../src/agents/dropper/agent.js";
import { observation, reflection } from "./fixtures/session.js";

function fakeAgentLoop(handler: (prompts: any[], context: any, config: any) => Promise<void> | void): any {
	return ((prompts: any[], context: any, config: any) => ({
		async *[Symbol.asyncIterator]() {},
		result: async () => {
			await handler(prompts, context, config);
			return {};
		},
	})) as any;
}

describe("V3 dropper agent", () => {
	const obsA = observation("aaaaaaaaaaaa", { relevance: "medium" });
	const obsB = observation("bbbbbbbbbbbb", { relevance: "low" });
	const critical = observation("cccccccccccc", { relevance: "critical" });
	const baseArgs = {
		model: {} as any,
		apiKey: "test",
		reflections: [reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"])],
		observations: [obsA, obsB, critical],
		targetTokens: 20,
	};

	it("computes observation pool fullness defensively", () => {
		expect(observationPoolFullness(0, 100)).toBe(0);
		expect(observationPoolFullness(-1, 100)).toBe(0);
		expect(observationPoolFullness(10, 0)).toBe(0);
		expect(observationPoolFullness(10, Number.NaN)).toBe(0);
		expect(observationPoolFullness(25, 100)).toBe(0.25);
	});

	it("computes max drops from token excess above target", () => {
		const observations = Array.from({ length: 10 }, (_, index) =>
			observation(`${index}`.padStart(12, "a"), { relevance: "low", tokenCount: 10 }),
		);

		expect(maxDropCountForPool(observations, 100, 100)).toBe(0);
		expect(maxDropCountForPool(observations, 100, 90)).toBe(1);
		expect(maxDropCountForPool(observations, 100, 50)).toBe(5);
		expect(maxDropCountForPool(observations, 100, 0)).toBe(10);
	});

	it("uses active observation count for target-return max drops while critical ids remain eligible later", () => {
		const observations = [
			observation("aaaaaaaaaaaa", { relevance: "low", tokenCount: 10 }),
			observation("bbbbbbbbbbbb", { relevance: "medium", tokenCount: 10 }),
			observation("cccccccccccc", { relevance: "critical", tokenCount: 10 }),
			observation("dddddddddddd", { relevance: "critical", tokenCount: 10 }),
		];

		expect(maxDropCountForPool(observations, 40, 20)).toBe(2);
	});

	it("keeps core dropper safety guidance in V3 terms", async () => {
		let systemPrompt = "";
		const loop = fakeAgentLoop((_prompts, context) => {
			systemPrompt = context.systemPrompt;
		});

		await runDropper({ ...baseArgs, agentLoop: loop });

		expect(systemPrompt).toContain("活跃记忆的定位");
		expect(systemPrompt).toContain("年龄梯度规则");
		expect(systemPrompt).toContain("critical");
		expect(systemPrompt).toContain("重要度最高、抵抗力最强");
		expect(systemPrompt).toContain("重要度是重要性与抵抗力，不是绝对的保留/精简锁");
		expect(systemPrompt).toContain("coverage 是证据，不是自动决定");
		expect(systemPrompt).toContain("仅有年龄不足以精简");
		expect(systemPrompt).not.toContain("NEVER drop");
		expect(systemPrompt).toContain("保留底线");
		expect(systemPrompt).toContain("不要强行精简");
		expect(systemPrompt).toContain("不能合并观察");
		expect(systemPrompt).toContain("默认动作是保留");
		expect(systemPrompt).toContain("拿不准时就保留");
		expect(systemPrompt).toContain("活跃观察池目标");
		expect(systemPrompt).not.toContain("drop freely");
		expect(systemPrompt).not.toContain("pruner");
		expect(systemPrompt).not.toContain("drop-priority");
		expect(systemPrompt).not.toContain("drop-resistance");
		expect(systemPrompt).not.toContain("Pass strategy");
		expect(systemPrompt).not.toContain("Urgency guidance");
	});

	it("passes target-return max drops as a hard upper bound", async () => {
		let userText = "";
		const loop = fakeAgentLoop((prompts) => {
			userText = prompts[0].content[0].text;
		});

		await runDropper({ ...baseArgs, agentLoop: loop });

		// Pool metrics count full rendered lines: 19 + 18 + 19 = 56 tokens against a 20-token target.
		expect(userText).toContain("相对目标的充满度：约 280%");
		expect(userText).toContain("超出目标约 36 token");
		expect(userText).toContain("[coverage: partial]");
		expect(userText).toContain("[coverage: none]");
		expect(userText).toContain("本次允许的最大精简数：2 条观察");
		expect(userText).toContain("该上限的设定前提是：每一条候选都被判定为明确安全，才能把活跃池拉向目标");
		expect(userText).toContain("这个上限是硬上限，不是目标");
		expect(userText).toContain("若明确安全的观察更少，就少精简或不精简");
		expect(userText).not.toContain("Drop urgency");
		expect(userText).not.toContain("drop-priority");
		expect(userText).not.toContain("drop-resistance");
	});

	it("normalizes active drop ids, filters invalid ids, dedupes, and accepts critical observations", () => {
		expect(normalizeDropObservationIds(["bbbbbbbbbbbb", "missing", "bbbbbbbbbbbb", "cccccccccccc", "aaaaaaaaaaaa"], [obsA, obsB, critical])).toEqual(["bbbbbbbbbbbb", "cccccccccccc", "aaaaaaaaaaaa"]);
		expect(normalizeDropObservationIds(["missing", "cccccccccccc"], [obsA, obsB, critical])).toEqual(["cccccccccccc"]);
		expect(normalizeDropObservationIds(["missing"], [obsA, obsB, critical])).toBeUndefined();
	});

	it("selects final candidates by coverage, lower relevance, age, then stable ordering", () => {
		const highA = observation("aaaaaaaaaaaa", { relevance: "high" });
		const lowA = observation("bbbbbbbbbbbb", { relevance: "low" });
		const medium = observation("dddddddddddd", { relevance: "medium" });
		const lowB = observation("eeeeeeeeeeee", { relevance: "low" });
		const highB = observation("ffffffffffff", { relevance: "high" });
		const critical = observation("111111111111", { relevance: "critical" });
		const observations = [highA, lowA, medium, lowB, highB, critical];

		expect(selectDropCandidates([
			"aaaaaaaaaaaa",
			"missing",
			"111111111111",
			"bbbbbbbbbbbb",
			"dddddddddddd",
			"bbbbbbbbbbbb",
			"eeeeeeeeeeee",
			"ffffffffffff",
		], observations, 3)).toEqual(["bbbbbbbbbbbb", "eeeeeeeeeeee", "dddddddddddd"]);

		const oldHigh = observation("999999999999", { relevance: "high", timestamp: "2026-01-01T00:00:00.000Z" });
		const newHigh = observation("888888888888", { relevance: "high", timestamp: "2026-02-01T00:00:00.000Z" });
		expect(selectDropCandidates(["888888888888", "999999999999"], [oldHigh, newHigh], 1)).toEqual(["999999999999"]);
	});

	it("prefers stronger reflection coverage before relevance when over cap", () => {
		const strongCritical = observation("aaaaaaaaaaaa", { relevance: "critical", timestamp: "2026-01-01T00:00:00.000Z" });
		const partialLow = observation("bbbbbbbbbbbb", { relevance: "low", timestamp: "2026-01-01T00:00:00.000Z" });
		const noneLow = observation("cccccccccccc", { relevance: "low", timestamp: "2026-01-01T00:00:00.000Z" });
		const observations = [strongCritical, partialLow, noneLow];
		const reflections = [
			reflection("rrrrrrrrrrr1", ["aaaaaaaaaaaa", "bbbbbbbbbbbb"]),
			reflection("rrrrrrrrrrr2", ["aaaaaaaaaaaa"]),
		];

		expect(selectDropCandidates(["cccccccccccc", "bbbbbbbbbbbb", "aaaaaaaaaaaa"], observations, 2, reflections)).toEqual(["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
	});

	it("keeps critical lower priority than lower relevance when coverage is equal", () => {
		const critical = observation("aaaaaaaaaaaa", { relevance: "critical", timestamp: "2026-01-01T00:00:00.000Z" });
		const high = observation("bbbbbbbbbbbb", { relevance: "high", timestamp: "2026-01-01T00:00:00.000Z" });
		const low = observation("cccccccccccc", { relevance: "low", timestamp: "2026-01-01T00:00:00.000Z" });
		const observations = [critical, high, low];
		const reflections = [reflection("rrrrrrrrrrr1", ["aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc"]), reflection("rrrrrrrrrrr2", ["aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc"])];

		expect(selectDropCandidates(["aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc"], observations, 2, reflections)).toEqual(["cccccccccccc", "bbbbbbbbbbbb"]);
	});

	it("returns capped coverage-preferred proposed observation ids", async () => {
		const loop = fakeAgentLoop(async (_prompts, context) => {
			await context.tools[0].execute("tool-1", { ids: ["aaaaaaaaaaaa", "missing", "bbbbbbbbbbbb"] });
		});

		// Rendered-line pool is 56 tokens; a 40-token target caps the run at 1 drop.
		await expect(runDropper({ ...baseArgs, targetTokens: 40, agentLoop: loop })).resolves.toEqual(["aaaaaaaaaaaa"]);
	});

	it("returns critical proposed ids when they are the selected valid candidates", async () => {
		const loop = fakeAgentLoop(async (_prompts, context) => {
			await context.tools[0].execute("tool-1", { ids: ["missing", "cccccccccccc"] });
		});

		await expect(runDropper({ ...baseArgs, agentLoop: loop })).resolves.toEqual(["cccccccccccc"]);
	});

	it("returns undefined when only invalid ids are proposed", async () => {
		const loop = fakeAgentLoop(async (_prompts, context) => {
			await context.tools[0].execute("tool-1", { ids: ["missing"] });
		});

		await expect(runDropper({ ...baseArgs, agentLoop: loop })).resolves.toBeUndefined();
	});

	it("dedupes repeated tool calls and enforces one run-level cap", async () => {
		const loop = fakeAgentLoop(async (_prompts, context) => {
			await context.tools[0].execute("tool-1", { ids: ["aaaaaaaaaaaa"] });
			await context.tools[0].execute("tool-2", { ids: ["bbbbbbbbbbbb", "aaaaaaaaaaaa"] });
		});

		// Rendered-line pool is 56 tokens; a 40-token target caps the run at 1 drop.
		await expect(runDropper({ ...baseArgs, targetTokens: 40, agentLoop: loop })).resolves.toEqual(["aaaaaaaaaaaa"]);
	});

	it("returns undefined when no tool call drops observations", async () => {
		const loop = fakeAgentLoop(() => {});
		await expect(runDropper({ ...baseArgs, agentLoop: loop })).resolves.toBeUndefined();
	});

	it("skips the model at or below the target", async () => {
		let called = false;
		const loop = fakeAgentLoop(() => {
			called = true;
		});

		await expect(runDropper({
			...baseArgs,
			// The rendered line for this observation is 18 tokens; an 18-token target is exactly at target.
			observations: [observation("aaaaaaaaaaaa", { relevance: "low" })],
			targetTokens: 18,
			agentLoop: loop,
		})).resolves.toBeUndefined();
		expect(called).toBe(false);
	});
});
