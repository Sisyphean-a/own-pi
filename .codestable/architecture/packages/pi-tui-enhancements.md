# pi-tui-enhancements

## 职责

`pi-tui-enhancements` 是 Pi 的 TUI 体验增强包：把快捷面板与紧凑显示统一分发，减少两个独立包同时安装时重复注册快捷键、输入处理器、显示补丁和 provider usage 的风险；两个功能域仍保持独立装配。

## 公开边界

- 包入口：`package.json` 中 `pi.extensions` 声明的 `extensions/index.ts`。
- 快捷面板入口：TUI 编辑器 `Ctrl+L` 与 `/quick-panel`；提供技能、模型、思考等级和模型组合选择，并展开已知 `/skill:<name>`。
- 紧凑显示入口：`Ctrl+Shift+T` 切换 thinking 显示；提供紧凑工具、用户消息、footer 和实时 Thinking 标记。
- provider usage：Codex 显示 5 小时/周窗口，OpenCode Go 显示 5 小时/周/月窗口；面板显示重置时间，footer 显示紧凑百分比。
- 组合配置：全局 `quick-panel.json` 与受信任项目的 `.pi/quick-panel.json` 仍由面板域读取。

## 架构规则

- `extensions/index.ts` 是包级组合根，只负责让 `src/display/index.ts` 和 `src/panel/index.ts` 独立动态激活；一侧的 peer 或运行时 seam 失败不能阻止另一侧加载。
- `src/display/` 只拥有消息、工具和 footer 的显示补丁与生命周期；`src/panel/` 只拥有面板、技能、组合和编辑器快捷键。
- `src/provider-usage.ts` 是唯一的 Codex/OpenCode Go usage 所有者：请求、认证、响应解析、面板详细格式、footer 紧凑格式和安全的轮询清理都集中在这里。
- 面板选择与显示补丁不共享可变状态；两者只通过 Pi 提供的模型、UI 和生命周期接口协作。
- prototype patch 使用 `Symbol.for` 标记；重复加载时复用或替换已知补丁，避免同一进程重复包裹方法。usage 轮询在会话替换、reload、网络错误和非目标 provider 下必须安全停止。
- Pi 的 `@earendil-works/pi-ai`、`@earendil-works/pi-coding-agent` 和 `@earendil-works/pi-tui` 由运行时提供并声明为可选 peer dependency。

## 代码锚点

- 包级入口：`packages/pi-tui-enhancements/extensions/index.ts`
- 显示组合根：`packages/pi-tui-enhancements/src/display/index.ts`
- 面板组合根：`packages/pi-tui-enhancements/src/panel/index.ts`
- 思考和用户消息：`packages/pi-tui-enhancements/src/display/message-display.ts`
- 工具渲染：`packages/pi-tui-enhancements/src/display/tool-rendering.ts`
- 紧凑 footer：`packages/pi-tui-enhancements/src/display/compact-footer.ts`
- 面板编排与副作用：`packages/pi-tui-enhancements/src/panel/quick-panel.ts`
- 技能发现与展开：`packages/pi-tui-enhancements/src/panel/skills.ts`
- 组合配置：`packages/pi-tui-enhancements/src/panel/combos.ts`
- 共享 provider usage：`packages/pi-tui-enhancements/src/provider-usage.ts`
- 回归测试：`packages/pi-tui-enhancements/test/`
