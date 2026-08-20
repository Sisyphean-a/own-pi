import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { showQuickPanel } from "../src/quick-panel.ts";
import { QuickPanelEditor } from "../src/quick-panel-editor.ts";
import { expandInlineSkillDirectives } from "../src/skills.ts";

export default function quickPanel(pi: ExtensionAPI): void {
  pi.on("input", async (event) => {
    const expanded = await expandInlineSkillDirectives(event.text, pi);
    return expanded === event.text
      ? { action: "continue" }
      : { action: "transform", text: expanded };
  });

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    ctx.ui.setEditorComponent((tui, theme, keybindings) => new QuickPanelEditor(
      tui,
      theme,
      keybindings,
      () => {
        void showQuickPanel(pi, ctx).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`无法打开快捷面板：${message}`, "error");
        });
      },
    ));
  });

  pi.registerCommand("quick-panel", {
    description: "打开快捷面板；组合读取 quick-panel.json，技能会插入当前光标处",
    handler: async (_args, ctx) => showQuickPanel(pi, ctx),
  });
}
