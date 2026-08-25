import assert from "node:assert/strict";
import test from "node:test";

import { createThinkingIndicator } from "../extensions/index.ts";
import { createCompactFooter } from "../src/compact-footer.ts";

const widthUtils = {
  visibleWidth(text: string): number {
    return Array.from(text).length;
  },
  truncateToWidth(text: string, width: number, ellipsis = "") {
    if (this.visibleWidth(text) <= width) return text;
    const suffix = this.visibleWidth(ellipsis) <= width ? ellipsis : "";
    return Array.from(text).slice(0, Math.max(0, width - this.visibleWidth(suffix))).join("") + suffix;
  },
};

const theme = {
  fg(_color: string, text: string) {
    return text;
  },
};

function fixture(
  statuses = new Map<string, string>(),
  usageOverrides: Record<string, unknown> = {},
  extraEntries: unknown[] = [],
  renderTheme = theme,
  thinkingActive = false,
  thinkingFrame = 0,
) {
  const ctx = {
    cwd: "E:\\github\\own-pi",
    model: {
      id: "gpt-5.6-sol",
      provider: "openai-codex",
      reasoning: true,
      contextWindow: 272_000,
    },
    thinkingLevel: "high",
    sessionManager: {
      getEntries: () => [{
        type: "message",
        message: {
          role: "assistant",
          usage: {
            input: 1_200_000,
            output: 15_000,
            cacheRead: 2_500_000,
            cacheWrite: 0,
            cost: { total: 0 },
            ...usageOverrides,
          },
        },
      }, ...extraEntries],
      getSessionName: () => undefined,
    },
    getContextUsage: () => ({ tokens: 189_040, contextWindow: 272_000, percent: 69.5 }),
  };
  const footerData = {
    getGitBranch: () => "master",
    getExtensionStatuses: () => statuses,
    getAvailableProviderCount: () => 2,
    onBranchChange: (_callback: () => void) => () => {},
  };
  const tui = { requestRender() {} };

  return createCompactFooter(ctx as never, tui, renderTheme, footerData, widthUtils, {
    isActive: () => thinkingActive,
    getFrameIndex: () => thinkingFrame,
    onChange: () => () => {},
  });
}

test("combines workspace and usage on one line while preserving the status line", () => {
  const footer = fixture(new Map([
    ["mcp", "MCP: 3 servers enabled"],
    ["lean-codex-usage", "codex 81% 5h"],
  ]));

  const lines = footer.render(180);

  assert.equal(lines.length, 2);
  assert.match(lines[0], /^own-pi \(master\) \| /);
  assert.match(lines[0], /↑1\.2M ↓15k \[67\.6%\] 69\.5%\/272k \|/);
  assert.match(lines[0], /\(openai-codex\) gpt-5\.6-sol • high$/);
  assert.doesNotMatch(lines[0], /E:\\github|R2\.5M|CH|\$|\(sub\)|\(auto\)/);
  assert.equal(lines[1], "codex 81% 5h MCP: 3 servers enabled");
});

test("uses subtle neighboring theme colors to distinguish the statistics", () => {
  const tones = new Map<string, string>();
  const recordingTheme = {
    fg(color: string, text: string) {
      tones.set(text, color);
      return text;
    },
  };
  const footer = fixture(new Map(), {}, [], recordingTheme);

  footer.render(180);

  assert.equal(tones.get("↑1.2M"), "thinkingLow");
  assert.equal(tones.get("↓15k"), "thinkingLow");
  assert.equal(tones.get("[67.6%]"), "accent");
  assert.equal(tones.get("69.5%/272k"), "thinkingMedium");
});

test("uses two summary lines only when the complete summary cannot fit", () => {
  const footer = fixture();

  const wideLines = footer.render(180);
  const compactLines = footer.render(69);
  const narrowLines = footer.render(68);

  assert.equal(wideLines.length, 1);
  assert.equal(compactLines.length, 1);
  assert.doesNotMatch(compactLines[0], /\(openai-codex\)/);
  assert.match(compactLines[0], /gpt-5\.6-sol • high$/);
  assert.equal(narrowLines.length, 2);
  assert.equal(narrowLines[0], "own-pi (master)");
  assert.match(narrowLines[1], /^↑1\.2M ↓15k \[67\.6%\] 69\.5%\/272k \|/);
  assert.match(narrowLines[1], /gpt-5\.6-sol • high$/);
});

test("keeps cache writes but omits cache reads, cost, and auto-compaction text", () => {
  const footer = fixture(new Map(), { cacheWrite: 8_000 });

  const lines = footer.render(180);

  assert.match(lines[0], /W8\.0k/);
  assert.doesNotMatch(lines[0], /\bR\d|\$|\bsub\b|auto/);
});

test("includes usage reported by tool results", () => {
  const footer = fixture(new Map(), {
    input: 0,
    output: 0,
    cacheRead: 0,
  }, [{
    type: "message",
    message: {
      role: "toolResult",
      usage: { input: 8_000, output: 1_000, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
    },
  }]);

  const lines = footer.render(180);

  assert.match(lines[0], /↑8\.0k ↓1\.0k/);
});

test("shows active thinking between statistics and the model", () => {
  const footer = fixture(
    new Map([["mcp", "MCP: 3 servers enabled"]]),
    {},
    [],
    theme,
    true,
  );

  const lines = footer.render(180);

  assert.match(lines[0], /69\.5%\/272k \| ✻ Thinking…\s+\(openai-codex\) gpt-5\.6-sol • high$/);
  assert.equal(lines[1], "MCP: 3 servers enabled");
});

test("advances the thinking glyph every 125ms and loops after eight frames", () => {
  let tick: (() => void) | undefined;
  let cleared = false;
  const indicator = createThinkingIndicator({
    setInterval(callback, delayMs) {
      assert.equal(delayMs, 125);
      tick = callback;
      return 1 as never;
    },
    clearInterval() {
      cleared = true;
      tick = undefined;
    },
  });
  const frames: number[] = [];
  indicator.onChange(() => frames.push(indicator.getFrameIndex()));

  indicator.setActive(true);
  for (let index = 0; index < 8; index++) tick?.();

  assert.deepEqual(frames, [0, 1, 2, 3, 4, 5, 6, 7, 0]);
  indicator.setActive(false);
  assert.equal(cleared, true);
  assert.equal(indicator.isActive(), false);
  assert.equal(indicator.getFrameIndex(), 0);
});

test("cycles thinking glyphs and theme colors through a breathing loop", () => {
  const frames = [
    ["✻", "thinkingLow"],
    ["✢", "thinkingMedium"],
    ["✶", "thinkingHigh"],
    ["✷", "thinkingXhigh"],
    ["✸", "thinkingXhigh"],
    ["✷", "thinkingHigh"],
    ["✶", "thinkingMedium"],
    ["✢", "thinkingLow"],
  ] as const;

  for (const [frameIndex, [glyph, tone]] of frames.entries()) {
    const tones = new Map<string, string>();
    const recordingTheme = {
      fg(color: string, text: string) {
        tones.set(text, color);
        return text;
      },
    };
    const footer = fixture(new Map(), {}, [], recordingTheme, true, frameIndex);
    const line = footer.render(180)[0] ?? "";

    assert.match(line, new RegExp(`\\| ${glyph} Thinking…\\s+\\(openai-codex\\)`));
    assert.equal(tones.get(glyph), tone);
  }
});

test("keeps a compact thinking mark between statistics and the model when narrow", () => {
  const footer = fixture(new Map(), {}, [], theme, true);

  const lines = footer.render(60);
  const summaryLine = lines.at(-1) ?? "";

  assert.match(summaryLine, /\| ✻\s+gpt-5\.6-sol • high$/);
  assert.doesNotMatch(summaryLine, /Thinking/);
});

test("does not reserve space when thinking is idle", () => {
  const footer = fixture(new Map(), {}, [], theme, false);

  const lines = footer.render(180);

  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines.join("\n"), /Thinking/);
});
