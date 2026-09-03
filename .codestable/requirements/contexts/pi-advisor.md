# 顾问上下文

## 作用域

- 上下文：`pi-advisor`
- 实现包：`pi-advisor`
- 入口与证据：`packages/pi-advisor/extensions/index.ts`、`src/advisor.ts`、`src/advisor-runner.ts`、`src/advisor-tools.ts`、`src/advisor-messages.ts`、`src/advisor-signals.ts`、`README.md`

## 术语

- **执行模型**：当前 Pi agent，负责实际探索、编码、运行命令和验证。
- **顾问模型**：由 advisor 配置选择的更强模型，接收精选上下文，可按需读取文件或运行诊断命令，并返回战略建议。
- **agent run**：一次从 `agent_start` 到 `agent_end` 的执行周期。
- **验证命令**：以测试、检查、lint、typecheck 或 build 等已识别命令开头的 Bash 管道段。

## 稳定规则

- 顾问是按需调用的第二意见，不替代执行模型；可自行选择是否调用受限的 `read`/`bash` 诊断工具，不获得 `edit`/`write` 工具，最后返回 `On track`、`Course-correct` 或 `Not done yet` 及最多 5 条行动项。
- 上下文保留用户任务 framing 和最新证据；assistant 只保留文本，工具结果只发送摘要，超限时省略中间消息。
- 执行模型的工具活动用于顾问上下文和阶段判断；顾问工具只有在本次咨询中被顾问模型选择时才执行，不注册代码修改/验证状态栏提醒。
- 只有真实进入模型调用的咨询计入每轮调用上限；模型不存在、认证失败、无上下文或其他前置失败不消耗额度。
- 顾问模型配置和调用预算属于 advisor 自身；项目文件修改和执行顾问建议仍由执行模型控制，顾问只可按需发起受限的 `read`/`bash` 诊断，单次咨询最多 6 轮、12 次内部工具调用。

## 非目标

本上下文不负责自动决定何时修改代码或执行顾问建议，也不提供自动运行命令的流程；顾问内的诊断命令只在模型选择时运行。它不实现项目业务逻辑或保存长期项目记忆。
