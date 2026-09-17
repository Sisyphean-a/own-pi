import {
  getAgentDir,
  getSettingsListTheme,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, Text, type SettingItem } from "@earendil-works/pi-tui";
import {
  discoverSkillPacks,
  filterSkillPackIds,
  getEnabledSkillPackPaths,
  getSkillPackRoots,
  type SkillPack,
} from "./skill-pack-discovery.ts";

const SKILL_PACK_STATE = "skill-pack-selection";
const ENABLED = "启用";
const DISABLED = "禁用";

type SkillPackState = {
  enabledPackIds: string[];
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
  try {
    if (ctx.hasUI && typeof ctx.ui?.notify === "function") {
      ctx.ui.notify(message, level);
    }
  } catch {
    // UI may be invalidated while Pi reloads the runtime.
  }
}

function isSkillPackState(value: unknown): value is SkillPackState {
  if (!value || typeof value !== "object") return false;
  const enabledPackIds = (value as { enabledPackIds?: unknown }).enabledPackIds;
  return Array.isArray(enabledPackIds) && enabledPackIds.every((id) => typeof id === "string");
}

function readEnabledPackIds(ctx: ExtensionContext): string[] {
  let enabledPackIds: string[] = [];
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== SKILL_PACK_STATE) continue;
    if (isSkillPackState(entry.data)) enabledPackIds = entry.data.enabledPackIds;
  }
  return enabledPackIds;
}

function persistEnabledPackIds(pi: ExtensionAPI, enabledPackIds: Iterable<string>): void {
  pi.appendEntry<SkillPackState>(SKILL_PACK_STATE, {
    enabledPackIds: [...new Set(enabledPackIds)].sort(),
  });
}

function settingItems(packs: SkillPack[], enabledPackIds: Set<string>): SettingItem[] {
  return packs.map((pack) => ({
    id: pack.id,
    label: `${pack.scope === "project" ? "项目" : "全局"} · ${pack.name}`,
    description: `${pack.skillCount} 个技能 · ${pack.directory}`,
    currentValue: enabledPackIds.has(pack.id) ? ENABLED : DISABLED,
    values: [ENABLED, DISABLED],
  }));
}

async function findSkillPacks(cwd: string, includeProjectPacks: boolean): Promise<SkillPack[]> {
  const packs = await discoverSkillPacks(getSkillPackRoots(cwd, getAgentDir()));
  return includeProjectPacks ? packs : packs.filter((pack) => pack.scope === "global");
}

export default async function skillPacks(pi: ExtensionAPI): Promise<void> {
  let availablePacks: SkillPack[] = [];
  let enabledPackIds = new Set<string>();

  try {
    pi.on("session_start", async (_event, ctx) => {
      try {
        availablePacks = await findSkillPacks(ctx.cwd, ctx.isProjectTrusted());
        enabledPackIds = new Set(filterSkillPackIds(readEnabledPackIds(ctx), availablePacks));
      } catch (error) {
        availablePacks = [];
        enabledPackIds = new Set();
        console.error(`[pi-tui-enhancements/panel] 技能包发现失败：${errorMessage(error)}`);
      }
    });

    // This is deliberately session-scoped: the selected directories are added
    // through Pi's temporary resource seam and never written to settings.json.
    pi.on("resources_discover", async (event, ctx) => {
      try {
        availablePacks = await findSkillPacks(event.cwd, ctx.isProjectTrusted());
        enabledPackIds = new Set(filterSkillPackIds(enabledPackIds, availablePacks));
        return {
          skillPaths: getEnabledSkillPackPaths(availablePacks, enabledPackIds),
        };
      } catch (error) {
        console.error(`[pi-tui-enhancements/panel] 技能包资源加载失败：${errorMessage(error)}`);
        return {};
      }
    });
  } catch (error) {
    console.error(`[pi-tui-enhancements/panel] 技能包资源接口不可用，已隐藏技能包功能：${errorMessage(error)}`);
    return;
  }

  if (typeof pi.registerCommand !== "function") return;

  pi.registerCommand("skill-packs", {
    description: "按包临时启用或禁用可选技能",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        notify(ctx, "/skill-packs 需要交互式终端", "error");
        return;
      }

      try {
        availablePacks = await findSkillPacks(ctx.cwd, ctx.isProjectTrusted());
      } catch (error) {
        notify(ctx, `无法发现技能包：${errorMessage(error)}`, "error");
        return;
      }

      if (availablePacks.length === 0) {
        notify(ctx, "没有发现技能包；请在 skills 旁创建 skill-packs/<包名>/<技能名>/SKILL.md", "warning");
        return;
      }

      const knownIds = new Set(availablePacks.map((pack) => pack.id));
      enabledPackIds = new Set([...enabledPackIds].filter((id) => knownIds.has(id)));
      let changed = false;

      await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
        const container = new Container();
        container.addChild(new Text(theme.fg("accent", theme.bold("可选技能包")), 0, 0));
        container.addChild(new Text(theme.fg("dim", "空格切换；关闭后应用到当前会话，不修改 settings.json"), 0, 0));

        let settingsList: SettingsList;
        settingsList = new SettingsList(
          settingItems(availablePacks, enabledPackIds),
          Math.min(availablePacks.length + 1, 15),
          getSettingsListTheme(),
          (id, newValue) => {
            const next = new Set(enabledPackIds);
            if (newValue === ENABLED) next.add(id);
            else next.delete(id);

            if (next.size === enabledPackIds.size && [...next].every((value) => enabledPackIds.has(value))) {
              return;
            }

            enabledPackIds = next;
            persistEnabledPackIds(pi, enabledPackIds);
            changed = true;
          },
          () => done(),
          { enableSearch: availablePacks.length > 10 },
        );

        container.addChild(settingsList);
        return {
          render(width: number) {
            return container.render(width);
          },
          invalidate() {
            container.invalidate();
          },
          handleInput(data: string) {
            settingsList.handleInput(data);
            tui.requestRender();
          },
        };
      });

      if (!changed) return;

      notify(ctx, "正在重新加载当前会话的技能包…", "info");
      try {
        await ctx.reload();
      } catch (error) {
        // ctx may already be invalid after a partial reload; keep the real
        // failure visible without calling stale UI methods.
        console.error(`[pi-tui-enhancements/panel] 技能包重新加载失败：${errorMessage(error)}`);
      }
    },
  });
}
