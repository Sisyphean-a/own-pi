import { describe, expect, it } from "vitest";
import { renderRecallSourceEntry, serializeSourceAddressedBranchEntries, serializeBranchEntries } from "../src/serialize.js";
import { estimateStringTokens } from "../src/tokens.js";
import { textCustomMessage } from "./fixtures/session.js";

describe("连续源分片", () => {
	it("预算充足时完整保留源标签与内容", () => {
		const result = serializeSourceAddressedBranchEntries([textCustomMessage("a", "first"), textCustomMessage("b", "second")], { maxTokens: 1_000 });
		expect(result.sourceEntryIds).toEqual(["a", "b"]);
		expect(result.nextSourceOffset).toBeUndefined();
		expect(result.estimatedTokens).toBe(estimateStringTokens(result.text));
	});
	it("一批只放得下首条时将下一条留给后续运行", () => {
		const first = textCustomMessage("a", "x".repeat(80)), second = textCustomMessage("b", "y".repeat(80));
		const budget = serializeSourceAddressedBranchEntries([first]).estimatedTokens;
		const result = serializeSourceAddressedBranchEntries([first, second], { maxTokens: budget });
		expect(result.sourceEntryIds).toEqual(["a"]);
		expect(result.nextSourceOffset).toBeUndefined();
	});
	it("连标签都放不下时不破坏源 id", () => {
		expect(serializeSourceAddressedBranchEntries([textCustomMessage("a", "内容")], { maxTokens: 1 })).toEqual({ text: "", sourceEntryIds: [], estimatedTokens: 0 });
	});
	it("连续分片不丢失中间内容，且原文召回不受预算影响", () => {
		const source = textCustomMessage("huge", "HEAD:" + "x".repeat(2_000) + ":MIDDLE:" + "y".repeat(2_000) + ":TAIL");
		const fragments: string[] = [];
		let offset = 0;
		for (let i = 0; i < 100; i++) {
			const result = serializeSourceAddressedBranchEntries([source], { maxTokens: 100, startOffset: offset });
			expect(result.estimatedTokens).toBeLessThanOrEqual(100);
			fragments.push(result.text);
			if (result.nextSourceOffset === undefined) break;
			expect(result.nextSourceOffset).toBeGreaterThan(offset);
			offset = result.nextSourceOffset;
		}
		expect(fragments.join("")).toContain(":MIDDLE:");
		expect(fragments.at(-1)).toContain(":TAIL");
		expect(renderRecallSourceEntry(source)).toContain(source.content);
	});
	it("每个源字符都按顺序恰好读取一次", () => {
		const source = textCustomMessage("huge", "🙂中\\\"".repeat(500));
		const rendered = serializeBranchEntries([source]);
		let offset = 0, restored = "";
		for (let i = 0; i < 100; i++) {
			const result = serializeSourceAddressedBranchEntries([source], { maxTokens: 100, startOffset: offset });
			const next = result.nextSourceOffset ?? rendered.length;
			const fragment = rendered.slice(offset, next);
			expect(result.text.endsWith(fragment)).toBe(true);
			restored += fragment;
			if (result.nextSourceOffset === undefined) break;
			expect(/[\uD800-\uDBFF]$/.test(fragment)).toBe(false);
			offset = next;
		}
		expect(restored).toBe(rendered);
	});
	it("观察输入排除助手思考，原始证据召回仍保留", () => {
		const source = { type: "message", id: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "未证实的猜测" }, { type: "text", text: "准备运行测试" }] } };
		expect(serializeBranchEntries([source])).not.toContain("未证实的猜测");
		expect(renderRecallSourceEntry(source)).toContain("未证实的猜测");
	});
});
