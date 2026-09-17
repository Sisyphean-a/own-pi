# pi-tui-enhancements

## 职责

`pi-tui-enhancements` 是 Pi 的 TUI 体验增强包：把快捷面板、临时技能包、紧凑显示与上下文查看统一分发，减少多个独立包同时安装时重复注册快捷键、输入处理器、显示补丁和 provider usage 的风险；面板、显示和上下文三个功能域仍保持独立装配，临时技能包属于面板域。

## 公开边界

- 包入口：`package.json` 中 `pi.extensions` 声明的 `extensions/index.ts`。
- 快捷面板入口：TUI 编辑器 `Ctrl+L` 与 `/quick-panel`；提供技能、模型、思考等级和模型组合选择，并展开已知 `/skill:<name>`。
- 临时技能包入口：`/skill-packs`；扫描全局 `skill-packs/` 与项目 `.pi/skill-packs/`，按包切换技能目录，并通过 Pi 的临时资源发现接口 reload 当前会话；包根可用 `skill-pack.json` 的 `skillPaths` 只暴露路由入口。
- 紧凑显示入口：`Ctrl+Shift+T` 切换 thinking 显示；提供紧凑工具、用户消息、footer 和实时 Thinking 标记。
- 上下文查看入口：`/context` 打开带标签页的覆盖层，展示统计、系统提示词、工具、消息和完整上下文；内容页提供滚动、搜索和复制。
- provider usage：Codex 显示 5 小时/周窗口，OpenCode Go 显示 5 小时/周/月窗口；面板显示重置时间，footer 显示紧凑百分比。
- 组合配置：全局 `quick-panel.json` 与受信任项目的 `.pi/quick-panel.json` 仍由面板域读取。

## 架构规则

- `extensions/index.ts` 是包级组合根，只负责让 `src/display/index.ts`、`src/panel/index.ts` 和 `src/context/index.ts` 独立动态激活；一侧的 peer 或运行时 seam 失败不能阻止其他侧加载。
- `src/display/` 只拥有消息、工具和 footer 的显示补丁与生命周期；`src/panel/` 拥有面板、技能展开、临时技能包、组合和编辑器快捷键；`src/context/` 只拥有 `/context` 弹窗、标签页与 token 分类。工具显示策略集中在 `src/display/tool-policy.ts`，渲染补丁只消费该策略。
- `src/context/frame.ts` 是上下文弹窗唯一的边框与宽度所有者：所有行先按显示宽度裁剪再补齐，窄终端逐级降级页脚与统计布局；`src/context/format.ts` 不引入 Pi 运行时依赖，token 估算器与压缩预留量由入口注入。
- `src/context/scrollable-tab.ts` 拥有上下文内容页的折行与滚动：视觉行按块惰性建立并缓存，只在显式失效或内宽变化时重建；滚动、搜索高亮与翻页复用缓存，搜索命中用集合按行判断。footer 的会话 token 统计由 `src/display/compact-footer.ts` 按条目增量累计，只在条目数量或前缀身份变化时整体重算。
- `src/provider-usage.ts` 是唯一的 Codex/OpenCode Go usage 所有者：请求、认证、响应解析、面板详细格式、footer 紧凑格式和安全的轮询清理都集中在这里。
- 面板选择、临时技能包、上下文查看与显示补丁不共享可变状态；三者只通过 Pi 提供的模型、UI 和生命周期接口协作。临时技能包的选择通过当前会话 custom entry 保存，不写全局或项目 `settings.json`。
- prototype patch 使用 `Symbol.for` 标记；重复加载时复用或替换已知补丁，避免同一进程重复包裹方法。usage 轮询在会话替换、reload、网络错误和非目标 provider 下必须安全停止。
- Pi 的 `@earendil-works/pi-ai`、`@earendil-works/pi-coding-agent` 和 `@earendil-works/pi-tui` 由运行时提供并声明为可选 peer dependency。

## 代码锚点

- 包级入口：`packages/pi-tui-enhancements/extensions/index.ts`
- 显示组合根：`packages/pi-tui-enhancements/src/display/index.ts`
- 面板组合根：`packages/pi-tui-enhancements/src/panel/index.ts`
- 思考和用户消息：`packages/pi-tui-enhancements/src/display/message-display.ts`
- 工具渲染：`packages/pi-tui-enhancements/src/display/tool-rendering.ts`
- 工具显示策略（内置识别、紧凑范围、分组边界、折叠行数上限）：`packages/pi-tui-enhancements/src/display/tool-policy.ts`
- 紧凑 footer：`packages/pi-tui-enhancements/src/display/compact-footer.ts`
- 面板编排与副作用：`packages/pi-tui-enhancements/src/panel/quick-panel.ts`
- 技能发现与展开：`packages/pi-tui-enhancements/src/panel/skills.ts`
- 临时技能包发现、manifest 与资源装配：`packages/pi-tui-enhancements/src/panel/skill-pack-discovery.ts`、`packages/pi-tui-enhancements/src/panel/skill-packs.ts`
- 组合配置：`packages/pi-tui-enhancements/src/panel/combos.ts`
- 上下文查看入口与数据采集：`packages/pi-tui-enhancements/src/context/index.ts`
- 上下文格式化与 token 分类：`packages/pi-tui-enhancements/src/context/format.ts`
- 上下文弹窗边框与宽度：`packages/pi-tui-enhancements/src/context/frame.ts`
- 上下文标签页与滚动搜索：`packages/pi-tui-enhancements/src/context/overlay.ts`、`packages/pi-tui-enhancements/src/context/scrollable-tab.ts`、`packages/pi-tui-enhancements/src/context/stats-tab.ts`
- 共享 provider usage：`packages/pi-tui-enhancements/src/provider-usage.ts`
- 回归测试：`packages/pi-tui-enhancements/test/`
