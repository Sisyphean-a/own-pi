import type { ExtensionAPI, ExtensionContext, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
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

export type CommandPalettePi = Pick<ExtensionAPI, "getCommands">;

// 这些命令不需要用户先在编辑器里补参数；交给 Pi 原生提交路径即可直接执行，
// 其中会打开选择器的命令仍由 Pi 自己负责创建原生 UI。
const directCommandNames = new Set([
  "settings",
  "model",
  "tree",
  "thinking",
  "scoped-models",
  "export",
  "share",
  "copy",
  "session",
  "changelog",
  "hotkeys",
  "fork",
  "clone",
  "trust",
  "login",
  "logout",
  "new",
  "compact",
  "resume",
  "reload",
  "quit",
]);

function commandName(value: string): string {
  return value.trim().replace(/^\/+/, "");
}

export function shouldExecuteCommand(value: string): boolean {
  return directCommandNames.has(commandName(value));
}

export function commandInsertion(value: string): string {
  const name = commandName(value);
  return name.length > 0 ? `/${name} ` : "";
}

function normalizeCommandItem(item: {
  value?: unknown;
  label?: unknown;
  description?: unknown;
}): SelectItem | undefined {
  if (typeof item.value !== "string") return undefined;

  const value = item.value.trim().replace(/^\/+/, "");
  if (value.length === 0) return undefined;

  const description = typeof item.description === "string" ? item.description.trim() : "";
  return {
    value,
    label: value,
    ...(description ? { description } : {}),
  };
}

function commandMatchScore(item: SelectItem, query: string): number | undefined {
  const value = item.value.toLocaleLowerCase();
  const label = item.label.toLocaleLowerCase();
  const description = item.description?.toLocaleLowerCase() ?? "";

  if (value === query || label === query) return 0;
  if (value.startsWith(query) || label.startsWith(query)) return 1;
  if (value.includes(query) || label.includes(query)) return 2;
  if (description.startsWith(query)) return 3;
  if (description.includes(query)) return 4;
  return undefined;
}

export function filterCommandItems(commands: SelectItem[], rawQuery: string): SelectItem[] {
  const query = rawQuery.trim().toLocaleLowerCase();
  if (!query) return commands;

  return commands
    .map((item, index) => ({ item, index, score: commandMatchScore(item, query) }))
    .filter((entry): entry is { item: SelectItem; index: number; score: number } => entry.score !== undefined)
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .map((entry) => entry.item);
}

function mergeCommandItems(
  primary: Array<{ value?: unknown; label?: unknown; description?: unknown }>,
  fallback: Array<{ name: string; description?: string }>,
): SelectItem[] {
  const result: SelectItem[] = [];
  const seen = new Set<string>();

  for (const item of primary) {
    const normalized = normalizeCommandItem(item);
    if (!normalized || seen.has(normalized.value)) continue;
    seen.add(normalized.value);
    result.push(normalized);
  }

  for (const command of fallback) {
    const normalized = normalizeCommandItem({
      value: command.name,
      description: command.description,
    });
    if (!normalized || seen.has(normalized.value)) continue;
    seen.add(normalized.value);
    result.push(normalized);
  }

  return result;
}

async function getAutocompleteCommands(provider: AutocompleteProvider | undefined): Promise<SelectItem[]> {
  if (!provider) return [];

  const controller = new AbortController();
  try {
    const suggestions = await provider.getSuggestions(["/"], 0, 1, {
      signal: controller.signal,
    });
    return suggestions?.items ?? [];
  } catch {
    return [];
  } finally {
    controller.abort();
  }
}

export async function loadCommandPaletteItems(
  provider: AutocompleteProvider | undefined,
  pi: CommandPalettePi,
): Promise<SelectItem[]> {
  const providerItems = await getAutocompleteCommands(provider);
  let registeredCommands: Array<{ name: string; description?: string }> = [];
  try {
    registeredCommands = pi.getCommands().map((command) => ({
      name: command.name,
      description: command.description,
    }));
  } catch {
    // The autocomplete provider remains the source of truth when the optional
    // command metadata API is unavailable during startup or reload.
  }

  return mergeCommandItems(providerItems, registeredCommands);
}

export type CommandPaletteTheme = {
  bold(text: string): string;
  fg(color: string, text: string): string;
};

export class CommandPalette {
  private readonly container = new Container();
  private readonly title: Text;
  private readonly filterInput = new Input({ prompt: "> " });
  private readonly listContainer = new Container();
  private readonly help: Text;
  private readonly listTheme: SelectListTheme;
  private readonly theme: CommandPaletteTheme;
  private readonly keybindings: KeybindingsManager;
  private readonly tui: { requestRender(): void };
  private readonly commands: SelectItem[];
  private readonly onSelect: (command: string) => void;
  private readonly onCancel: () => void;
  private selectList: SelectList;
  private isFocused = false;

  constructor(
    commands: SelectItem[],
    theme: CommandPaletteTheme,
    keybindings: KeybindingsManager,
    tui: { requestRender(): void },
    onSelect: (command: string) => void,
    onCancel: () => void,
  ) {
    this.theme = theme;
    this.keybindings = keybindings;
    this.tui = tui;
    this.commands = commands;
    this.onSelect = onSelect;
    this.onCancel = onCancel;
    this.title = new Text(this.theme.fg("accent", this.theme.bold("命令面板")), 1, 0);
    this.help = new Text("", 1, 0);
    this.listTheme = {
      selectedPrefix: (text) => this.theme.fg("accent", text),
      selectedText: (text) => this.theme.fg("accent", text),
      description: (text) => this.theme.fg("muted", text),
      scrollInfo: (text) => this.theme.fg("dim", text),
      noMatch: (text) => this.theme.fg("warning", text),
    };
    this.selectList = this.createSelectList(commands);
    this.filterInput.onSubmit = () => this.selectCurrent();

    this.container.addChild(this.title);
    this.container.addChild(this.filterInput);
    this.listContainer.addChild(this.selectList);
    this.container.addChild(this.listContainer);
    this.container.addChild(this.help);
  }

  get focused(): boolean {
    return this.isFocused;
  }

  set focused(value: boolean) {
    this.isFocused = value;
    this.filterInput.focused = value;
  }

  render(width: number): string[] {
    const innerWidth = Math.max(1, width - 2);
    this.help.setText(this.theme.fg("dim", this.helpText()));
    if (width < 4) return this.container.render(width);

    const horizontal = "─".repeat(innerWidth);
    const content = this.container.render(innerWidth).map((line) => {
      const clipped = truncateToWidth(line, innerWidth, "");
      const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
      return this.theme.fg("accent", "│") + clipped + padding + this.theme.fg("accent", "│");
    });

    return [
      this.theme.fg("accent", `╭${horizontal}╮`),
      ...content,
      this.theme.fg("accent", `╰${horizontal}╯`),
    ];
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.onCancel();
      return;
    }

    if (this.keybindings.matches(data, "tui.select.up") || this.keybindings.matches(data, "tui.select.down")) {
      this.selectList.handleInput(data);
      this.tui.requestRender();
      return;
    }

    if (this.keybindings.matches(data, "tui.select.confirm")) {
      this.selectCurrent();
      return;
    }

    if (matchesKey(data, Key.tab)) {
      this.completeFilter();
      return;
    }

    this.filterInput.handleInput(data);
    this.filterItems();
    this.tui.requestRender();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.container.handleMouse(event);
  }

  invalidate(): void {
    this.container.invalidate();
  }

  private helpText(): string {
    return this.commands.length > 0
      ? "输入筛选 · Tab 补全 · ↑↓ 选择 · Enter 插入 · Esc 取消"
      : "当前没有可用命令 · Esc 取消";
  }

  private filterItems(): void {
    const items = filterCommandItems(this.commands, this.filterInput.getValue());

    this.listContainer.removeChild(this.selectList);
    this.selectList = this.createSelectList(items);
    this.listContainer.addChild(this.selectList);
  }

  private completeFilter(): void {
    const completion = filterCommandItems(this.commands, this.filterInput.getValue())[0];
    if (!completion) return;

    this.filterInput.setValue("");
    this.filterInput.handleInput(completion.value);
    this.filterItems();
    this.tui.requestRender();
  }

  private createSelectList(items: SelectItem[]): SelectList {
    const list = new SelectList(items, Math.max(1, Math.min(items.length, 12)), this.listTheme);
    list.onSelect = (item) => this.onSelect(item.value);
    list.onCancel = this.onCancel;
    return list;
  }

  private selectCurrent(): void {
    const selected = this.selectList.getSelectedItem();
    if (selected) this.onSelect(selected.value);
  }
}

export async function showCommandPalette(
  pi: CommandPalettePi,
  ctx: ExtensionContext,
  provider?: AutocompleteProvider,
  requestRender?: () => void,
  executeCommand?: (command: string) => boolean,
): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("命令面板仅支持交互式终端", "error");
    return;
  }

  const commands = await loadCommandPaletteItems(provider, pi);
  if (commands.length === 0) {
    ctx.ui.notify("当前没有可用命令", "warning");
    return;
  }

  const command = await ctx.ui.custom<string | undefined>(
    (tui, theme, keybindings, done) => new CommandPalette(
      commands,
      theme,
      keybindings,
      tui,
      (value) => done(value),
      () => done(undefined),
    ),
    {
      overlay: true,
      overlayOptions: { width: "70%", minWidth: 56, maxHeight: "70%", margin: 1 },
    },
  );

  if (command) {
    const executed = shouldExecuteCommand(command) && executeCommand?.(command) === true;
    if (!executed) {
      ctx.ui.pasteToEditor(commandInsertion(command));
    }
    requestRender?.();
  }
}

export function isCommandPaletteShortcut(data: string): boolean {
  // Terminals may encode Ctrl+/ as Ctrl+_, or report the shifted ? key via
  // CSI-u. Accept the slash, question-mark, and legacy underscore forms.
  return (
    matchesKey(data, Key.ctrl(Key.slash)) ||
    matchesKey(data, Key.ctrl(Key.question)) ||
    matchesKey(data, Key.ctrl(Key.underscore))
  );
}
