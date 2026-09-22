import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { logFailure } from "../extension-log.ts";
import { createFeatureLoader, errorMessage } from "../optional-feature.ts";

const loader = createFeatureLoader((name, error) => {
  logFailure(name, `不可用，已隐藏相关功能：${errorMessage(error)}`);
});

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
  const skillPacks = await loader.import("技能包", () => import("./skill-packs.ts"));
  if (skillPacks?.default) {
    await skillPacks.default(pi);
  }

  const skills = await loader.import("技能展开", () => import("./skills.ts"));
  if (skills && typeof pi.on === "function") {
    pi.on("input", async (event) => {
      try {
        const expanded = await skills.expandInlineSkillDirectives(event.text, pi);
        return expanded === event.text
          ? { action: "continue" as const }
          : { action: "transform" as const, text: expanded };
      } catch (error) {
        logFailure("技能展开", `失败，保留原输入：${errorMessage(error)}`);
        return { action: "continue" as const };
      }
    });
  }

  const panel = await loader.import("快捷面板", async () => {
    const [quickPanelModule, editorModule, commandPaletteModule] = await Promise.all([
      import("./quick-panel.ts"),
      import("./quick-panel-editor.ts"),
      import("./command-palette.ts"),
    ]);
    return {
      showQuickPanel: quickPanelModule.showQuickPanel,
      QuickPanelEditor: editorModule.QuickPanelEditor,
      showCommandPalette: commandPaletteModule.showCommandPalette,
      loadCommandPaletteItems: commandPaletteModule.loadCommandPaletteItems,
    };
  });
  if (!panel) return;

  const translation = await loader.import("描述翻译", () => import("./description-translations.ts"));
  const descriptions = translation ? new translation.DescriptionTranslations() : undefined;
  await descriptions?.load();

  let commandProvider: AutocompleteProvider | undefined;
  let translationTimer: ReturnType<typeof setTimeout> | undefined;
  let translationAbort: AbortController | undefined;

  const stopDescriptionTranslation = (): void => {
    if (translationTimer !== undefined) clearTimeout(translationTimer);
    translationTimer = undefined;
    translationAbort?.abort();
    translationAbort = undefined;
  };

  if (typeof pi.on === "function") {
    pi.on("session_start", (_event, ctx) => {
      stopDescriptionTranslation();
      try {
        if (ctx.mode !== "tui" || typeof ctx.ui?.setEditorComponent !== "function") return;

        commandProvider = undefined;
        if (typeof ctx.ui.addAutocompleteProvider === "function") {
          ctx.ui.addAutocompleteProvider((current) => {
            commandProvider = current;
            return current;
          });
        }

        if (translation && descriptions) {
          const controller = new AbortController();
          translationAbort = controller;
          translationTimer = setTimeout(() => {
            translationTimer = undefined;
            void panel.loadCommandPaletteItems(commandProvider, pi)
              .then((items) => descriptions.translateMissing(
                items.flatMap((item) => {
                  if (!item.description) return [];
                  const isSkill = item.value.startsWith("skill:");
                  return [{
                    kind: isSkill ? "skill" as const : "command" as const,
                    name: isSkill ? item.value.slice("skill:".length) : item.value,
                    description: item.description,
                  }];
                }),
                translation.createModelTranslationRequester(ctx),
                controller.signal,
              ))
              .catch((error: unknown) => {
                if (!controller.signal.aborted) {
                  logFailure("描述翻译", `本次未完成：${errorMessage(error)}`);
                }
              });
          }, translation.DESCRIPTION_TRANSLATION_DELAY_MS);
        }

        ctx.ui.setEditorComponent((tui, theme, keybindings) => new panel.QuickPanelEditor(
          tui,
          theme,
          keybindings,
          () => {
            void panel.showQuickPanel(pi, ctx, descriptions?.resolve).catch((error: unknown) => {
              notify(ctx, `无法打开快捷面板：${errorMessage(error)}`, "error");
            });
          },
          (editor) => {
            void panel.showCommandPalette(
              pi,
              ctx,
              commandProvider,
              () => tui.requestRender(),
              (command) => {
                if (editor.getText().trim().length > 0) return false;
                editor.submitCommand(command);
                return true;
              },
              descriptions?.resolve,
            ).catch((error: unknown) => {
              notify(ctx, `无法打开命令面板：${errorMessage(error)}`, "error");
            });
          },
        ));
      } catch (error) {
        logFailure("编辑器接入", `失败，已隐藏快捷面板：${errorMessage(error)}`);
      }
    });
    pi.on("session_shutdown", () => {
      stopDescriptionTranslation();
    });
  }

  if (typeof pi.registerCommand !== "function") return;
  pi.registerCommand("quick-panel", {
    description: "打开快捷面板；组合读取 quick-panel.json，技能会插入当前光标处",
    handler: async (_args, ctx) => {
      try {
        await panel.showQuickPanel(pi, ctx, descriptions?.resolve);
      } catch (error) {
        notify(ctx, `无法打开快捷面板：${errorMessage(error)}`, "error");
      }
    },
  });
}
