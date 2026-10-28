# pi-advisor

## 职责

`pi-advisor` 是一个战略顾问 Pi 扩展：执行模型继续负责主要工作，遇到复杂任务时可调用更强的顾问模型获得方向、纠偏或收尾检查建议。顾问不获得任何工具；补充证据由执行模型收集。

## 公开边界

- 包入口：`package.json` 中 `pi.extensions` 声明的 `extensions/index.ts`。
- 工具入口：`advisor({ question: string, context?: string, stage?: "initial" | "recovery" | "final-check" })`；问题必填，执行者上下文与工具原文分区。
- 命令入口：`/advisor`、`/advisor on`、`/advisor off`、`/advisor config`、`/advisor ask`。
- 配置位置：`~/.pi/agent/advisor.json`；配置模型、调用/输出/上下文预算、推理等级、`timeoutMs`、`includeToolEvidence`，以及 `skipWhenCurrentModel` 跳过规则。规则支持裸模型 ID、精确 `provider/model` 和 `*` glob。
- 顾问上下文：具体决策问题、执行者观点、系统提示词、裁剪后的用户/assistant 文本、活动摘要和阶段信号；原始证据只在显式开启后有限采样，不完整重放工具历史。隐私与证据语义见[顾问上下文](../../requirements/contexts/pi-advisor.md)。

## 架构规则

- `extensions/index.ts` 动态加载核心实现；缺少可选 Pi peer 或运行时不兼容时只跳过 advisor，不阻断其他扩展。
- `src/advisor.ts` 负责 Pi 生命周期、模型认证、顾问工具注册、命令和 TUI 渲染；模型切换时按跳过规则同步 advisor active-tool 状态，执行层保留二次拦截。
- `src/advisor-config.ts` 负责配置文件读写、跳过规则规范化和当前模型匹配；模型强弱不做跨 provider 推断，需由用户显式配置规则。
- `src/advisor-runner.ts` 以无工具的单轮 agent loop 驱动顾问模型，传递超时/外部取消；只报告本次响应用量，不累计输入 transcript。停止原因异常和截断显式失败，不用思考正文冒充建议；包不注册自动状态栏提醒。
- `src/advisor-messages.ts` 负责角色过滤、裁剪及末尾的问题/观点/证据分区；`src/advisor-signals.ts` 集中拥有工具摘要、有限证据采样、阶段和验证命令识别。证据只来自已完成工具事件，不增加调查 IO 或模型请求。
- 顾问调用只有在问题、模型、认证和会话上下文均可用时计入 `maxUsesPerRun`；前置失败不消耗额度，进入请求后的失败仍占用。认证等待后再次检查配额以约束并行咨询，结果保留各自调用编号。

- 请求完成处可选发布轻量用量通知；失败/空响应也记录已报告计数和耗时，缺失计数保持未知，完整 Usage 返回 Pi 工具统计。通知只发送计数、隔离消费者/旧上下文错误，不改变模型结果。协议唯一依据见 [pi-token-stats 可选计量协议](pi-token-stats.md#可选计量协议)，本包不拥有统计或定价规则。

## 代码锚点

- Pi 入口：`packages/pi-advisor/extensions/index.ts`
- 顾问编排、命令和 UI：`packages/pi-advisor/src/advisor.ts`
- 顾问 agent loop：`packages/pi-advisor/src/advisor-runner.ts`
- 上下文裁剪：`packages/pi-advisor/src/advisor-messages.ts`
- 阶段与工具信号：`packages/pi-advisor/src/advisor-signals.ts`
- 回归测试：`packages/pi-advisor/test/advisor-config.test.ts`、`packages/pi-advisor/test/advisor-skip.test.ts`、`packages/pi-advisor/test/advisor-signals.test.ts`、`packages/pi-advisor/test/advisor-runner.test.ts`、`packages/pi-advisor/test/advisor-lifecycle.test.ts`
