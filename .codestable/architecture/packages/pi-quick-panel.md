# pi-quick-panel

## 职责

`pi-quick-panel` 是一个私有 Pi 扩展包，为 TUI 提供技能、模型、思考等级和模型组合的统一选择面板，并把编辑器中的 `/skill:<name>` 指令展开为技能正文。

## 公开边界

- 包入口：`package.json` 中 `pi.extensions` 声明的 `extensions/index.ts`。
- 用户入口：TUI 编辑器 `Ctrl+L` 和 `/quick-panel` 命令。
- 技能行为：选择技能向当前编辑器插入 `/skill:<name>`；输入阶段将已知技能指令替换成带名称、路径和正文的技能块。
- 组合配置：读取全局 `quick-panel.json`；受信任项目再读取项目配置，并按名称由项目值覆盖全局值。
- 运行时依赖：`@earendil-works/pi-ai`、`@earendil-works/pi-coding-agent` 和 `@earendil-works/pi-tui` 由 Pi 运行时提供，作为 peer dependency，不在包内重复分发。

## 架构规则

- `extensions/index.ts` 只负责 Pi 生命周期、编辑器组件注册、输入转换和命令注册；面板编排由 `src/quick-panel.ts` 承担。
- `src/quick-panel.ts` 是组合根：读取可用资源、创建面板、执行技能插入、模型/思考等级切换和组合切换。
- `src/quick-panel-ui.ts` 只负责面板状态、筛选、Tab 切换、列表渲染和选择结果；`src/quick-panel-editor.ts` 只负责编辑器快捷键接入。
- `src/skills.ts` 拥有技能发现、frontmatter 清理和内联技能展开规则；`src/combos.ts` 拥有组合文件读取、校验、合并和模型解析规则。
- 面板和编辑器组件只在 `ctx.mode === "tui"` 时创建；非 TUI 的 `/quick-panel` 请求明确提示不可用。

## 代码锚点

- Pi 接入：`packages/pi-quick-panel/extensions/index.ts`
- 面板编排与副作用：`packages/pi-quick-panel/src/quick-panel.ts`
- 面板 UI：`packages/pi-quick-panel/src/quick-panel-ui.ts`
- `Ctrl+L` 编辑器接入：`packages/pi-quick-panel/src/quick-panel-editor.ts`
- 组合配置：`packages/pi-quick-panel/src/combos.ts`
- 技能发现与展开：`packages/pi-quick-panel/src/skills.ts`
- 技能展开回归：`packages/pi-quick-panel/test/skills.test.ts`
