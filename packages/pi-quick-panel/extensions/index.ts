import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function loadOptional<T>(name: string, load: () => Promise<T>): Promise<T | undefined> {
  try {
    return await load();
  } catch (error) {
    // Rule: a missing peer package or incompatible TUI only disables this
    // optional feature; it must not reject Pi's extension loading.
    console.error(`[pi-quick-panel] ${name} 不可用，已隐藏相关功能：${errorMessage(error)}`);
    return undefined;
  }
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
  try {
    if (typeof ctx.ui?.notify === "function" && ctx.hasUI) {
      ctx.ui.notify(message, level);
    }
  } catch {
    // UI is optional and may be stale during session replacement.
  }
}

export default async function quickPanel(pi: ExtensionAPI): Promise<void> {
  const skills = await loadOptional("技能展开", () => import("../src/skills.ts"));
  if (skills && typeof pi.on === "function") {
    pi.on("input", async (event) => {
      try {
        const expanded = await skills.expandInlineSkillDirectives(event.text, pi);
        return expanded === event.text
          ? { action: "continue" as const }
          : { action: "transform" as const, text: expanded };
      } catch (error) {
        console.error(`[pi-quick-panel] 技能展开失败，保留原输入：${errorMessage(error)}`);
        return { action: "continue" as const };
      }
    });
  }

  const panel = await loadOptional("快捷面板", async () => {
    const [quickPanelModule, editorModule] = await Promise.all([
      import("../src/quick-panel.ts"),
      import("../src/quick-panel-editor.ts"),
    ]);
    return {
      showQuickPanel: quickPanelModule.showQuickPanel,
      QuickPanelEditor: editorModule.QuickPanelEditor,
    };
  });
  if (!panel) return;

  if (typeof pi.on === "function") {
    pi.on("session_start", (_event, ctx) => {
      try {
        if (ctx.mode !== "tui" || typeof ctx.ui?.setEditorComponent !== "function") return;
        ctx.ui.setEditorComponent((tui, theme, keybindings) => new panel.QuickPanelEditor(
          tui,
          theme,
          keybindings,
          () => {
            void panel.showQuickPanel(pi, ctx).catch((error: unknown) => {
              notify(ctx, `无法打开快捷面板：${errorMessage(error)}`, "error");
            });
          },
        ));
      } catch (error) {
        console.error(`[pi-quick-panel] 编辑器接入失败，已隐藏快捷面板：${errorMessage(error)}`);
      }
    });
  }

  if (typeof pi.registerCommand !== "function") return;
  pi.registerCommand("quick-panel", {
    description: "打开快捷面板；组合读取 quick-panel.json，技能会插入当前光标处",
    handler: async (_args, ctx) => {
      try {
        await panel.showQuickPanel(pi, ctx);
      } catch (error) {
        notify(ctx, `无法打开快捷面板：${errorMessage(error)}`, "error");
      }
    },
  });
}
