# Pi 运行时契约

本页记录扩展与 Pi 之间的版本边界和低层契约；这些事实无法从单个包的代码结构直接看出，且跨包共享。

## 编译与验证基线

- 当前基线是 Pi `1.2`。对 Pi 核心包（`@earendil-works/pi-coding-agent`、`@earendil-works/pi-ai`、`@earendil-works/pi-agent-core`、`@earendil-works/pi-tui`）只声明 `*` peer dependency，不打包、不在运行时固定版本；开发依赖固定到当前基线，用于类型检查与测试。
- `pi-advisor`、`pi-observational-memory`、`pi-optimization`、`pi-token-stats`、`pi-tui-enhancements` 提供 `npm run typecheck`（`tsc --noEmit`）与 `npm run check`（类型检查加测试）；提升 Pi 基线时必须先让两者通过。`pi-lsp-feedback` 是纯 JavaScript 包，没有类型检查入口。

## 内部 agent loop 上下文

- 低层 `AgentContext` 只包含 `messages` 与 `tools`；它没有 `systemPrompt` 字段，继续写入会静默丢失系统提示。
- 系统提示与工具声明必须作为 transcript 首条 system message 传入：`createInitialSystemMessage(systemPrompt, tools.map(toToolDeclaration))`（均来自 `@earendil-works/pi-ai`）。pi-advisor 的顾问循环与观察式记忆的观察/反思/精简 worker 共用这一构造方式。
- 读取当前系统提示用 `getCurrentSystemPrompt(messages)`，不要重新引入 context 字段。
- 回合上限用 `finishTurn` 返回 `{ action: "end" }` 实现；`shouldStopAfterTurn` 自 Pi 0.87 起移除。通过条件展开写入循环配置不会触发类型检查，升级基线时必须显式核对（pi-advisor 顾问循环与观察式记忆三类 worker 的 `agentMaxTurns`）。

## 运行状态与事件边界

- `before_agent_start` 是按 `messageType` 区分的联合：`"user"` 运行带 `prompt`/`images`，`pi.sendMessage(..., { triggerTurn: true })` 触发的 `"custom"` 运行带 `message` 而没有 `prompt`；只应对用户提示生效的处理器必须检查 `event.messageType === "user"`。
- 会话在 run 开始期间即视为忙碌：`before_agent_start` 内 `ctx.isIdle()` 为 false，`pi.sendMessage()` 排入正在开始的运行，忙碌时的 `pi.sendUserMessage()` 必须给 `deliverAs`。
- `turn_end` 与 `agent_before_settle` 是可返回 `{ entries, continue }` 的边界事件；`agent_settled` 只通知，其处理器请求的延迟运行会在所有处理器结束后才开始。
- `SessionEntry` 联合包含 `context_edit`（`replacement: null` 表示从模型上下文省略目标条目）；读取 `sessionManager.getBranch()` 的消费者按未知类型跳过（`pi-tui-enhancements` 的上下文视图只统计 `message` 条目）。

## 类型边界

- `ExtensionContext.thinkingLevel` 可为 `undefined`（模型未确定或会话未选择时）；面向 `ModelThinkingLevel`（`"off" | ThinkingLevel`）的接口在缺失时按 `"off"` 处理。
- `ProviderHeaders` 的值可为 `null`，不能直接赋给或当作 `Record<string, string>`；透传给 Pi 流函数时保留原类型。

## 代码锚点

- 顾问循环的系统消息构造与回合上限：`packages/pi-advisor/src/advisor-runner.ts`。
- 观察式记忆三类 worker 的上下文构造与回合上限：`packages/pi-observational-memory/src/agents/agent-context.ts`、`src/agents/observer/agent.ts`、`src/agents/reflector/agent.ts`、`src/agents/dropper/agent.ts`。
- 编译与验证入口：各包 `package.json` 的 `typecheck`/`check` 脚本与 `tsconfig.json`。
