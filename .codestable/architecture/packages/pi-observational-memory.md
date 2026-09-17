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

- 面向用户的通知、命令描述与输出、状态/查看内容和三个后台 agent 的提示词统一使用简体中文；代码、路径、命令、标识符和错误消息保留原文。
- 会话代次：Pi 在会话替换（new/resume/fork）、重载或退出时先触发 `session_shutdown`，再让旧 ctx/pi 失效；`Runtime.endSession()` 自增代次并释放运行标志，后台任务按启动时捕获的代次作废，之后不得再触碰 ctx/pi；Pi 的 stale-ctx 错误按正常取消处理，不作为失败提示用户。
- 后台 worker 只在达到配置阈值时启动；失败不得阻塞 Pi 主回合，没有可用模型或认证时跳过并报告，不伪造记忆。
- 记忆状态由折叠当前分支的 V3 ledger 条目重建；`coversUpToId` 只是进度水位，来源关系由观察的 `sourceEntryIds` 与反思的 `supportingObservationIds` 表达。
- 覆盖进度的原始 token 计量由 `src/session-ledger/token-progress.ts` 维护为增量水位：账本对象被替换（reload、分支切换、压缩重写）时整体重建，账本追加时只累计新增源条目，覆盖标记推进时从新标记重新累计；真实上下文增量仍以 provider 上报的 usage 为基准，锚点缺失时回退到该水位。阶段到期判断与阶段内准入都消费它，不逐轮重算整本账本。
- 压缩只使用已写入 ledger 的记忆，不等待运行中的 worker；没有可渲染记忆时放弃接管，交给 Pi 原生摘要器。
- `Runtime` 在首次使用时加载配置；模型认证判定不得比 Pi 自身的门禁更严格。

## 代码锚点

- 入口与事件注册：`packages/pi-observational-memory/src/index.ts`
- 运行时、认证解析与会话代次：`packages/pi-observational-memory/src/runtime.ts`
- 整理编排：`packages/pi-observational-memory/src/hooks/consolidation-trigger.ts`
- 主动压缩：`packages/pi-observational-memory/src/hooks/compaction-trigger.ts`
- 压缩摘要：`packages/pi-observational-memory/src/hooks/compaction-hook.ts`
- ledger 折叠、进度与来源解析：`packages/pi-observational-memory/src/session-ledger/`
- 覆盖进度的增量水位：`packages/pi-observational-memory/src/session-ledger/token-progress.ts`（`JournalTokenProgress`）
- 后台 worker：`packages/pi-observational-memory/src/agents/observer/`、`src/agents/reflector/`、`src/agents/dropper/`
- 召回工具：`packages/pi-observational-memory/src/tools/recall-observation.ts`
- 配置：`packages/pi-observational-memory/src/config.ts`
- 回归测试：`packages/pi-observational-memory/tests/`（Vitest）
