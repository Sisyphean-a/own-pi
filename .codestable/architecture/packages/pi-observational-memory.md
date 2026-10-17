# pi-observational-memory

## 职责

`pi-observational-memory` 是 Pi 的观察式记忆包：在后台把会话压缩成带来源的观察与反思，压缩时确定性地渲染记忆摘要，并提供按 id 追溯原始证据的 `recall`。

## 公开边界

- 包入口：`package.json` 中 `pi.extensions` 声明的 `src/index.ts`。
- 用户命令：`/om:status`、`/om:view`、`/om:view full`；代理工具：`recall`。
- 生命周期入口：`agent_start` / `turn_end` 触发后台整理，`agent_settled` 检查主动压缩阈值，`session_before_compact` 同步构建压缩摘要，`session_shutdown` 作废在途后台任务。
- 配置：全局 `~/.pi/agent/settings.json` 与项目 `.pi/settings.json` 的 `observational-memory` 段；`PI_OBSERVATIONAL_MEMORY_PASSIVE` 只覆盖 `passive`。
- 记忆存储：当前 Pi session branch 的自定义条目 `om.observations.recorded`、`om.reflections.recorded`、`om.observations.dropped`；不使用单独数据库。

## 架构规则

- 领域规则唯一依据见[观察式记忆上下文](../../requirements/contexts/observational-memory.md)：语言、会话作废、处理回执、反思撤回、安全精简与压缩接管条件不在本页重复定义。
- `Runtime.endSession()` 自增代次并释放运行标志和进度缓存；后台任务捕获启动代次，Pi 的 stale-ctx 错误按取消处理。
- 状态由 `foldLedger()` 重建，活动投影与包含已精简观察/已撤回反思的历史索引分离，`recall` 复用该折叠结果判定状态。
- 覆盖进度和主动压缩的原始 token 计量由 `src/session-ledger/token-progress.ts` 维护为增量水位：Pi 的 `getBranch()` 每次都返回新数组，因此以分支前缀的首/末条目身份而非数组身份判定追加；分叉、压缩重写等前缀变化时重建，会话关闭时主动清空。账本追加只累计新增源条目，覆盖标记推进时从新标记重新累计；真实上下文增量仍以 provider 上报的 usage 为基准，锚点缺失时回退到原始水位。阶段到期判断与阶段内准入都消费它，主动压缩在 `agent_settled` 及延迟复核时复用同一进度缓存，不逐轮重算整本账本。
- 压缩 Hook 用 `hasProcessedSourcePrefix()` 校验完整覆盖，观察按逐条来源位置而非整批水位选入摘要；维护结果每次都应用，避免旧结论因延迟全量折叠再次出现。
- 池压力缓存按记忆条目的修订 id 失效；同一修订已完成精简检查后不逐轮重复调用，源消息追加仍使用增量阶段时钟。
- `Runtime` 在首次使用时加载配置；模型认证判定不得比 Pi 自身的门禁更严格。

- 请求完成处可选发布轻量用量通知；只发送计数、隔离消费者/旧上下文错误，不改变模型结果。协议唯一依据见 [pi-token-stats 可选计量协议](pi-token-stats.md#可选计量协议)，本包不拥有统计或定价规则。
- worker 的瞬态失败由 `src/agents/worker-retry.ts` 判定并重跑整个 worker 调用；`WorkerStreamError` 保留 `stopReason`/`errorMessage`，重试判定复用 Pi 的 `isRetryableAssistantError`。会话代次变化后立即放弃重试，确定性失败不重试。

## 代码锚点

- 入口与事件注册：`packages/pi-observational-memory/src/index.ts`
- 运行时、认证解析与会话代次：`packages/pi-observational-memory/src/runtime.ts`
- 整理编排：`packages/pi-observational-memory/src/hooks/consolidation-trigger.ts`
- 主动压缩：`packages/pi-observational-memory/src/hooks/compaction-trigger.ts`
- 压缩摘要：`packages/pi-observational-memory/src/hooks/compaction-hook.ts`
- ledger 折叠、进度与来源解析：`packages/pi-observational-memory/src/session-ledger/`
- 覆盖进度的增量水位：`packages/pi-observational-memory/src/session-ledger/token-progress.ts`（`JournalTokenProgress`）
- 后台 worker：`packages/pi-observational-memory/src/agents/observer/`、`src/agents/reflector/`、`src/agents/dropper/`；瞬态失败重试：`src/agents/worker-retry.ts`
- 完整输入与输出预算：`packages/pi-observational-memory/src/model-budget.ts`；连续源分片：`src/serialize.ts`
- 召回工具：`packages/pi-observational-memory/src/tools/recall-observation.ts`
- 配置：`packages/pi-observational-memory/src/config.ts`
- 回归测试：`packages/pi-observational-memory/tests/`（Vitest）
