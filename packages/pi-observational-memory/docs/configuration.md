# 配置参考

本文档记录 `pi-observational-memory` V3 的配置、默认值和迁移规则。

## 配置位置

配置放在：

- 全局：`~/.pi/agent/settings.json`；
- 项目：`<project>/.pi/settings.json`。

两者都使用 `observational-memory` 命名空间：

```json
{
  "observational-memory": {}
}
```

项目配置覆盖全局配置。`PI_OBSERVATIONAL_MEMORY_PASSIVE` 只覆盖 `passive`。扩展在当前 `Runtime` 第一次使用时加载配置，修改后需要重启 Pi 或 reload 扩展。

## 推荐起点

默认值适合普通会话，通常不需要全部配置：

```json
{
  "observational-memory": {
    "observeAfterTokens": 10000,
    "reflectAfterTokens": 20000,
    "compactAfterTokens": 81000,
    "compactAfterTokensMode": "calibrated",
    "compactAfterTokensRatio": 0.68,
    "observationsPoolMaxTokens": 20000,
    "observationsPoolTargetTokens": 10000,
    "agentMaxTurns": 16,
    "model": {
      "provider": "openrouter",
      "id": "google/gemma-4-31b-it",
      "thinking": "low"
    },
    "showWorkerNotifications": true,
    "passive": false,
    "debugLog": false
  }
}
```

未设置 `model` 时，三个后台 worker 使用当前会话模型。

## 配置表

| 配置 | 类型 | 默认值 | 说明 |
| --- | --- | ---: | --- |
| `observeAfterTokens` | 正整数 | `10000` | Observer 的源文本进度阈值 |
| `reflectAfterTokens` | 正整数 | `20000` | Reflector 的源文本进度阈值 |
| `observerChunkMaxTokens` | 正整数 | 自动推导 | 单次 Observer 新源片段上限；配置下限 `256`，运行时还会按完整输入预算缩小 |
| `compactAfterTokens` | 正整数 | `81000` | 主动压缩的源 entry 估算阈值 |
| `compactAfterTokensMode` | `calibrated`/`ratio` | `calibrated` | 固定阈值或按模型上下文窗口计算 |
| `compactAfterTokensRatio` | `0 < n < 1` | `0.68` | `ratio` 模式使用的上下文窗口比例 |
| `observationsPoolMaxTokens` | 正整数 | `20000` | 活跃观察达到该压力时提前维护反思 |
| `observationsPoolTargetTokens` | 小于 max 的正整数 | max 的一半 | Dropper 维护的活动 observation 目标 |
| `agentMaxTurns` | 正整数 | `16` | Observer、Reflector、Dropper 共用的嵌套 agent 回合上限 |
| `model` | 对象 | 未设置 | memory worker 使用的模型覆盖 |
| `model.provider` | 非空字符串 | 未设置 | Pi model registry 中的 provider |
| `model.id` | 非空字符串 | 未设置 | Pi model registry 中的模型 ID |
| `model.thinking` | 枚举 | `low` | `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max` |
| `showWorkerNotifications` | 布尔值 | `true` | 是否显示普通 worker 进度通知 |
| `passive` | 布尔值 | `false` | 是否停用后台记忆和主动压缩 |
| `debugLog` | 布尔值 | `false` | 是否增加详细调试事件；关闭不影响自动诊断 |

无效值会被忽略。`observationsPoolTargetTokens` 无效或未设置时，自动取 `floor(observationsPoolMaxTokens / 2)`。

## 观察频率

### `observeAfterTokens`

Observer 根据显式处理回执定位最旧未读源，从旧到新发送 source-addressed 片段。阶段时钟优先使用 provider 的可靠真实增量，无法度量时使用源文本估算。

阈值较低：记忆更新更及时，但模型调用更多。阈值较高：调用更少，但未观察的原始会话会积累更久。

审阅完成即写入处理回执，零 observation 也推进游标；缺少完成回执、工具拒绝项未修正或流失败时不写入整批结果。

### `observerChunkMaxTokens`

未显式设置时，取已解析 memory model 的 `contextWindow * 0.2`，未知时取 `60000`，下限为 `256`。

它限制新源片段，不修改原始 session entry。完整 entry 从旧到新加入；最老 entry 单独超限时连续分片，并保存字符游标，后续从未读位置续读，中部内容不会被永久跳过。

运行时会扣除 system prompt、既有记忆、工具 schema 和输出预留，再缩小源预算；每次 worker 请求前还会检查完整输入。预算采用保守的 UTF-8 字节估算，并非厂商 tokenizer。已有记忆超预算时显式报错，不通过截掉旧记忆掩盖问题；可改用更大上下文的记忆模型。

## Reflection 与 Dropper

### `reflectAfterTokens`

Reflector 按最近成功审阅水位统计进度。它一次提交新增反思、旧反思撤回和完整审阅回执；没有变化也记录审阅完成。只有同一主题及作用域的明确变化才撤回旧结论。

Dropper 独立按活跃观察池压力运行，不要求同轮产生新反思。任一阶段真正失败会停止后续阶段，但不回滚先前已提交的记录。

### `observationsPoolMaxTokens`

这是提前维护反思的压力阈值，不是强制删除上限。活跃观察达到 max 时，即使反思进度时钟未到期也会尝试维护。

每次记忆压缩都应用当前反思、撤回和精简，不再等待池达到 max 才更新结论。

### `observationsPoolTargetTokens`

这是 Dropper 维护活跃观察的目标。超出目标可独立触发整理；同一记忆修订完成检查后，不因零安全候选逐轮重复调用。

每项精简须标注原因。冗余、取代、已解决三类必须提供实际留存的全部替代证据；仅 low 级例行回执可不提供。引用次数不构成语义覆盖。代码按完整观察行的实际估算 token 选择候选，达到目标即停止；没有安全项时允许池仍超目标。

精简只影响活动投影。依赖的替代记忆后来失效时，原观察会恢复；账本历史和原始证据始终保留。

## 主动压缩

### `compactAfterTokens`

主动压缩统计当前保留边界以来的源 entry token。记忆 entry 和 compaction metadata 不计入该值。

达到阈值后，先在正常完成的 `turn_end` 尝试直接折叠已完整处理的旧历史，未处理消息原样保留。近期历史预算沿用 Pi 的 `compaction.keepRecentTokens` 及当前模型 override；没有安全且能缩小上下文的切点时跳过，不等待 worker。

`agent_settled` 的 idle 路径仍保留：在 `setTimeout(0)` 后复查 idle 和阈值，再调用 `ctx.compact()`。它同样不等待 Observer、Reflector 或 Dropper。

后台整理距离阈值不足一轮 `observeAfterTokens` 预算且有未处理历史时，优先追赶固定快照，暂缓反思和精简。原有阶段启动阈值不变，也没有新增前台等待时限配置。

Pi 自己的窗口压力压缩和手动压缩仍然独立存在；覆盖不足时可能仍需等待原生摘要。

### `compactAfterTokensMode`

- `calibrated`：直接使用 `compactAfterTokens`，兼容原有 V3 默认行为；
- `ratio`：使用 `floor(model.contextWindow * compactAfterTokensRatio)`；
- 上下文窗口未知、无效或非正数时，回退到固定 `compactAfterTokens`。

`contextWindow` 很大不代表模型在长距离上仍然保持同等注意力，因此 ratio 应按实际模型质量调整，而不是盲目取接近 `1` 的值。

## Memory model

未指定 `model` 时，worker 使用当前会话模型。指定模型时，`provider` 和 `id` 都必须非空，扩展从 Pi model registry 解析。

认证接受：

- API key；
- OAuth 风格的 `Authorization` 等 headers；
- Pi 在请求时使用的环境凭据，例如 Bedrock SigV4 或 Vertex ADC。

配置模型找不到时会回退到会话模型并提示一次。没有可用模型或凭据时，worker 跳过或报告失败，不生成假记忆。

## 通知、被动模式和调试

### `showWorkerNotifications`

设为 `false` 只隐藏正常的 Observer/Reflector/Dropper 进度提示。模型不可用、worker 失败、压缩提示和 `/om:*` 命令输出仍然可见。

### `passive`

设为 `true` 时停用：

- 自动 Observer；
- 自动 Reflector/Dropper；
- 主动压缩触发器。

仍保留 Pi/手动压缩、`/om:status`、`/om:view` 和 `recall`。

环境变量示例：

```bash
PI_OBSERVATIONAL_MEMORY_PASSIVE=true pi
```

支持的真值：`1`、`true`、`yes`、`on`；假值：`0`、`false`、`no`、`off`。其他值忽略。

### `debugLog`

基本运行摘要与错误始终自动采集，`debugLog: false` 不会关闭它们。设为 `true` 会增加分块启动、账本提交、凭据检查等详细事件；`showWorkerNotifications: false` 只隐藏普通进度提示，不影响诊断。

文件位于 Pi agent 目录，通常为：

```text
observational-memory/debug/<session-id>.ndjson
```

没有可用 session ID 时使用 `observational-memory/debug.ndjson`。每个文件达到 10 MiB 后轮转，保留一份 `.1` 备份。`/om:status` 显示当前路径、最近诊断编号及已知写入失败；普通错误通知只保留短原因和编号，不展开堆栈。

排查顺序：

1. 用通知中的 `diagnosticId` 在当前文件和 `.1` 中查找错误。
2. 用该记录的 `data.workerId` 关联 `worker.started`、`worker.tool_failed`、`worker.validation_rejected`、`worker.finished` / `worker.failed`；同一 `runId` 关联模型解析与外层阶段错误。重试会产生新的 `workerId`。
3. 查看 `data.failureCode`、实际 `turns`、`maxTurns`、`lastStopReason`、工具统计、校验字段及错误栈，而不是根据耗时猜测。
4. 必要时利用 `sessionFile`、内部来源 ID 和字符偏移，只读取关联的源片段进行复现；不要整份转储会话或日志到模型上下文。

| `failureCode` | 可观察事实 |
| --- | --- |
| `max_turns` | 达到 worker 轮数上限，仍无有效完成回执 |
| `output_limit` | 最后模型响应以 `length` 截断 |
| `tool_rejected` | 工具调用被拒绝或校验失败；按 `executionPhase` 区分执行前、执行中、执行后 |
| `missing_completion` | 没有有效完成回执；结束原因未上报时明确标为未知 |
| `stream_error` / `cancelled` | 模型流报错或调用取消 |
| `exception` | 流创建、预算检查或执行中的其他异常，查看原始错误摘要与栈 |

`worker.model_resolved` 记录实际选择的模型；输入只保存数量、长度、token 预算、内部来源 ID 和偏移。SDK 校验仅提取字段路径与规则，不抄录附带的原始参数。`worker.completion_invalidated` 表示曾经有效的完成状态被后续工具错误作废。`worker.finished` 只表示 worker 返回成功，是否写入记忆仍以会话账本为准。

未捕获的事件、命令和 `recall` 异常统一记录为 `extension.error`；配置、认证复检、上下文探测、压缩、用量通知与剪贴板等已处理失败也会自动留痕，保留原有行为。不会把诊断作为会话消息或观察/反思保存，也不会改变重试与完整回执要求。

日志不主动保存提示词、响应正文、记忆正文或工具参数；错误文本限制长度并遮蔽常见凭据，但仍包含项目路径、ID、厂商错误摘要和文件栈，应按私有诊断文件处理。写入失败不会替换原始异常；错误通知会说明日志未能落盘。进程被强制结束、代码尚未加载时的错误无法靠此运行时采集器追溯。

## V2 迁移

V3 不把 V2 配置名当作别名：

| V2 | V3 | 处理 |
| --- | --- | --- |
| `observationThresholdTokens` | `observeAfterTokens` | 重命名 |
| `compactionThresholdTokens` | `compactAfterTokens` | 重命名 |
| `reflectionThresholdTokens` | `reflectAfterTokens`、`observationsPoolMaxTokens`、`observationsPoolTargetTokens` | 拆分职责 |
| `compactionModel` | `model` | 移动到 `model` 对象 |
| `thinkingLevel` | `model.thinking` | 移动到 `model` 对象 |
| `observerMaxTurnsPerRun` | `agentMaxTurns` | 合并为共享上限 |
| `reflectorMaxTurnsPerPass` | `agentMaxTurns` | 合并为共享上限 |
| `prunerMaxTurnsPerPass` | `agentMaxTurns` | Dropper 使用共享上限 |
| `compactionMaxToolCalls` | 无 | 删除 |

旧 V2 memory entry 和 details 也会被忽略。升级时建议使用新会话。

## 调优示例

降低后台成本：

```json
{
  "observational-memory": {
    "observeAfterTokens": 20000,
    "reflectAfterTokens": 50000,
    "agentMaxTurns": 8,
    "model": { "provider": "openrouter", "id": "a-cheaper-model", "thinking": "off" }
  }
}
```

更及时地更新记忆：

```json
{
  "observational-memory": {
    "observeAfterTokens": 750,
    "reflectAfterTokens": 3000,
    "model": { "provider": "openrouter", "id": "a-fast-model", "thinking": "low" }
  }
}
```

临时停用后台工作：

```json
{
  "observational-memory": { "passive": true }
}
```

- [术语与数据模型](concepts.md)
- [运行机制](how-it-works.md)
- [包 README](../README.md)
