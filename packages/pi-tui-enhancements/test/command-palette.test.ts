import assert from "node:assert/strict";
import test from "node:test";

import {
  CommandPalette,
  commandInsertion,
  filterCommandItems,
  loadCommandPaletteItems,
  shouldExecuteCommand,
  showCommandPalette,
  type CommandPalettePi,
} from "../src/panel/command-palette.ts";

test("loads built-in autocomplete commands and merges extension metadata without duplicates", async () => {
  let request: { lines: string[]; cursorLine: number; cursorCol: number; force?: boolean } | undefined;
  const provider = {
    async getSuggestions(
      lines: string[],
      cursorLine: number,
      cursorCol: number,
      options: { signal: AbortSignal; force?: boolean },
    ) {
      request = { lines, cursorLine, cursorCol, force: options.force };
      return {
        prefix: "/",
        items: [
          { value: "settings", label: "settings", description: "内置设置" },
          { value: "custom", label: "custom", description: "来自默认补全" },
        ],
      };
    },
    applyCompletion() {
      throw new Error("not used");
    },
  };
  const pi = {
    getCommands: () => [{ name: "custom", description: "来自扩展元数据" }, { name: "review" }],
  } as unknown as CommandPalettePi;

  const items = await loadCommandPaletteItems(provider, pi);

  assert.deepEqual(request, { lines: ["/"], cursorLine: 0, cursorCol: 1, force: undefined });
  assert.deepEqual(items, [
    { value: "settings", label: "settings", description: "内置设置" },
    { value: "custom", label: "custom", description: "来自默认补全" },
    { value: "review", label: "review" },
  ]);
});

test("ranks command-name matches above description-only matches", () => {
  const commands = [
    { value: "import", label: "import", description: "Import and resume a session" },
    { value: "resume", label: "resume", description: "Resume a session" },
  ];

  assert.deepEqual(filterCommandItems(commands, "resume").map((item) => item.value), ["resume", "import"]);
});

test("executes commands that have a valid bare form", () => {
  assert.equal(shouldExecuteCommand("resume"), true);
  assert.equal(shouldExecuteCommand("/reload"), true);
  assert.equal(shouldExecuteCommand("model"), true);
  assert.equal(shouldExecuteCommand("import"), false);
  assert.equal(shouldExecuteCommand("name"), false);
});

test("uses Tab to complete the first matching command in the popup input", () => {
  const palette = new CommandPalette(
    [
      { value: "resume", label: "resume", description: "恢复会话" },
      { value: "review", label: "review", description: "审查" },
    ],
    { bold: (text) => text, fg: (_color, text) => text },
    { matches: () => false } as never,
    { requestRender() {} },
    () => {},
    () => {},
  );

  palette.handleInput("r");
  palette.handleInput("\t");

  assert.ok(palette.render(80).some((line) => line.includes("> resume")));
});

test("executes a bare command through the editor instead of pasting it", async () => {
  const pasted: string[] = [];
  const executed: string[] = [];
  let renderRequests = 0;
  const pi = {
    getCommands: () => [{ name: "resume" }],
  } as unknown as CommandPalettePi;
  const ctx = {
    mode: "tui",
    ui: {
      custom: async () => "resume",
      pasteToEditor: (text: string) => pasted.push(text),
    },
  } as never;

  await showCommandPalette(pi, ctx, undefined, () => {
    renderRequests += 1;
  }, (command) => {
    executed.push(command);
    return true;
  });

  assert.deepEqual(executed, ["resume"]);
  assert.deepEqual(pasted, []);
  assert.equal(renderRequests, 1);
});

test("requests a redraw after inserting a command that still needs arguments", async () => {
  const pasted: string[] = [];
  let renderRequests = 0;
  const pi = {
    getCommands: () => [{ name: "name" }],
  } as unknown as CommandPalettePi;
  const ctx = {
    mode: "tui",
    ui: {
      custom: async () => "name",
      pasteToEditor: (text: string) => pasted.push(text),
    },
  } as never;

  await showCommandPalette(pi, ctx, undefined, () => {
    renderRequests += 1;
  });

  assert.deepEqual(pasted, ["/name "]);
  assert.equal(renderRequests, 1);
});

test("formats a selected command for insertion into the editor", () => {
  assert.equal(commandInsertion("settings"), "/settings ");
  assert.equal(commandInsertion("/review"), "/review ");
  assert.equal(commandInsertion("  "), "");
});
