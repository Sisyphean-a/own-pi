import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fetchCodexUsage, formatCodexUsage } from "./codex-usage.ts";
import { loadCombos } from "./combos.ts";
import { QuickPanel } from "./quick-panel-ui.ts";
import { createSkillDirective, getSkills } from "./skills.ts";
import type { Combo } from "./combos.ts";
import type { PickerResult, Skill } from "./types.ts";

function sameModel(left: Model<Api> | undefined, right: Model<Api> | undefined): boolean {
  return left?.provider === right?.provider && left?.id === right?.id;
}

function getModels(ctx: ExtensionContext): Model<Api>[] {
  const current = ctx.model;
  return [...ctx.modelRegistry.getAvailable()].sort((left, right) => {
    const leftIsCurrent = left.provider === current?.provider && left.id === current.id;
    const rightIsCurrent = right.provider === current?.provider && right.id === current.id;
    if (leftIsCurrent !== rightIsCurrent) return leftIsCurrent ? -1 : 1;

    return left.provider.localeCompare(right.provider) || left.id.localeCompare(right.id);
  });
}

function getThinkingLevels(ctx: ExtensionContext): ModelThinkingLevel[] {
  return ctx.model ? getSupportedThinkingLevels(ctx.model) : ["off"];
}

function insertSkill(ctx: ExtensionContext, skill: Skill): void {
  ctx.ui.pasteToEditor(createSkillDirective(skill));
  ctx.ui.notify(`已添加技能指令：${skill.name}`, "info");
}

async function applyCombo(pi: ExtensionAPI, ctx: ExtensionContext, combo: Combo): Promise<void> {
  if (!combo.model) {
    ctx.ui.notify(`组合“${combo.name}”的模型不可用：${combo.provider}/${combo.modelId}`, "error");
    return;
  }
  if (!combo.supportedThinkingLevels.includes(combo.thinkingLevel)) {
    ctx.ui.notify(`组合“${combo.name}”的思考等级不受该模型支持：${combo.thinkingLevel}`, "error");
    return;
  }
  let modelChanged = false;
  try {
    modelChanged = await pi.setModel(combo.model);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`无法切换组合“${combo.name}”：${message}`, "error");
    return;
  }
  if (!modelChanged) {
    ctx.ui.notify(`无法切换组合“${combo.name}”：${combo.provider}/${combo.modelId} 未配置认证`, "error");
    return;
  }

  try {
    pi.setThinkingLevel(combo.thinkingLevel);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`组合“${combo.name}”的模型已切换，但思考等级设置失败：${message}`, "error");
    return;
  }

  const effectiveLevel = pi.getThinkingLevel();
  const type = effectiveLevel === combo.thinkingLevel ? "info" : "warning";
  const suffix = effectiveLevel === combo.thinkingLevel ? "" : `，实际等级为：${effectiveLevel}`;
  ctx.ui.notify(`已切换组合：${combo.name}（${combo.modelId} · ${combo.thinkingLevel}${suffix}）`, type);
}

export async function showQuickPanel(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("快捷面板仅支持交互式终端", "error");
    return;
  }

  const skills = getSkills(pi);
  const models = getModels(ctx);
  let combos: Combo[];
  try {
    combos = loadCombos(ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`无法读取组合配置：${message}`, "error");
    return;
  }
  const thinkingLevels = getThinkingLevels(ctx);
  if (skills.length === 0 && models.length === 0 && combos.length === 0) {
    ctx.ui.notify("当前没有可用技能或模型", "warning");
    return;
  }

  // Codex usage is optional: let the panel open immediately and fill the footer
  // when the official-account request completes.
  const usageModel = ctx.model;
  const usageAbort = new AbortController();
  const usagePromise = fetchCodexUsage(ctx, usageAbort.signal).catch(() => undefined);
  let closed = false;
  let completed = false;
  let result: PickerResult | undefined;
  try {
    result = await ctx.ui.custom<PickerResult | undefined>(
      (tui, theme, keybindings, done) => {
        let panel: QuickPanel;
        const finish = (selection: PickerResult | undefined = undefined): void => {
          if (completed) return;
          completed = true;
          closed = true;
          usageAbort.abort();
          done(selection);
        };

        panel = new QuickPanel(
          skills,
          models,
          ctx.model,
          ctx.thinkingLevel,
          thinkingLevels,
          combos,
          theme,
          keybindings,
          tui,
          finish,
          finish,
          finish,
        );
        void usagePromise.then((usage) => {
          if (closed || usage === undefined || !sameModel(ctx.model, usageModel)) return;
          panel.setCodexUsage(formatCodexUsage(usage));
        }).catch(() => {
          // The usage indicator is optional and must not reject the panel.
        });
        return panel;
      },
      {
        overlay: true,
        overlayOptions: { width: "80%", minWidth: 56, maxHeight: "70%", margin: 1 },
      },
    );
  } finally {
    closed = true;
    usageAbort.abort();
  }

  if (!result) return;

  if (result.type === "skill") {
    insertSkill(ctx, result.skill);
    return;
  }

  if (result.type === "model") {
    if (await pi.setModel(result.model)) {
      ctx.ui.notify(`已切换模型：${result.model.id}`, "info");
    } else {
      ctx.ui.notify(`无法切换模型：${result.model.provider}/${result.model.id} 未配置认证`, "error");
    }
    return;
  }

  if (result.type === "combo") {
    await applyCombo(pi, ctx, result.combo);
    return;
  }

  pi.setThinkingLevel(result.level);
  ctx.ui.notify(`已切换思考等级：${pi.getThinkingLevel()}`, "info");
}
