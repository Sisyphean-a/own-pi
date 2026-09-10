# 运行机制

这份文档说明 `pi-observational-memory` V3 的事件入口、数据流和压缩路径。

## 入口

`src/index.ts` 创建一个共享 `Runtime`，注册以下 Pi 表面：

| 入口 | 作用 |
| --- | --- |
| `agent_start`、`turn_end` | 检查是否需要后台 Observer/Reflector/Dropper |
| `agent_settled` | 在 Pi 完成重试和排队续跑后，检查主动压缩阈值 |
| `session_before_compact` | 同步构建 V3 压缩结果 |
| `/om:status` | 查看 ledger、进度、漂移和 worker 状态 |
| `/om:view` | 查看可见或完整记忆，并尝试复制到剪贴板 |
| `recall` | 按 ID 恢复原始证据 |

## 生命周期

```text
agent_start / turn_end
  → 检查 observation 水位
  → Observer（达到阈值时）
  → 检查 reflection 水位
  → Reflector（达到阈值时）
  → Dropper（同轮有新 reflection 且 observation 池超标时）
  → append V3 ledger entry

agent_settled
  → 检查压缩阈值和 Pi idle 状态
  → ctx.compact()
  → session_before_compact
  → 折叠 ledger
  → 确定性渲染摘要
```

Observer 在 pipeline 中先执行。后台 worker 不会阻塞主回合，压缩也不会等待正在运行的 worker。

## 进度计数

源文本 entry 只有以下三类：

- `message`
- `custom_message`
- `branch_summary`

每种 worker 都从自己最近有效的 `data.coversUpToId` 之后开始统计源文本：

| Worker | 水位 |
| --- | --- |
| Observer | `om.observations.recorded` |
| Reflector | `om.reflections.recorded` |
| Dropper | `om.observations.dropped` |
| 主动压缩 | 最近一次 compaction boundary |

如果 Pi 提供了 provider usage，Observer 和 Reflector 的阶段时钟会优先使用可靠的真实上下文增量；无法建立基线、上下文计数变小或旧 Pi 没有该接口时，回退到源 entry token 估算。主动压缩始终使用源 entry 估算，因为它的设置定义就是该口径。

## Consolidation pipeline

### 1. 启动检查

`src/hooks/consolidation-trigger.ts` 会：

1. 加载配置；
2. 跳过 `passive` 模式；
3. 防止已有 pipeline 重复启动；
4. 检查 observation 或 reflection 阶段是否到期；
5. 在后台保存 `Runtime` 的 in-flight、阶段和错误状态。

模型解析只在真正需要运行的阶段发生，并缓存于当前 pipeline。认证支持 API key、OAuth headers，以及 Pi 在请求时使用的环境凭据。

### 2. Observer

Observer 处理最近 observation 水位之后的源 entry：

1. 按旧到新选择 source-addressed chunk；
2. 受 `observerChunkMaxTokens` 限制，默认按记忆模型上下文窗口的 20% 推导，未知时为 `60000`；
3. 如果最老的单条 entry 本身超长，发送带省略标记的头尾片段，原始 entry 不变；
4. 调用 `runObserver()`；
5. 校验模型返回的 source ID；
6. 由代码生成确定性 12 位 ID 并计算 token 数；
7. 只有至少有一条有效 observation 时才 append `om.observations.recorded`。

空结果不会推进水位。API/stream 错误会作为真正失败记录，不能伪装成“没有观察”。

### 3. Reflector

Reflector 读取当前活动 observations 和既有 reflections：

1. 计算每个 observation 的 `none`/`partial`/`strong` 覆盖；
2. 调用 `runReflector()`；
3. 校验 reflection 内容为单行纯文本；
4. 校验所有 supporting observation ID 都来自当前活动列表；
5. 去重并 append 非空 `om.reflections.recorded`。

没有新 reflection 时不写空 entry。Reflection 失败或无输出时，同轮 Dropper 不启动。

### 4. Dropper

同轮 Reflection 成功写入后，代码折叠当前 ledger 并计算活动 observation 池指标。如果没有超过 `observationsPoolTargetTokens`，直接结束。

如果超标：

1. 计算 token 超额对应的最大删除数量；
2. 给模型展示 reflection 覆盖等级、相关性和 observation 内容；
3. 收集模型提出的 observation ID；
4. 代码过滤未知/重复 ID，并按覆盖、相关性和时间排序；
5. 只取硬上限以内的候选；
6. append 非空 `om.observations.dropped`。

Dropper 失败不会回滚已经写入的 reflection。

## 主动压缩

`src/hooks/compaction-trigger.ts` 在 `agent_settled` 后检查：

- 不是 `passive`；
- 没有其他主动压缩；
- 最近 compaction boundary 之后的源 entry token 达到阈值；
- `setTimeout(0)` 延迟复查时 Pi 仍然 idle；
- 延迟期间阈值仍然满足。

满足后调用 `ctx.compact()`。这条路径不等待 consolidation promise。

## 压缩 Hook

`src/hooks/compaction-hook.ts` 是压缩延迟的关键路径，只做确定性工作：

1. 防止重复进入；
2. 读取 `firstKeptEntryId` 和 `tokensBefore`；
3. 根据 compaction 边界构建 projection；
4. 渲染 reflections 和 observations；
5. 返回 `{ summary, firstKeptEntryId, tokensBefore, details }`。

它不会：

- 调用模型；
- 临时运行 Observer、Reflector 或 Dropper；
- 等待后台 worker；
- append ledger entry。

如果 projection 为空，Hook 不接管压缩，让 Pi 使用原生 summarizer，避免把原上下文替换成空摘要。

## Projection

`src/session-ledger/projection.ts` 统一负责命令、压缩和状态查看所需的视图：

- `fullProjection()`：折叠当前边界之前的完整 V3 ledger；
- `visibleProjection()`：读取最近 V3 compaction 的 `om.folded` details；
- `buildCompactionProjection()`：决定本次是普通折叠还是 full fold；
- `diffProjection()`：比较可见记忆与完整记忆。

Projection 按 `coversUpToId` 判断 entry 是否覆盖边界，而不是按 memory entry 的物理位置判断。首次普通压缩主要带入 observations；当可见 observation 压力达到 `observationsPoolMaxTokens` 时执行 full fold，应用 reflections 和 drops。

## Recall

`src/tools/recall-observation.ts` 调用 `src/session-ledger/recall.ts`：

1. 校验 12 位小写十六进制 ID；
2. 索引当前分支上的 V3 observations、reflections 和 drops；
3. 匹配 observation/reflection；
4. reflection 展开其支持的 observations；
5. observation 展开 `sourceEntryIds`；
6. 返回记忆内容、原始 source entry、active/dropped 状态和缺失证据诊断。

它只读取当前分支，不执行语义搜索，也不读取 V2 entry。

## 错误与竞态

- `Runtime` 的 in-flight 标记防止重复 worker；
- 阶段错误保存在 `lastObserverError`、`lastReflectorError`、`lastDropperError`；
- 无 UI 时不发送通知；
- 无效 ID、重复 ID 和空 entry 在代码边界过滤；
- Observer 的故意空结果使用退避，硬失败保持为错误；
- 压缩只折叠已经落盘的 ledger，不回滚或等待后台任务；
- 无效或悬空 coverage marker 会被进度/投影函数忽略，不导致整个会话崩溃。

## 代码入口

- `src/hooks/consolidation-trigger.ts`：后台阶段编排；
- `src/hooks/compaction-trigger.ts`：主动压缩触发；
- `src/hooks/compaction-hook.ts`：压缩摘要生成；
- `src/session-ledger/`：状态重建和 projection；
- `src/agents/`：模型 worker；
- `src/tools/recall-observation.ts`：来源追溯。

- [术语与数据模型](concepts.md)
- [配置参考](configuration.md)
