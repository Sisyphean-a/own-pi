import { describe, expect, it } from "vitest";

import {
	normalizeSupportingObservationIds,
	observationToReflectorLine,
	runReflector,
	summarizeSupportIdCounts,
} from "../src/agents/reflector/agent.js";
import { hashId } from "../src/ids.js";
import { estimateStringTokens } from "../src/tokens.js";
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

describe("V3 reflector agent", () => {
	const obsA = observation("aaaaaaaaaaaa");
	const obsB = observation("bbbbbbbbbbbb");
	const baseArgs = {
		model: {} as any,
		apiKey: "test",
		reflections: [],
		observations: [obsA, obsB],
	};

	it("keeps core reflector prompt guidance in V3 terms", async () => {
		let systemPrompt = "";
		const loop = fakeAgentLoop((_prompts, context) => {
			systemPrompt = context.systemPrompt;
		});

		await runReflector({ ...baseArgs, agentLoop: loop });

		expect(systemPrompt).toContain("你的任务与观察代理不同");
		expect(systemPrompt).toContain("用户断言是权威的");
		expect(systemPrompt).toContain("supportingObservationIds");
		expect(systemPrompt).toContain("覆盖率/来源集合");
		expect(systemPrompt).toContain("不要轻率地改写现有反思");
		expect(systemPrompt).toContain("反思是稀缺、昂贵的持久定位锚点");
		expect(systemPrompt).toContain("不是第二层观察");
		expect(systemPrompt).toContain("过度反思同样是记忆失真");
		expect(systemPrompt).toContain("让临时细节看起来持久");
		expect(systemPrompt).toContain("决策流程：");
		expect(systemPrompt).toContain("先剔除临时、低层、不完整、例行或只对当前工作状态有用的观察");
		expect(systemPrompt).toContain("未来代理效用测试");
		expect(systemPrompt).toContain("避免错误决定、重复工作或违背用户偏好");
		expect(systemPrompt).toContain("如果候选过不了该测试，就让它保持为观察");
		expect(systemPrompt).toContain("如果拿不准，就不产出反思");
		expect(systemPrompt).toContain("high 和 critical 观察值得仔细复核，但不等于自动反思");
		expect(systemPrompt).toContain("不要把每条观察都变成反思");
		expect(systemPrompt).toContain("观察是证据；反思是压缩后的持久结论");
		expect(systemPrompt).toContain("允许单观察反思");
		expect(systemPrompt).toContain("持久的用户偏好、约束、纠正、决定、不变量、已完成成果或长期阻塞");
		expect(systemPrompt).toContain("不要因为观察是 high 或 critical 就复制或轻度改写它");
		expect(systemPrompt).toContain("宁可少而精");
		expect(systemPrompt).toContain("产出零条反思，好过每条观察都产出一条反思");
		expect(systemPrompt).toContain("大多数临时的任务日志观察");
		expect(systemPrompt).toContain("查看过的文件、运行过的命令、失败尝试、部分实现和当前工作状态");
		expect(systemPrompt).toContain("[coverage: none|partial|strong]");
		expect(systemPrompt).toContain("coverage 层级是复核上下文");
		expect(systemPrompt).toContain("coverage 不是配额、目标、优先级分数，也不是\"应当产出反思\"的指令");
		expect(systemPrompt).toContain("支撑 id 与 coverage 管理");
		expect(systemPrompt).toContain("先判断反思内容是否达到持久价值门槛");
		expect(systemPrompt).toContain("应包含所有持久含义已被该反思以同等保真度保留");
		expect(systemPrompt).toContain("supportingObservationIds 不是\"覆盖每条观察\"的清单");
		expect(systemPrompt).toContain("不要为了提高覆盖率计数");
		expect(systemPrompt).toContain("虚假或注水的支撑 id 可能导致下游精简器不安全地裁剪");
		expect(systemPrompt).toContain("即使观察的 coverage 为 none，也要产出零条反思");
		expect(systemPrompt).toContain("反例：已完成：编辑了 src/hooks/reflect-drop-trigger.ts");
		expect(systemPrompt).toContain("正例：已完成：V3 的 reflect/drop 覆盖改用原始进度水位线");
		expect(systemPrompt).toContain("反例：npm test 通过了");
		expect(systemPrompt).toContain("正例：已完成：V3 包命名空间迁移通过完整测试与类型检查");
		expect(systemPrompt).toContain("零反思：新观察只有查看过的文件、运行过的命令、失败尝试、部分实现、临时调试，或没有持久结论的当前工作状态");
		expect(systemPrompt).toContain("重点关注：");
		expect(systemPrompt).toContain("用户身份、角色、偏好、约束和持久纠正");
		expect(systemPrompt).toContain("项目目标、架构、技术决策及其理由");
		expect(systemPrompt).toContain("会在未来轮次中起作用的重复用户行为或偏好");
		expect(systemPrompt).toContain("未来运行不得重做的已完成成果");
		expect(systemPrompt).toContain("应跨压缩存活的持久阻塞、不变量和未决决定");
		expect(systemPrompt).toContain("反思内容规则");
		expect(systemPrompt).toContain("以事实或模式开头");
		expect(systemPrompt).not.toContain("legacy/no-provenance");
		expect(systemPrompt).not.toContain("pruner");
		expect(systemPrompt).not.toContain("Pass strategy");
	});

	it("renders coverage tiers in every active observation line for the reflector", async () => {
		const none = observation("aaaaaaaaaaaa", { content: "Uncovered durable fact" });
		const partial = observation("bbbbbbbbbbbb", { content: "Partially covered fact" });
		const strong = observation("cccccccccccc", { content: "Strongly covered fact" });
		let userText = "";
		const loop = fakeAgentLoop((prompts) => {
			userText = prompts[0].content[0].text;
		});

		await runReflector({
			...baseArgs,
			observations: [none, partial, strong],
			reflections: [
				reflection("rrrrrrrrrrr1", ["bbbbbbbbbbbb", "cccccccccccc"]),
				reflection("rrrrrrrrrrr2", ["cccccccccccc"]),
			],
			agentLoop: loop,
		});

		expect(userText).toContain("[aaaaaaaaaaaa]");
		expect(userText).toContain("[coverage: none] Uncovered durable fact");
		expect(userText).toContain("[coverage: partial] Partially covered fact");
		expect(userText).toContain("[coverage: strong] Strongly covered fact");
		expect(userText).not.toContain("drop-priority");
		expect(userText).not.toContain("drop-resistance");
	});

	it("renders reflector observation lines with coverage evidence only", () => {
		const line = observationToReflectorLine(
			observation("aaaaaaaaaaaa", { relevance: "critical", content: "Important reflected fact" }),
			"partial",
		);

		expect(line).toContain("[aaaaaaaaaaaa]");
		expect(line).toContain("[critical]");
		expect(line).toContain("[coverage: partial]");
		expect(line).toContain("Important reflected fact");
		expect(line).not.toContain("drop-priority");
		expect(line).not.toContain("drop-resistance");
	});

	it("summarizes accepted reflection support-id counts without exposing ids", () => {
		expect(summarizeSupportIdCounts([])).toEqual({
			reflectionCount: 0,
			totalSupportIds: 0,
			minSupportIds: 0,
			maxSupportIds: 0,
			averageSupportIds: 0,
			histogram: {},
		});
		expect(summarizeSupportIdCounts([
			reflection("rrrrrrrrrrr1", ["aaaaaaaaaaaa"]),
			reflection("rrrrrrrrrrr2", ["aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc"]),
		])).toEqual({
			reflectionCount: 2,
			totalSupportIds: 4,
			minSupportIds: 1,
			maxSupportIds: 3,
			averageSupportIds: 2,
			histogram: { "1": 1, "3": 1 },
		});
	});

	it("normalizes supporting observation ids by active observation order", () => {
		expect(normalizeSupportingObservationIds(["bbbbbbbbbbbb", "aaaaaaaaaaaa", "aaaaaaaaaaaa"], ["aaaaaaaaaaaa", "bbbbbbbbbbbb"])).toEqual(["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
		expect(normalizeSupportingObservationIds(["aaaaaaaaaaaa", "missing"], ["aaaaaaaaaaaa"])).toBeUndefined();
		expect(normalizeSupportingObservationIds([], ["aaaaaaaaaaaa"])).toBeUndefined();
	});

	it("records one-line V3 reflections with code-computed ids and token counts", async () => {
		const content = "User prefers source-backed memory.";
		const loop = fakeAgentLoop(async (_prompts, context) => {
			await context.tools[0].execute("tool-1", {
				reflections: [{ content, supportingObservationIds: ["bbbbbbbbbbbb", "aaaaaaaaaaaa"] }],
			});
		});

		const result = await runReflector({ ...baseArgs, agentLoop: loop });

		expect(result).toEqual([{ id: hashId(content), content, supportingObservationIds: ["aaaaaaaaaaaa", "bbbbbbbbbbbb"], tokenCount: estimateStringTokens(content) }]);
	});

	it("rejects invented support ids and multiline content", async () => {
		const loop = fakeAgentLoop(async (_prompts, context) => {
			await context.tools[0].execute("tool-1", {
				reflections: [
					{ content: "Bad support", supportingObservationIds: ["missing"] },
					{ content: "Two\nlines", supportingObservationIds: ["aaaaaaaaaaaa"] },
				],
			});
		});

		await expect(runReflector({ ...baseArgs, agentLoop: loop })).resolves.toBeUndefined();
	});

	it("dedupes proposals and skips existing reflection ids", async () => {
		const content = "User prefers terse updates.";
		const existing = reflection(hashId(content), ["aaaaaaaaaaaa"], { content });
		const loop = fakeAgentLoop(async (_prompts, context) => {
			await context.tools[0].execute("tool-1", {
				reflections: [
					{ content, supportingObservationIds: ["aaaaaaaaaaaa"] },
					{ content: "New durable fact.", supportingObservationIds: ["aaaaaaaaaaaa"] },
					{ content: "New durable fact.", supportingObservationIds: ["bbbbbbbbbbbb"] },
				],
			});
		});

		const result = await runReflector({ ...baseArgs, reflections: [existing], agentLoop: loop });

		expect(result?.map((item) => item.content)).toEqual(["New durable fact."]);
	});

	it("returns undefined when no tool call records reflections", async () => {
		const loop = fakeAgentLoop(() => {});
		await expect(runReflector({ ...baseArgs, agentLoop: loop })).resolves.toBeUndefined();
	});
});
