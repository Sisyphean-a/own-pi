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
| `observerChunkMaxTokens` | 正整数 | 自动推导 | 单次 Observer 输入上限，最小按 `256` 处理 |
| `compactAfterTokens` | 正整数 | `81000` | 主动压缩的源 entry 估算阈值 |
| `compactAfterTokensMode` | `calibrated`/`ratio` | `calibrated` | 固定阈值或按模型上下文窗口计算 |
| `compactAfterTokensRatio` | `0 < n < 1` | `0.68` | `ratio` 模式使用的上下文窗口比例 |
| `observationsPoolMaxTokens` | 正整数 | `20000` | 普通压缩 projection 达到该压力后执行 full fold |
| `observationsPoolTargetTokens` | 小于 max 的正整数 | max 的一半 | Dropper 维护的活动 observation 目标 |
| `agentMaxTurns` | 正整数 | `16` | Observer、Reflector、Dropper 共用的嵌套 agent 回合上限 |
| `model` | 对象 | 未设置 | memory worker 使用的模型覆盖 |
| `model.provider` | 非空字符串 | 未设置 | Pi model registry 中的 provider |
| `model.id` | 非空字符串 | 未设置 | Pi model registry 中的模型 ID |
| `model.thinking` | 枚举 | `low` | `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max` |
| `showWorkerNotifications` | 布尔值 | `true` | 是否显示普通 worker 进度通知 |
| `passive` | 布尔值 | `false` | 是否停用后台记忆和主动压缩 |
| `debugLog` | 布尔值 | `false` | 是否写入本地调试日志 |

无效值会被忽略。`observationsPoolTargetTokens` 无效或未设置时，自动取 `floor(observationsPoolMaxTokens / 2)`。

## 观察频率

### `observeAfterTokens`

Observer 统计最近 `om.observations.recorded.data.coversUpToId` 之后的源 entry。达到阈值后，按旧到新发送一块 source-addressed 文本。

阈值较低：记忆更新更及时，但模型调用更多。阈值较高：调用更少，但未观察的原始会话会积累更久。

如果模型没有记录任何 observation，扩展不写空 entry，也不推进水位。故意空结果会退避，等新的源文本积累后再尝试。

### `observerChunkMaxTokens`

未显式设置时，取已解析 memory model 的 `contextWindow * 0.2`，未知时取 `60000`，下限为 `256`。

它只限制送给 Observer 的文本，不修改原始 session entry。完整 entry 会优先从旧到新加入；如果最老 entry 单独就超限，会发送带省略标记的头尾片段，仍保留原 ID 供 recall。

不要把它设置成模型完整上下文窗口，因为还要为 system prompt、既有记忆、工具 schema 和模型输出留空间。

## Reflection 与 Dropper

### `reflectAfterTokens`

Reflector 的进度从最近 `om.reflections.recorded.data.coversUpToId` 之后统计。它不是 Dropper 的独立阈值。

Dropper 只有在同一次 pipeline 中 Reflector 写入非空 reflection 后才会尝试，并且活动 observation 超过 `observationsPoolTargetTokens` 才会调用模型。

### `observationsPoolMaxTokens`

这是压缩 projection 的 full-fold 压力阈值，不是 Dropper 的目标，也不是 Reflector 的调度阈值。

压缩时先构建普通 projection；如果活动 observations 的 token 数达到 max，才通过完整 ledger 应用 reflections 和 drops，生成 full fold。

### `observationsPoolTargetTokens`

这是 Dropper 维护活动 observation 的目标。超出目标时，代码把超额 token 换算成一个最大删除数量；该数量是硬上限，不是模型必须完成的数量。

Dropper 输入会标注 observation 的 reflection 覆盖：

- `none`：没有 reflection 支持；
- `partial`：一个 reflection 支持；
- `strong`：两个或更多 reflection 支持。

覆盖只是证据，不是自动删除规则。Dropper 仍需判断内容是否被等价保留、替代或去重。删除只影响活动 projection，历史仍可 recall。

## 主动压缩

### `compactAfterTokens`

主动压缩在 `agent_settled` 事件中运行，统计最近 compaction boundary 之后的源 entry token。记忆 entry 和 compaction metadata 不计入该值。

扩展会在 `setTimeout(0)` 后确认 Pi 仍然 idle，并重新检查阈值，然后调用 `ctx.compact()`。它不等待 Observer、Reflector 或 Dropper。

Pi 自己的窗口压力压缩和手动压缩仍然独立存在。

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

开启后在 Pi agent 目录写入 NDJSON 调试文件，通常位于：

```text
observational-memory/debug/<session-id>.ndjson
```

没有可用 session ID 时回退到 `observational-memory/debug.ndjson`。日志记录阶段、数量、token、ID、错误和运行上下文，默认不记录 prompt、模型响应或记忆正文。日志文件可能包含敏感的项目路径和 ID，应按本地诊断文件处理。

日志写失败不会改变记忆行为。

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
