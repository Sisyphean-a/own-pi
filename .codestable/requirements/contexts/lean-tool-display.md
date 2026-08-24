# 紧凑显示上下文

## 作用域

- 上下文：`lean-tool-display`
- 实现包：`pi-lean-tool-display`
- 入口与证据：`packages/pi-lean-tool-display/extensions/index.ts`、`src/message-display.ts`、`src/tool-rendering.ts`、`src/codex-usage.ts`、`README.md`

## 术语

- **紧凑工具显示**：用一行标题和有限结果摘要替代工具调用的大段默认输出，同时保留路径、错误、行数和 diff 等行动信息。
- **思考显示状态**：当前 TUI 对 assistant thinking block 的折叠或展开偏好；不改变发送给模型的原始消息。
- **stale session context**：会话替换或 reload 后仍被旧定时器/请求持有的失效 `ExtensionContext`。
- **Codex usage 状态**：当前 `openai-codex` 模型 5 小时窗口的剩余百分比状态栏信息。

## 稳定规则

- `Ctrl+Shift+T` 切换思考显示状态。
- 思考折叠只影响 TUI 显示；历史消息和流式消息都会读取当前显示状态，上下文清理只移除展示控制序列和重复的 `Thinking:` 前缀，不改其他消息内容。
- 工具标题优先使用注册元数据和可识别的主参数；read 显示文件名/相对路径与行范围，edit/write 保留 diff 或新增行数，普通工具结果默认压缩为摘要。
- 连续可见工具调用合并间距；`write` 作为独立边界。不可见子项不会打断可见工具组。
- Codex usage 请求只在当前 provider 为 `openai-codex` 且能取得认证头时执行；失败、超时、非 Codex 模型或 stale context 不得抛出未处理异常，也不得继续注册旧轮询。
- 包不重复分发 Pi 核心运行时依赖；核心包由 Pi 提供并通过 peer dependency 声明。

## 非目标

本上下文不负责修改消息持久化内容、改变模型上下文语义、提供新的认证方式或替代 Pi 核心组件；它只改变当前 TUI 的显示和 best-effort 状态提示。
