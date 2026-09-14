import assert from "node:assert/strict";
import test from "node:test";

import type { ContextUsage, SessionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  buildTokenBreakdown,
  buildToolsText,
  formatMessagesText,
  formatTokens,
  isSkillPath,
  type TokenBreakdownDeps,
} from "../src/context/format.ts";
import {
  FRAME_CHROME_HEIGHT,
  frameRow,
  overlayContentHeight,
  type UiTheme,
  type WidthUtils,
} from "../src/context/frame.ts";

// Test seam: 用等宽 ASCII 与 2 列宽的中文模拟 Pi 的显示宽度，避免测试依赖真实终端。
function charWidth(char: string): number {
  const cp = char.codePointAt(0)!;
  return cp >= 0x2e80 && cp <= 0x9fff ? 2 : 1;
}

const widthUtils: WidthUtils = {
  visibleWidth(text: string): number {
    let width = 0;
    for (const char of text) width += charWidth(char);
    return width;
  },
  truncateToWidth(text: string, maxWidth: number): string {
    let result = "";
    let width = 0;
    for (const char of text) {
      const next = charWidth(char);
      if (width + next > maxWidth) break;
      result += char;
      width += next;
    }
    return result;
  },
};

const plainTheme: UiTheme = {
  bold: (text) => text,
  fg: (_color, text) => text,
  bg: (_color, text) => text,
};

const usage: ContextUsage = { tokens: 1000, contextWindow: 10000, percent: 10 };
const deps: TokenBreakdownDeps = { estimateTokens: () => 100, reserveTokens: 2000 };

test("formats token counts with a single scale suffix", () => {
  assert.equal(formatTokens(null), "N/A");
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1500), "2k");
  assert.equal(formatTokens(999_999), "999k");
  assert.equal(formatTokens(1_500_000), "1.5M");
});

test("scales estimated categories so they add up to the provider total", () => {
  const branch = [
    { type: "message", message: { role: "user", content: "x".repeat(400) } },
  ] as unknown as SessionEntry[];

  const breakdown = buildTokenBreakdown("y".repeat(400), [], branch, usage, deps);
  assert.ok(breakdown);
  assert.equal(breakdown.total, 1000);
  assert.equal(breakdown.contextWindow, 10000);
  assert.equal(breakdown.reserveTokens, 2000);
  assert.equal(breakdown.safeAvailable, 7000);
  assert.equal(
    breakdown.systemPrompt +
      breakdown.systemTools +
      breakdown.tools +
      breakdown.skills +
      breakdown.messages +
      breakdown.other,
    1000,
  );
  assert.ok(breakdown.messages > breakdown.systemTools);
});

test("returns no breakdown until the provider reports usage", () => {
  assert.equal(buildTokenBreakdown("", [], [], undefined, deps), null);
  assert.equal(
    buildTokenBreakdown("", [], [], { tokens: null, contextWindow: 10000, percent: null }, deps),
    null,
  );
  assert.equal(
    buildTokenBreakdown("", [], [], { tokens: 100, contextWindow: 0, percent: 1 }, deps),
    null,
  );
});

test("counts skill file reads as skills instead of tools, including Windows paths", () => {
  const skillCall = {
    type: "toolCall",
    id: "call-1",
    name: "read",
    arguments: { path: "C:\\Users\\xiakn\\.pi\\agent\\skills\\cs-feat\\SKILL.md" },
  };
  const branch = [
    { type: "message", message: { role: "assistant", content: [skillCall] } },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "z".repeat(400) }],
      },
    },
  ] as unknown as SessionEntry[];

  const breakdown = buildTokenBreakdown("", [], branch, usage, deps);
  assert.ok(breakdown);
  assert.ok(breakdown.skills > 0);
  assert.equal(breakdown.tools, 0);
});

test("recognizes skill paths with either separator and rejects normal files", () => {
  assert.equal(isSkillPath("C:\\Users\\x\\.pi\\agent\\skills\\a\\SKILL.md"), true);
  assert.equal(isSkillPath("/repo/.agents/skills/a/SKILL.md"), true);
  assert.equal(isSkillPath("skills/foo/SKILL.md"), true);
  assert.equal(isSkillPath("src/index.ts"), false);
  assert.equal(isSkillPath(undefined), false);
});

test("formats session messages with Chinese roles and usage labels", () => {
  const context = {
    messages: [
      { role: "user", content: "你好" },
      {
        role: "assistant",
        provider: "openai",
        model: "gpt",
        usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10 },
        stopReason: "stop",
        content: [{ type: "text", text: "回复" }],
      },
      {
        role: "toolResult",
        toolName: "read",
        toolCallId: "c1",
        isError: false,
        content: [{ type: "text", text: "内容" }],
      },
    ],
  } as unknown as SessionContext;

  const text = formatMessagesText(context);
  assert.match(text, /角色：用户/);
  assert.match(text, /角色：助手/);
  assert.match(text, /停止原因：正常结束/);
  assert.match(text, /Token：输入 1，输出 2，缓存读取 3，缓存写入 4，合计 10/);
  assert.match(text, /工具：read/);
  assert.match(text, /错误：否/);
  assert.equal(formatMessagesText({ messages: [] } as unknown as SessionContext), "（暂无消息）");
});

test("formats tool definitions with required and optional parameters", () => {
  const text = buildToolsText([
    {
      name: "read",
      description: "读取文件",
      parameters: { properties: { path: { type: "string", description: "路径" } }, required: ["path"] },
    },
    { name: "bash", parameters: { properties: { command: { type: "string" } } } },
  ]);

  assert.match(text, /工具：read/);
  assert.match(text, /说明：读取文件/);
  assert.match(text, / {2}path（string）：路径/);
  assert.match(text, / {2}command（string，可选）/);
  assert.equal(buildToolsText([]), "（无已启用工具）");
});

test("keeps frame rows inside the exact column budget", () => {
  assert.equal(frameRow("abc", 10, plainTheme, widthUtils), "│abc       │");

  const long = frameRow(`  ${"中文上下文查看".repeat(6)}`, 20, plainTheme, widthUtils);
  assert.equal(widthUtils.visibleWidth(long), 22);
  assert.ok(long.startsWith("│"));
  assert.ok(long.endsWith("│"));
});

test("sizes the overlay content so the frame fits the terminal", () => {
  assert.equal(overlayContentHeight(50), 28);
  assert.equal(overlayContentHeight(30), 14);
  assert.equal(overlayContentHeight(15), 4);
  assert.equal(overlayContentHeight(4), 4);

  for (let rows = 16; rows <= 80; rows++) {
    const maxHeight = Math.min(Math.floor(rows * 0.7), rows - 2);
    assert.ok(overlayContentHeight(rows) + FRAME_CHROME_HEIGHT <= maxHeight, `rows=${rows}`);
  }
});
