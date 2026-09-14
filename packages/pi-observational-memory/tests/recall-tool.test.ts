import { describe, expect, it, vi } from "vitest";

import {
	RECALL_OBSERVATION_TOOL_NAME,
	formatRecallCallForTui,
	formatRecallRenderedResultForTui,
	recallObservationTool,
	registerRecallTool,
} from "../src/tools/recall-observation.js";
import {
	observation,
	observationsDroppedEntry,
	observationsRecordedEntry,
	oldV2ObservationEntry,
	rawMessage,
	reflection,
	reflectionsRecordedEntry,
	type TestEntry,
} from "./fixtures/session.js";

function fakeCtx(entries: TestEntry[]) {
	const getBranch = vi.fn(() => entries);
	const getEntries = vi.fn(() => {
		throw new Error("recall tool must not use getEntries");
	});
	return { ctx: { sessionManager: { getBranch, getEntries } }, getBranch, getEntries };
}

async function execute(id: string, entries: TestEntry[]) {
	const { ctx, getBranch, getEntries } = fakeCtx(entries);
	const result: any = await recallObservationTool.execute("tool-1", { id }, undefined as any, undefined as any, ctx as any);
	const text = (result.content as Array<{ type: string; text?: string }>)
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
	return { result, text, getBranch, getEntries };
}

describe("V3 recall tool", () => {
	it("keeps the public tool name and TUI call rendering", () => {
		const pi = { registerTool: vi.fn() };
		registerRecallTool(pi as any);

		expect(RECALL_OBSERVATION_TOOL_NAME).toBe("recall");
		expect(recallObservationTool.name).toBe("recall");
		expect(recallObservationTool.label).toBe("召回记忆证据");
		expect(formatRecallCallForTui("aaaaaaaaaaaa")).toBe("召回 aaaaaaaaaaaa");
		expect(pi.registerTool).toHaveBeenCalledWith(recallObservationTool);
	});

	it("renders active observation source evidence", async () => {
		const obs = observation("aaaaaaaaaaaa", { content: "User likes tea.", sourceEntryIds: ["raw-1"] });
		const entries = [rawMessage("raw-1", "I like tea."), observationsRecordedEntry("om-obs", { observations: [obs], coversUpToId: "raw-1" })];

		const { result, text, getBranch, getEntries } = await execute("aaaaaaaaaaaa", entries);

		expect(getBranch).toHaveBeenCalledOnce();
		expect(getEntries).not.toHaveBeenCalled();
		expect(result.details?.status).toBe("ok");
		expect(result.details?.matches[0].observation.status).toBe("active");
		expect(text).toContain("I like tea.");
		expect(formatRecallRenderedResultForTui(result as any, false)).toContain("✓ 观察");
	});

	it("renders dropped observations as recallable but dropped", async () => {
		const obs = observation("aaaaaaaaaaaa", { content: "User likes tea.", sourceEntryIds: ["raw-1"] });
		const entries = [
			rawMessage("raw-1", "I like tea."),
			observationsRecordedEntry("om-obs", { observations: [obs], coversUpToId: "raw-1" }),
			observationsDroppedEntry("om-drop", { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "om-obs" }),
		];

		const { result, text } = await execute("aaaaaaaaaaaa", entries);
		const tui = formatRecallRenderedResultForTui(result as any, false);

		expect(result.details?.matches[0].observation.status).toBe("dropped");
		expect(text).toContain("已从活跃记忆精简，但仍可召回");
		expect(tui).toContain("已精简");
	});

	it("renders reflection recall with supporting observations and sources", async () => {
		const obs = observation("aaaaaaaaaaaa", { content: "User likes tea.", sourceEntryIds: ["raw-1"] });
		const ref = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"], { content: "User likes tea." });
		const entries = [
			rawMessage("raw-1", "I like tea."),
			observationsRecordedEntry("om-obs", { observations: [obs], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-ref", { reflections: [ref], coversUpToId: "om-obs" }),
		];

		const { result, text } = await execute("eeeeeeeeeeee", entries);

		expect(result.details?.status).toBe("ok");
		expect(result.details?.reflections).toHaveLength(1);
		expect(result.details?.observations).toHaveLength(1);
		expect(text).toContain("反思：");
		expect(text).toContain("[eeeeeeeeeeee] User likes tea.");
		expect(text).toContain("观察：");
		expect(text).toContain("源内容：");
		expect(text).toContain("I like tea.");
	});

	it("reports missing sources as partial", async () => {
		const obs = observation("aaaaaaaaaaaa", { sourceEntryIds: ["missing-raw"] });
		const entries = [observationsRecordedEntry("om-obs", { observations: [obs], coversUpToId: "om-obs" })];

		const { result, text } = await execute("aaaaaaaaaaaa", entries);

		expect(result.details?.status).toBe("partial");
		expect(result.details?.missingSourceEntryIds).toEqual(["missing-raw"]);
		expect(text).toContain("缺失：missing-raw");
	});

	it("reports invalid ids without reading the branch", async () => {
		const { result, text, getBranch } = await execute("not-valid", []);

		expect(result.details?.status).toBe("invalid_id");
		expect(text).toContain("记忆 id 必须是 12 位小写十六进制字符");
		expect(getBranch).not.toHaveBeenCalled();
	});

	it("reports not found and ignores old V2 memory", async () => {
		const entries = [oldV2ObservationEntry("v2-obs")];

		const { result, text } = await execute("aaaaaaaaaaaa", entries);

		expect(result.details?.status).toBe("not_found");
		expect(text).toContain("当前分支上找不到 id 为 aaaaaaaaaaaa 的观察或反思");
	});
});
