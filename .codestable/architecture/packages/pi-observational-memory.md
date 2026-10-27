# pi-observational-memory

## 职责

`pi-observational-memory` 是 Pi 的观察式记忆包：在后台把会话压缩成带来源的观察与反思，压缩时确定性地渲染记忆摘要，并提供按 id 追溯原始证据的 `recall`。

## 公开边界

- 包入口：`package.json` 中 `pi.extensions` 声明的 `src/index.ts`。
- 用户命令：`/om:status`、`/om:view`、`/om:view full`、`/om:retry`；代理工具：`recall`。
- 生命周期入口：`agent_start` / `turn_end` 触发后台整理，`turn_end` 可直接提议已准备好的前缀压缩，`agent_settled` 保留 idle 主动压缩，`session_before_compact` 同步构建压缩摘要，`session_shutdown` 作废在途后台任务。
- 配置：全局 `~/.pi/agent/settings.json` 与项目 `.pi/settings.json` 的 `observational-memory` 段；`PI_OBSERVATIONAL_MEMORY_PASSIVE` 只覆盖 `passive`。
- 诊断输出：`/om:status` 提供日志路径与最近诊断编号；本地 NDJSON 与记忆存储分离，行为和隐私约束由领域上下文拥有。
- 记忆存储：当前 Pi session branch 的自定义条目 `om.observations.recorded`、`om.reflections.recorded`、`om.observations.dropped`；不使用单独数据库。

## 架构规则

- 领域规则唯一依据见[观察式记忆上下文](../../requirements/contexts/observational-memory.md)：语言、会话作废、处理回执、反思撤回、安全精简与压缩接管条件不在本页重复定义。
- `Runtime` 持有每个后台任务的独立取消控制器；`endSession()` 取消在途请求、自增代次并释放运行状态和进度缓存，旧任务只可清理自己的控制器。Pi 的 stale-ctx 错误按取消处理。
- 记忆状态由 `foldLedger()` 重建，活动投影与包含已精简观察/已撤回反思的历史索引分离，`recall` 复用该折叠结果判定状态。调用控制状态由 `session-ledger/attempts.ts` 从当前分支的 `om.worker.attempted`、旧版成功维护和 compaction 边界读取；不使用额外数据库或迁移旧会话。
- 覆盖进度和主动压缩的原始 token 计量由 `src/session-ledger/token-progress.ts` 维护为增量水位：Pi 的 `getBranch()` 每次都返回新数组，因此以分支前缀的首/末条目身份而非数组身份判定追加；分叉、压缩重写等前缀变化时重建，会话关闭时主动清空。账本追加只累计新增源条目，覆盖标记推进时从新标记重新累计；真实上下文增量仍以 provider 上报的 usage 为基准，锚点缺失时回退到原始水位。阶段到期判断与阶段内准入都消费它，主动压缩在 `turn_end`、`agent_settled` 及延迟复核时复用同一进度缓存，不逐轮重算整本账本。
- 回合边界通过 Pi 的 `BoundaryResult.entries` 提交 `compaction`，不从忙碌的事件中调用 `ctx.compact()`；宿主负责落盘和重建下一回合上下文。切点计算复用 `findCutPoint`，近期历史预算通过内存 `SettingsManager` 解析宿主设置及模型 override，不读写额外设置文件。
- 压缩 Hook 用 `hasProcessedSourcePrefix()` 校验完整覆盖，观察按逐条来源位置而非整批水位选入摘要；维护结果每次都应用，避免旧结论因延迟全量折叠再次出现。
- 池压力缓存按记忆条目的修订 id 失效；同一修订已完成精简检查后不逐轮重复调用，源消息追加仍使用增量阶段时钟。调度入口与追赶插队复用 `maintenanceCanRun()`，同时考虑压力、剩余维护机会和反思启动条件，不能把仅有池压力视为可执行维护。
- `Runtime` 在首次使用时加载配置；模型认证判定不得比 Pi 自身的门禁更严格。
- `src/diagnostic-boundary.ts` 统一包装事件、命令和工具执行，保留同步返回、原始异常及 Promise 语义；`src/agents/worker-diagnostics.ts` 只观测 worker，不接管循环或提交。`src/debug-log.ts` 按会话文件写入、轮转并按运行/worker 作用域关联同一异常的诊断编号。

- 请求完成处可选发布轻量用量通知；只发送计数、隔离消费者/旧上下文错误，不改变模型结果。协议唯一依据见 [pi-token-stats 可选计量协议](pi-token-stats.md#可选计量协议)，本包不拥有统计或定价规则。
- 后台 worker 固定单次模型响应，`src/agents/stream-errors.ts` 保留真实流错误，不再包含自动整轮重试。尝试记录在调用前提交；暂停、周期次数和手动恢复的唯一规则见领域上下文。观察请求的可复用记忆前缀与末尾时间由 `observerUserText()` 统一构造，输入预算和实际调用消费同一文本结构。

## 代码锚点

- 入口与事件注册：`packages/pi-observational-memory/src/index.ts`
- 运行时、认证解析与会话代次：`packages/pi-observational-memory/src/runtime.ts`
- 整理编排：`packages/pi-observational-memory/src/hooks/consolidation-trigger.ts`
- 主动压缩：`packages/pi-observational-memory/src/hooks/compaction-trigger.ts`
- 压缩摘要：`packages/pi-observational-memory/src/hooks/compaction-hook.ts`
- ledger 折叠、进度与来源解析：`packages/pi-observational-memory/src/session-ledger/`
- 覆盖进度的增量水位：`packages/pi-observational-memory/src/session-ledger/token-progress.ts`（`JournalTokenProgress`）
- 后台 worker：`packages/pi-observational-memory/src/agents/observer/`、`src/agents/reflector/`、`src/agents/dropper/`；单次请求错误：`src/agents/stream-errors.ts`；尝试与周期状态：`src/session-ledger/attempts.ts`
- 自动诊断与错误边界：`src/debug-log.ts`、`src/diagnostic-boundary.ts`、`src/agents/worker-diagnostics.ts`
- 完整输入与输出预算：`packages/pi-observational-memory/src/model-budget.ts`；连续源分片：`src/serialize.ts`
- 召回工具：`packages/pi-observational-memory/src/tools/recall-observation.ts`
- 配置：`packages/pi-observational-memory/src/config.ts`
- 回归测试：`packages/pi-observational-memory/tests/`（Vitest）
