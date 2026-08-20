import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Input,
  Key,
  matchesKey,
  type SelectItem,
  SelectList,
  type SelectListTheme,
  Text,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { Combo } from "./combos.ts";
import type { PickerResult, PickerTab, PickerTheme, Skill } from "./types.ts";

type PickerItems = Record<PickerTab, SelectItem[]>;
type PickerFilters = Record<PickerTab, string>;

const pickerTabs: PickerTab[] = ["skills", "models", "thinking", "combos"];

const tabLabels: Record<PickerTab, string> = {
  skills: "技能",
  models: "模型",
  thinking: "思考",
  combos: "组合",
};

const thinkingLevelDescriptions: Record<ModelThinkingLevel, string> = {
  off: "关闭思考",
  minimal: "极低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最大",
};

const emptyFilters = (): PickerFilters => ({
  skills: "",
  models: "",
  thinking: "",
  combos: "",
});

function modelKey(model: Model<Api>): string {
  return `${model.provider}/${model.id}`;
}

export class QuickPanel {
  private readonly container = new Container();
  private readonly tabs = new Text("", 1, 0);
  private readonly filterInput = new Input();
  private readonly listContainer = new Container();
  private readonly help = new Text("", 1, 0);
  private readonly items: PickerItems;
  private readonly skillsByName: Map<string, Skill>;
  private readonly modelsByKey: Map<string, Model<Api>>;
  private readonly combosByName: Map<string, Combo>;
  private readonly thinkingLevelsByName: Map<string, ModelThinkingLevel>;
  private readonly listTheme: SelectListTheme;
  private readonly theme: PickerTheme;
  private readonly keybindings: KeybindingsManager;
  private readonly tui: { requestRender(): void };
  private readonly onSelect: (result: PickerResult) => void;
  private readonly onCancel: () => void;
  private readonly border: (text: string) => string;
  private readonly filters = emptyFilters();
  private selectList: SelectList;
  private tab: PickerTab = "skills";
  private isFocused = false;

  constructor(
    skills: Skill[],
    models: Model<Api>[],
    currentModel: Model<Api> | undefined,
    private readonly currentThinkingLevel: ModelThinkingLevel,
    thinkingLevels: ModelThinkingLevel[],
    combos: Combo[],
    theme: PickerTheme,
    keybindings: KeybindingsManager,
    tui: { requestRender(): void },
    onSelect: (result: PickerResult) => void,
    onCancel: () => void,
  ) {
    this.theme = theme;
    this.keybindings = keybindings;
    this.tui = tui;
    this.onSelect = onSelect;
    this.onCancel = onCancel;
    this.skillsByName = new Map(skills.map((skill) => [skill.name, skill]));
    this.modelsByKey = new Map(models.map((model) => [modelKey(model), model]));
    this.combosByName = new Map(combos.map((combo) => [combo.name, combo]));
    this.thinkingLevelsByName = new Map(thinkingLevels.map((level) => [level, level]));
    this.items = {
      skills: skills.map((skill) => ({
        value: skill.name,
        label: skill.name,
        description: skill.description,
      })),
      models: models.map((model) => {
        const isCurrent = model.provider === currentModel?.provider && model.id === currentModel.id;
        const name = model.name && model.name !== model.id ? ` · ${model.name}` : "";
        return {
          value: modelKey(model),
          label: model.id,
          description: `${model.provider}${name}${isCurrent ? " · 当前" : ""}`,
        };
      }),
      thinking: thinkingLevels.map((level) => ({
        value: level,
        label: level,
        description: `${thinkingLevelDescriptions[level]}${level === currentThinkingLevel ? " · 当前" : ""}`,
      })),
      combos: combos.map((combo) => {
        const unavailable = !combo.model
          ? " · 模型不可用"
          : !combo.supportedThinkingLevels.includes(combo.thinkingLevel)
            ? " · 目标模型不支持该等级"
            : "";
        const isCurrent = combo.model !== undefined &&
          combo.model.provider === currentModel?.provider &&
          combo.model.id === currentModel?.id &&
          combo.thinkingLevel === currentThinkingLevel;
        return {
          value: combo.name,
          label: combo.name,
          description: `${combo.provider}/${combo.modelId} · 思考：${combo.thinkingLevel}${unavailable}${isCurrent ? " · 当前" : ""}`,
        };
      }),
    };
    this.border = (text) => this.theme.fg("accent", text);
    this.listTheme = {
      selectedPrefix: (text) => this.theme.fg("accent", text),
      selectedText: (text) => this.theme.fg("accent", text),
      description: (text) => this.theme.fg("muted", text),
      scrollInfo: (text) => this.theme.fg("dim", text),
      noMatch: (text) => this.theme.fg("warning", text),
    };
    this.selectList = this.createSelectList(this.items.skills);
    this.filterInput.onSubmit = () => this.selectCurrent();

    this.container.addChild(this.tabs);
    this.container.addChild(this.filterInput);
    this.listContainer.addChild(this.selectList);
    this.container.addChild(this.listContainer);
    this.container.addChild(this.help);
    this.updateTabDisplay();
  }

  get focused(): boolean {
    return this.isFocused;
  }

  set focused(value: boolean) {
    this.isFocused = value;
    this.filterInput.focused = value;
  }

  render(width: number): string[] {
    if (width < 4) return this.container.render(width);

    const innerWidth = width - 2;
    const horizontal = "─".repeat(innerWidth);
    const content = this.container.render(innerWidth).map((line) => {
      const clipped = truncateToWidth(line, innerWidth, "");
      const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
      return this.border("│") + clipped + padding + this.border("│");
    });

    return [this.border(`╭${horizontal}╮`), ...content, this.border(`╰${horizontal}╯`)];
  }

  invalidate(): void {
    this.updateTabDisplay();
    this.container.invalidate();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.left)) {
      this.moveTab(-1);
      return;
    }

    if (matchesKey(data, Key.right)) {
      this.moveTab(1);
      return;
    }

    if (this.matches(data, "tui.select.cancel")) {
      this.onCancel();
      return;
    }

    if (this.matches(data, "tui.select.up") || this.matches(data, "tui.select.down")) {
      this.selectList.handleInput(data);
      this.tui.requestRender();
      return;
    }

    if (this.matches(data, "tui.select.confirm")) {
      this.selectCurrent();
      return;
    }

    this.filterInput.handleInput(data);
    this.filters[this.tab] = this.filterInput.getValue();
    this.filterItems();
    this.tui.requestRender();
  }

  private matches(
    data: string,
    keybinding: "tui.select.cancel" | "tui.select.up" | "tui.select.down" | "tui.select.confirm",
  ): boolean {
    return this.keybindings.matches(data, keybinding);
  }

  private moveTab(direction: -1 | 1): void {
    const currentIndex = pickerTabs.indexOf(this.tab);
    const nextIndex = (currentIndex + direction + pickerTabs.length) % pickerTabs.length;
    this.setTab(pickerTabs[nextIndex]!);
  }

  private setTab(tab: PickerTab): void {
    if (this.tab === tab) return;

    this.tab = tab;
    this.filterInput.setValue(this.filters[tab]);
    this.updateTabDisplay();
    this.filterItems();
    this.tui.requestRender();
  }

  private updateTabDisplay(): void {
    const tabs = pickerTabs.map((tab) => {
      const label = tabLabels[tab];
      return this.tab === tab
        ? this.theme.fg("accent", this.theme.bold(label))
        : this.theme.fg("muted", label);
    });
    this.tabs.setText(tabs.join(this.theme.fg("muted", "  │  ")));

    const help = this.tab === "combos" && this.items.combos.length === 0
      ? "暂无组合 · 配置 quick-panel.json 后重新打开"
      : "←→ 切换 Tab · 输入筛选 · ↑↓ 选择 · Enter 确认 · Esc 取消";
    this.help.setText(this.theme.fg("dim", help));
  }

  private filterItems(): void {
    const query = this.filters[this.tab].trim().toLocaleLowerCase();
    const source = this.items[this.tab];
    const items = query
      ? source.filter((item) =>
          item.value.toLocaleLowerCase().includes(query) ||
          item.label.toLocaleLowerCase().includes(query) ||
          item.description?.toLocaleLowerCase().includes(query),
        )
      : source;

    this.listContainer.removeChild(this.selectList);
    this.selectList = this.createSelectList(items);
    this.listContainer.addChild(this.selectList);
  }

  private createSelectList(items: SelectItem[]): SelectList {
    const list = new SelectList(items, Math.max(1, Math.min(items.length, 12)), this.listTheme);
    if (this.tab === "thinking") {
      const currentIndex = items.findIndex((item) => item.value === this.currentThinkingLevel);
      if (currentIndex !== -1) list.setSelectedIndex(currentIndex);
    }

    list.onSelect = (item) => this.selectItem(item);
    list.onCancel = this.onCancel;
    return list;
  }

  private selectItem(item: SelectItem): void {
    if (this.tab === "skills") {
      const skill = this.skillsByName.get(item.value);
      if (skill) this.onSelect({ type: "skill", skill });
      return;
    }

    if (this.tab === "models") {
      const model = this.modelsByKey.get(item.value);
      if (model) this.onSelect({ type: "model", model });
      return;
    }

    if (this.tab === "combos") {
      const combo = this.combosByName.get(item.value);
      if (combo) this.onSelect({ type: "combo", combo });
      return;
    }

    const level = this.thinkingLevelsByName.get(item.value);
    if (level) this.onSelect({ type: "thinking", level });
  }

  private selectCurrent(): void {
    const selected = this.selectList.getSelectedItem();
    if (selected) this.selectList.onSelect?.(selected);
  }
}
