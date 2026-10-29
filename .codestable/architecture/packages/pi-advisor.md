# pi-advisor

## 职责

`pi-advisor` 是一个战略顾问 Pi 扩展：执行模型继续负责主要工作，遇到复杂任务时可调用更强的顾问模型获得方向、纠偏或收尾检查建议。顾问可通过执行者现有的 `read` 只读补齐文件证据；运行命令、修改文件和外部调查仍由执行模型负责。

## 公开边界

- 包入口：`package.json` 中 `pi.extensions` 声明的 `extensions/index.ts`。
- 工具入口：`advisor({ question: string, context?: string, stage?: "initial" | "recovery" | "final-check" })`；问题必填，执行者上下文与工具原文分区。
- 命令入口：`/advisor`、`/advisor on`、`/advisor off`、`/advisor config`、`/advisor ask`。
- 配置位置：`~/.pi/agent/advisor.json`；配置模型、调用/输出/上下文预算、推理等级、`timeoutMs`、`includeToolEvidence`，以及 `skipWhenCurrentModel` 跳过规则。规则支持裸模型 ID、精确 `provider/model` 和 `*` glob。
- 顾问上下文：具体决策问题、执行者观点、系统提示词、裁剪后的用户/assistant 文本、活动摘要和阶段信号；历史工具原文只在显式开启后有限采样，顾问主动 read 不受该开关控制；不完整重放工具历史。隐私与证据语义见[顾问上下文](../../requirements/contexts/pi-advisor.md)。

## 架构规则

- `extensions/index.ts` 动态加载核心实现；缺少可选 Pi peer 或运行时不兼容时只跳过 advisor，不阻断其他扩展。
- `src/advisor.ts` 负责 Pi 生命周期、模型认证、顾问工具注册、命令和 TUI 渲染；模型切换时按跳过规则同步 advisor active-tool 状态，执行层保留二次拦截。
- `src/advisor-config.ts` 负责配置文件读写、跳过规则规范化和当前模型匹配；模型强弱不做跨 provider 推断，需由用户显式配置规则。
- `src/advisor-runner.ts` 驱动只读、有限多轮 agent loop，读取预算或回合预算将尽时撤下工具并保留最终回答机会；超时/外部取消覆盖整次咨询。用量累加本次所有新响应，任一请求缺最终计数时对应总量未知，不累计输入 transcript。停止原因异常和截断显式失败，不用思考正文冒充建议。
- `src/advisor-read.ts` 集中拥有读取参数、次数、行数/文本体积和仅文本策略；只通过 `src/advisor.ts` 注入的主机 `ctx.executeTool("read", ...)` 调用读取，保留主机权限钩子与嵌套追踪。不构造私有文件访问、不获得命令或写入能力；主机无可调用 read 时在咨询前明确拒绝。
- `src/advisor-messages.ts` 负责角色过滤、裁剪及末尾的问题/观点/证据分区；`src/advisor-signals.ts` 集中拥有工具摘要、有限证据采样、阶段和验证命令识别。自动采样只使用已完成工具事件，不增加调查 IO 或模型请求，与顾问主动 read 分开。
- 顾问调用只有在问题、模型、认证和会话上下文均可用时计入 `maxUsesPerRun`；前置失败不消耗额度，进入请求后的失败仍占用。认证等待后再次检查配额以约束并行咨询，结果保留各自调用编号。

- 请求完成处可选发布轻量用量通知；失败/空响应也记录已报告计数和耗时，缺失计数保持未知，完整 Usage 返回 Pi 工具统计。通知只发送计数、隔离消费者/旧上下文错误，不改变模型结果。协议唯一依据见 [pi-token-stats 可选计量协议](pi-token-stats.md#可选计量协议)，本包不拥有统计或定价规则。

## 代码锚点

- Pi 入口：`packages/pi-advisor/extensions/index.ts`
- 顾问编排、命令和 UI：`packages/pi-advisor/src/advisor.ts`
- 顾问 agent loop：`packages/pi-advisor/src/advisor-runner.ts`
- 主动只读工具：`packages/pi-advisor/src/advisor-read.ts`
- 上下文裁剪：`packages/pi-advisor/src/advisor-messages.ts`
- 阶段与工具信号：`packages/pi-advisor/src/advisor-signals.ts`
- 主动读取与预算集成测试：`packages/pi-advisor/test/advisor-read.test.ts`
- 回归测试：`packages/pi-advisor/test/advisor-config.test.ts`、`packages/pi-advisor/test/advisor-skip.test.ts`、`packages/pi-advisor/test/advisor-signals.test.ts`、`packages/pi-advisor/test/advisor-runner.test.ts`、`packages/pi-advisor/test/advisor-lifecycle.test.ts`
