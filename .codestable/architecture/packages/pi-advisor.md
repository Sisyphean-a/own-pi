# pi-advisor

## 职责

`pi-advisor` 是一个战略顾问 Pi 扩展：执行模型继续负责主要工作，遇到复杂任务时可调用更强的顾问模型获得方向、纠偏或收尾检查建议。顾问可按需使用受限的 `read`/`bash` 诊断工具，但不获得 `edit`/`write` 工具。

## 公开边界

- 包入口：`package.json` 中 `pi.extensions` 声明的 `extensions/index.ts`。
- 工具入口：`advisor({ stage?: "initial" | "recovery" | "final-check" })`。
- 命令入口：`/advisor`、`/advisor on`、`/advisor off`、`/advisor config`、`/advisor ask`。
- 配置位置：`~/.pi/agent/advisor.json`；配置模型、每轮调用上限、输出 token、推理等级和上下文消息数。
- 顾问上下文：系统提示词、裁剪后的用户/assistant 文本、工具活动摘要和执行阶段信号；不完整重放原始工具结果。

## 架构规则

- `extensions/index.ts` 动态加载核心实现；缺少可选 Pi peer 或运行时不兼容时只跳过 advisor，不阻断其他扩展。
- `src/advisor.ts` 负责配置、Pi 生命周期、模型认证、顾问工具注册、命令和 TUI 渲染。
- `src/advisor-runner.ts` 负责以 agent loop 驱动顾问模型，按需执行内部工具并汇总工具活动与 token 用量；单次咨询最多 6 轮、12 次内部工具调用。
- `src/advisor-tools.ts` 负责可选的有界 `read`/`bash` 文件与 shell 诊断、超时和输出裁剪；顾问是否调用由顾问模型自行决定，包不注册自动状态栏提醒。
- `src/advisor-messages.ts` 负责角色过滤、逐条文本裁剪、首尾保留和 closing context message；`src/advisor-signals.ts` 负责工具摘要、阶段识别和验证命令识别。
- 顾问调用只有在模型、认证和会话上下文均可用时计入 `maxUsesPerRun`；失败不消耗调用配额。

## 代码锚点

- Pi 入口：`packages/pi-advisor/extensions/index.ts`
- 顾问编排、命令和 UI：`packages/pi-advisor/src/advisor.ts`
- 顾问 agent loop：`packages/pi-advisor/src/advisor-runner.ts`
- 顾问内诊断工具：`packages/pi-advisor/src/advisor-tools.ts`
- 上下文裁剪：`packages/pi-advisor/src/advisor-messages.ts`
- 阶段与工具信号：`packages/pi-advisor/src/advisor-signals.ts`
- 回归测试：`packages/pi-advisor/test/advisor-signals.test.ts`、`packages/pi-advisor/test/advisor-runner.test.ts`、`packages/pi-advisor/test/advisor-tools.test.ts`、`packages/pi-advisor/test/advisor-lifecycle.test.ts`
