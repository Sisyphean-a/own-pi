# pi-tui-enhancements

## 职责

`pi-tui-enhancements` 是 Pi 的 TUI 体验增强包：把快捷面板、临时技能包、紧凑显示与上下文查看统一分发，减少多个独立包同时安装时重复注册快捷键、输入处理器、显示补丁和 provider usage 的风险；面板、显示和上下文三个功能域仍保持独立装配，临时技能包属于面板域。

## 公开边界

- 包入口：`package.json` 中 `pi.extensions` 声明的 `extensions/index.ts`。
- 紧凑显示入口：`Ctrl+Shift+T` 切换 thinking 显示；提供紧凑工具、用户消息和 footer。
- 快捷面板入口：TUI 编辑器 `Ctrl+L` 与 `/quick-panel`；提供技能、模型、思考等级和模型组合选择，并展开已知 `/skill:<name>`。编辑器还接管内嵌工作状态：working、重试、压缩显示在输入框上边框内。命令与技能描述中文化遵循 [TUI 体验上下文](../../requirements/contexts/tui-experience.md)，只影响面板描述。
- 临时技能包入口：`/skill-packs`；扫描全局 `skill-packs/` 与项目 `.pi/skill-packs/`，按包切换技能目录，并通过 Pi 的临时资源发现接口 reload 当前会话；包根可用 `skill-pack.json` 的 `skillPaths` 只暴露路由入口。
- 紧凑显示入口：`Ctrl+Shift+T` 切换 thinking 显示；提供紧凑工具、用户消息和 footer。
- 上下文查看入口：`/context` 打开带标签页的覆盖层，展示统计、系统提示词、工具、消息和完整上下文；内容页提供滚动、搜索和复制。
- provider usage：Codex 显示 5 小时/周窗口，OpenCode Go 显示 5 小时/周/月窗口，Command Code 按 provider 名称特征（`commandcode` / `cmdc` 等）识别并显示 5 小时/周/套餐月窗口；面板显示重置时间，footer 显示紧凑百分比。
- 组合配置：全局 `quick-panel.json` 与受信任项目的 `.pi/quick-panel.json` 仍由面板域读取。

## 架构规则

- `extensions/index.ts` 是包级组合根，只负责让 `src/display/index.ts`、`src/panel/index.ts` 和 `src/context/index.ts` 独立动态激活；一侧的 peer 或运行时 seam 失败不能阻止其他侧加载。
- `src/optional-feature.ts` 拥有本包的软依赖装载契约：模块导入失败、缺少约定导出或工厂抛错时通过 `src/extension-log.ts` 落盘并跳过，不向调用方抛出；它与 `pi-optimization` 的同名模块保持分发独立，不互相依赖。`src/extension-log.ts` 是内部失败的唯一日志边界，轮转并追加用户级 NDJSON，写入失败静默放弃，禁止回退到终端输出。
- `src/providers/` 拥有三个额度 provider 的完整适配器：每个 provider 一个文件声明自己的匹配方式、认证、端点、请求头和响应解析，共享骨架集中在 `fetch.ts`（超时与外部中止转发）和 `format.ts`（百分比窗口与两种展示格式）；`src/provider-usage.ts` 只保留类型出口、路由、轮询控制器与单 provider 取数入口，不判断具体 provider。
- `src/display/` 只拥有消息、工具和 footer 的显示补丁与生命周期；`src/panel/` 拥有面板、技能展开、临时技能包、组合、编辑器快捷键与编辑器状态（工作状态内嵌）；`src/context/` 只拥有 `/context` 弹窗、标签页与 token 分类。工具显示策略集中在 `src/display/tool-policy.ts`，渲染补丁只消费该策略。事件接线集中在 `src/display/session.ts`：它拥有会话主题缓存、思考折叠动作与 usage 刷新调度；`message-display.ts` 拥有思考折叠状态与思考标记规则，调用方不再自行取状态再取反。
- `src/overlay-frame.ts` 是三个弹窗唯一的边框与宽度所有者：上下文查看、快捷面板和命令面板都经 `frameRow`/`frameTop`/`frameBottom` 绘制，行先按显示宽度裁剪再补齐，边框颜色由调用方给出（上下文查看用 `border`，两个面板用 `accent`）；窄终端逐级降级页脚与统计布局；`src/context/format.ts` 不引入 Pi 运行时依赖，token 估算器与压缩预留量由入口注入。
- `src/context/scrollable-tab.ts` 拥有上下文内容页的折行与滚动：视觉行按块惰性建立并缓存，只在显式失效或内宽变化时重建；滚动、搜索高亮与翻页复用缓存，搜索命中用集合按行判断。footer 的会话 token 统计由 `src/display/compact-footer.ts` 按条目增量累计；渲染时先用 Pi 的 session ID / leaf ID 判断会话条目是否变化，未变化时不调用会遍历全会话的 `getEntries()`，新会话或前缀身份变化时整体重算。
- `src/provider-usage.ts` 是额度显示的公开入口：按当前模型选适配器，认证后只发适配器声明的请求，并把 `fetchProviderWindows` 的结果发布为 `{ provider, usage }`；Command Code 通过 credits 接口取 5 小时/周窗口、best-effort 订阅接口推断月窗口，provider 名称匹配 `commandcode`/`cmdc` 等别名，月度套餐未知时只降级省略该窗口。
- `src/panel/description-translations.ts` 是描述翻译编排、模型请求、响应校验与用户级缓存的唯一实现边界；命令面板和技能面板只传入描述并消费查询结果，不拥有翻译状态或持久化细节。缓存身份会剥离 Pi 自动补全添加的单字母来源标签，查询时再按调用面恢复标签；加载 v1 旧缓存时按规范正文重建键，因此命令面板的带标签描述和快捷面板的原始技能描述共享译文。后台请求不启用推理，并通过 payload hook 移除 Pi 从 `thinkingLevelMap.off` 派生的 `reasoning_effort` 或 `reasoning.effort` 关闭控制，避免上游把 `none` 等关闭值判为非法。
- 面板选择、临时技能包、上下文查看与显示补丁不共享可变状态；三者只通过 Pi 提供的模型、UI 和生命周期接口协作。临时技能包的选择通过当前会话 custom entry 保存，不写全局或项目 `settings.json`。
- prototype patch 使用 `Symbol.for` 标记；重复加载时复用或替换已知补丁，避免同一进程重复包裹方法。usage 轮询在会话替换、reload、网络错误和非目标 provider 下必须安全停止。
- Pi 的 `@earendil-works/pi-ai`、`@earendil-works/pi-coding-agent` 和 `@earendil-works/pi-tui` 由运行时提供并声明为可选 peer dependency。

## 代码锚点

- 包级入口：`packages/pi-tui-enhancements/extensions/index.ts`
- 可选功能装载器：`packages/pi-tui-enhancements/src/optional-feature.ts`
- 内部失败日志：`packages/pi-tui-enhancements/src/extension-log.ts`
- 显示组合根：`packages/pi-tui-enhancements/src/display/index.ts`
- 面板组合根：`packages/pi-tui-enhancements/src/panel/index.ts`
- 思考和用户消息：`packages/pi-tui-enhancements/src/display/message-display.ts`
- 工具渲染：`packages/pi-tui-enhancements/src/display/tool-rendering.ts`
- 工具显示策略（内置识别、紧凑范围、分组边界、折叠行数上限）：`packages/pi-tui-enhancements/src/display/tool-policy.ts`
- 紧凑 footer：`packages/pi-tui-enhancements/src/display/compact-footer.ts`
- 面板编排与副作用：`packages/pi-tui-enhancements/src/panel/quick-panel.ts`
- 技能发现与展开：`packages/pi-tui-enhancements/src/panel/skills.ts`
- 命令/技能描述翻译与缓存：`packages/pi-tui-enhancements/src/panel/description-translations.ts`
- 临时技能包发现、manifest 与资源装配：`packages/pi-tui-enhancements/src/panel/skill-pack-discovery.ts`、`packages/pi-tui-enhancements/src/panel/skill-packs.ts`
- 组合配置：`packages/pi-tui-enhancements/src/panel/combos.ts`
- 编辑器：`packages/pi-tui-enhancements/src/panel/quick-panel-editor.ts`
- 上下文查看入口与数据采集：`packages/pi-tui-enhancements/src/context/index.ts`
- 上下文格式化与 token 分类：`packages/pi-tui-enhancements/src/context/format.ts`
- 显示会话接线与思考折叠动作：`packages/pi-tui-enhancements/src/display/session.ts`
- 弹窗边框与宽度（三个弹窗共用）：`packages/pi-tui-enhancements/src/overlay-frame.ts`
- 上下文标签页与滚动搜索：`packages/pi-tui-enhancements/src/context/overlay.ts`、`packages/pi-tui-enhancements/src/context/scrollable-tab.ts`、`packages/pi-tui-enhancements/src/context/stats-tab.ts`
- 共享 provider usage：`packages/pi-tui-enhancements/src/provider-usage.ts`
- provider 适配器：`packages/pi-tui-enhancements/src/providers/`（`types.ts`、`fetch.ts`、`format.ts`、`registry.ts`、`codex.ts`、`opencode-go.ts`、`command-code.ts`）
- 回归测试：`packages/pi-tui-enhancements/test/`
