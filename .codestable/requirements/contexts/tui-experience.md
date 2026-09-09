---
scope: context:tui-experience
code-paths:
  - packages/pi-tui-enhancements
---

# TUI 体验上下文

## 作用域

- 上下文：`tui-experience`
- 实现包：`pi-tui-enhancements`
- 入口与证据：`packages/pi-tui-enhancements/extensions/index.ts`、`src/display/`、`src/panel/`、`src/provider-usage.ts`、`README.md`

## 术语

- **快捷面板**：Pi TUI 中统一选择技能、模型、思考等级和模型组合的覆盖层。
- **紧凑显示**：在保留行动信息的前提下减少工具、消息、thinking 和 footer 的视觉噪音。
- **组合**：同时指定 provider、model 和 thinkingLevel 的可复用模型选择配置。
- **内联技能指令**：输入文本中的 `/skill:<name>`，其中 `<name>` 是已发现技能的名称。
- **技能块**：内联技能指令展开后的 `<skill>` 包装正文，包含技能名称、文件位置和相对引用基准。

## 稳定规则

- TUI 编辑器中的 `Ctrl+L` 与 `/quick-panel` 都打开快捷面板；非 TUI 模式不创建面板，并明确提示该功能不可用。
- 选择技能只向当前编辑器插入 `/skill:<name>`；选择模型或思考等级后调用 Pi 的对应设置接口；选择组合前必须确认目标模型存在且支持指定思考等级。
- 输入中的已知内联技能指令按编辑器出现顺序展开为技能块；未知指令保持原文，用户剩余文本保持原有顺序，技能 frontmatter 被移除。
- `Ctrl+Shift+T` 切换 thinking 显示状态；折叠时完全移除 thinking 内容、标签及其占位行，显示处理不改变发送给模型的消息语义。
- 工具标题和结果采用紧凑摘要，但必须保留路径、错误、行数和 diff；连续可见工具调用合并间距，`edit` 和 `write` 保持独立边界。
- footer 优先单行显示仓库/分支、统计、上下文、实时 Thinking 标记和当前模型；空间不足时才拆行，扩展状态保持独立行。
- 当前模型为 `openai-codex` 且使用官方 OAuth 时，provider usage 显示 5 小时和周窗口；`opencode-go` 使用官方 API key 显示 5 小时、周和月窗口。面板显示重置时间，footer 显示紧凑剩余百分比；非目标 provider、认证失败、响应不完整或网络失败不阻塞 TUI。
- 面板和显示两个功能域独立动态激活；缺少 Pi peer、TUI seam 或单侧内部模块时，只隐藏受影响功能，不阻断另一侧或 Pi 启动。
- 包不重复分发 Pi 核心运行时依赖；核心包由 Pi 提供并通过可选 peer dependency 声明。

## 非目标

本上下文不负责模型目录、认证配置、技能发现机制或 Pi 核心 UI 的实现；它只消费 Pi 已提供的模型、技能和 TUI seam，负责选择编排与显示增强。
