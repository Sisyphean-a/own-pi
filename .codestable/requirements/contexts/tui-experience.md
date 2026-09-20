---
scope: context:tui-experience
code-paths:
  - packages/pi-tui-enhancements
---

# TUI 体验上下文

## 作用域

- 上下文：`tui-experience`
- 实现包：`pi-tui-enhancements`
- 入口与证据：`packages/pi-tui-enhancements/extensions/index.ts`、`src/display/`、`src/panel/`、`src/context/`、`src/provider-usage.ts`、`README.md`

## 术语

- **快捷面板**：Pi TUI 中统一选择技能、模型、思考等级和模型组合的覆盖层。
- **紧凑显示**：在保留行动信息的前提下减少工具、消息、thinking 和 footer 的视觉噪音。
- **上下文查看**：`/context` 打开的带标签页覆盖层，展示统计、系统提示词、工具、消息和完整上下文，并提供滚动、搜索与复制。
- **组合**：同时指定 provider、model 和 thinkingLevel 的可复用模型选择配置。
- **内联技能指令**：输入文本中的 `/skill:<name>`，其中 `<name>` 是已发现技能的名称。
- **技能块**：内联技能指令展开后的 `<skill>` 包装正文，包含技能名称、文件位置和相对引用基准。
- **临时技能包**：`skill-packs/` 下按直接子目录分组的一组可选技能；包目录本身不是常驻技能目录，只有当前会话启用后才通过资源发现接口加入技能资源。

## 稳定规则

- TUI 编辑器中的 `Ctrl+L` 与 `/quick-panel` 都打开快捷面板；非 TUI 模式不创建面板，并明确提示该功能不可用。
- 选择技能只向当前编辑器插入 `/skill:<name>`；选择模型或思考等级后调用 Pi 的对应设置接口；选择组合前必须确认目标模型存在且支持指定思考等级。
- `/skill-packs` 只扫描全局 `~/.pi/agent/skill-packs` 与项目 `.pi/skill-packs` 的直接包目录；不含可发现 `SKILL.md` 的目录不会显示。未受信任项目只显示全局包。普通包会将包目录整体交给 Pi 的 `resources_discover`；包根存在 `skill-pack.json` 时只交给 Pi 其中 `skillPaths` 指定且位于包内的入口路径。未启用包不会进入系统提示词或技能命令。
- 技能包选择是当前会话状态：以 `skill-pack-selection` custom entry 保存，不写 `settings.json`；reload 重新读取该 entry，新会话没有选择，恢复原会话可恢复选择。
- 输入中的已知内联技能指令按编辑器出现顺序展开为技能块；未知指令保持原文，用户剩余文本保持原有顺序，技能 frontmatter 被移除。
- `Ctrl+Shift+T` 切换 thinking 显示状态；折叠时完全移除 thinking 内容、标签及其占位行，显示处理不改变发送给模型的消息语义。
- 工具标题和结果采用紧凑摘要，但必须保留路径、错误、行数和 diff；折叠态每个可分组工具行最多保留一行正文，多行命令只显示第一行，参数流式输入时仅多行命令显示输入行数，参数完成后移除输入计数并只显示输出行数，整个过程不得改变该工具行高度；裁剪只在折叠态生效，`Ctrl+O` 或点击展开后输出完整结果；连续可见工具调用合并间距，`edit` 和 `write` 保持 Pi 原生渲染与独立边界。
- footer 优先单行显示仓库/分支、统计、上下文、实时 Thinking 标记和当前模型；空间不足时才拆行，扩展状态保持独立行。
- `/context` 仅在交互式终端可用，非 TUI 模式只提示不可用；弹窗包含统计、系统、工具、消息、完整五个标签页，`Tab`/`Shift+Tab` 切换，`q`/`Esc` 关闭，搜索态 `Esc` 只退出搜索。
- 上下文标签页的折行结果只取决于逻辑行内容与内宽：内宽变化或显式失效时重建，滚动、搜索高亮和翻页必须复用，不得逐帧重算整页文本。
- footer 的会话 token 统计按会话条目增量累计，只有条目数量变化或前缀身份改变（reload、分支切换、压缩重写）才整体重算；Thinking 动画重绘不得触发全量求和。
- 上下文弹窗的每一行必须按显示宽度裁剪再补齐，中文、长路径和 ANSI 颜色不得撑破边框或触发换行；窄终端按优先级去掉网格、百分比列和页脚提示，不裁断数值；网格与色块不依赖 Nerd Font 图标。
- 上下文分类按字符估算后整体缩放到 provider 上报的总量，分类之和与总量一致；读取技能文件的工具调用计入技能而不是工具。
- 当前模型为 `openai-codex` 且使用官方 OAuth 时，provider usage 显示 5 小时和周窗口；`opencode-go` 使用官方 API key 显示 5 小时、周和月窗口；Command Code 按 provider 名称特征（`commandcode`、`command-code`、`cmdc`）识别，用官方 API key 查询官方 credits 与订阅套餐，显示 5 小时、周和套餐月窗口，套餐未知时只省略月窗口。面板显示重置时间，footer 显示紧凑剩余百分比；非目标 provider、认证失败、响应不完整或网络失败不阻塞 TUI。
- 面板、上下文查看和显示三个功能域独立动态激活；缺少 Pi peer、TUI seam 或单侧内部模块时，只隐藏受影响功能，不阻断其他侧或 Pi 启动。
- 包不重复分发 Pi 核心运行时依赖；核心包由 Pi 提供并通过可选 peer dependency 声明。

## 非目标

本上下文不负责模型目录、认证配置、Pi 核心自动技能发现机制或 Pi 核心 UI 的实现；它只消费 Pi 已提供的模型、技能和 `resources_discover` seam，负责可选技能包的目录分组、会话级选择、资源装配与 TUI 编排。
