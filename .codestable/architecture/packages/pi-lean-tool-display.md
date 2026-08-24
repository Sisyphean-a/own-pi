# pi-lean-tool-display

## 职责

`pi-lean-tool-display` 是一个 Pi TUI 显示扩展，通过集中管理的 prototype patch 提供紧凑工具调用、用户消息和思考内容渲染，通过自定义 footer 提供自适应紧凑状态布局，并显示 Codex 5 小时窗口的剩余额度。

## 公开边界

- 包入口：`package.json` 中 `pi.extensions` 声明的 `extensions/index.ts`。
- 用户入口：`Ctrl+Shift+T` 快捷键切换思考显示状态。
- 显示行为：工具调用摘要、工具结果行数/错误/diff、连续工具分组、紧凑用户消息、思考标签，以及宽屏单行/窄屏双行 footer。
- Codex 状态：当前模型为 `openai-codex` 时使用 Pi 当前认证信息请求 Codex usage 接口；网络或认证失败只清空状态，不影响显示补丁。
- 运行时依赖：`@earendil-works/pi-coding-agent` 和 `@earendil-works/pi-tui` 由 Pi 运行时提供，作为 peer dependency，不在包内重复分发；消息显示、工具显示、紧凑 footer 和 Codex usage 分开动态加载，缺失或不兼容时只隐藏受影响功能。

## 架构规则

- `extensions/index.ts` 是组合根，只负责安装补丁、注册快捷键和绑定 Pi 生命周期。
- `src/message-display.ts` 拥有思考折叠、用户消息边框、思考标签和上下文清理规则。
- `src/tool-rendering.ts` 拥有工具标题、参数摘要、结果压缩、diff 展示和连续工具分组规则。
- `src/compact-footer.ts` 拥有仓库/分支、累计用量、上下文、模型和扩展状态的格式化与响应式重排；入口只负责在 TUI 会话中装配 footer。
- `src/codex-usage.ts` 拥有认证头解析、usage 请求、轮询生命周期、请求竞态和 stale session context 防护。
- 所有 prototype patch 都通过 `Symbol.for` 标记，重复加载时复用或替换已知旧补丁，避免同一进程重复包裹方法。
- usage 轮询是 best-effort 外部 IO；会话替换、reload、网络错误和非 Codex 模型都不能让 Pi 进程抛出未处理异常。

## 代码锚点

- Pi 接入：`packages/pi-lean-tool-display/extensions/index.ts`
- 思考和用户消息：`packages/pi-lean-tool-display/src/message-display.ts`
- 工具渲染：`packages/pi-lean-tool-display/src/tool-rendering.ts`
- 紧凑 footer：`packages/pi-lean-tool-display/src/compact-footer.ts`
- Codex usage：`packages/pi-lean-tool-display/src/codex-usage.ts`
- footer 布局回归：`packages/pi-lean-tool-display/test/compact-footer.test.ts`
- usage 生命周期回归：`packages/pi-lean-tool-display/test/codex-usage.test.ts`
