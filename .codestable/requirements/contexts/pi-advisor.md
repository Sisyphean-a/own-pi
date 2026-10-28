---
scope: context:pi-advisor
code-paths:
  - packages/pi-advisor
---

# 顾问上下文

## 作用域

- 上下文：`pi-advisor`
- 实现包：`pi-advisor`
- 入口与证据：`packages/pi-advisor/extensions/index.ts`、`src/advisor.ts`、`src/advisor-config.ts`、`src/advisor-runner.ts`、`src/advisor-messages.ts`、`src/advisor-signals.ts` 与 `README.md`

## 术语

- **执行模型**：当前 Pi agent，负责实际探索、编码、运行命令和验证。
- **顾问模型**：由 advisor 配置选择的顾问模型，接收精选上下文，不调用工具，返回战略建议。
- **跳过规则**：`skipWhenCurrentModel` 中匹配当前执行模型的裸模型 ID、精确 `provider/model` 或 `*` glob；命中后不调用顾问。
- **agent run**：一次从 `agent_start` 到 `agent_end` 的执行周期。
- **验证命令**：以测试、检查、lint、typecheck 或 build 等已识别命令开头的 Bash 管道段。

## 稳定规则

- 顾问是按需调用的第二意见，不替代执行模型；不获得任何工具，最后返回 `On track`、`Course-correct` 或 `Not done yet` 及最多 5 条行动项。
- 上下文保留用户任务 framing 和最新证据；assistant 只保留文本，工具结果只发送摘要，超限时省略中间消息。
- 执行模型的工具活动用于顾问上下文和阶段判断；顾问不调用工具，也不注册代码修改/验证状态栏提醒。
- 只有真实进入模型调用的咨询计入每轮调用上限；模型不存在、认证失败、无上下文或其他前置失败不消耗额度。
- `skipWhenCurrentModel` 默认为空以保持原行为；命中时在模型选择事件中从 active tools 隐藏 advisor，执行层仍二次拦截旧调用，并且 `/advisor ask` 不发送咨询请求。
- 模型强弱没有跨 provider 的可靠排序；需要跳过更强模型时由用户显式加入完整模型 key 或 glob，避免误判。
- 顾问模型配置和调用预算属于 advisor 自身；项目调查、文件修改和执行顾问建议均由执行模型控制，单次咨询只有一个顾问轮次。

## 非目标

本上下文不负责自动决定何时修改代码或执行顾问建议，也不提供顾问自动运行命令的流程。
