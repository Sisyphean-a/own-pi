# 运行机制

这份文档说明 `pi-observational-memory` V3 的事件入口、数据流和压缩路径。

## 入口

`src/index.ts` 创建一个共享 `Runtime`，注册以下 Pi 表面：

| 入口 | 作用 |
| --- | --- |
| `agent_start`、`turn_end` | 检查是否需要后台 Observer/Reflector/Dropper；`turn_end` 还可直接提交已准备好的压缩结果 |
| `agent_settled` | 在 Pi 完成重试和排队续跑后，检查主动压缩阈值 |
| `session_before_compact` | 同步构建 V3 压缩结果 |
| `/om:status` | 查看 ledger、进度、暂停状态和本周期次数 |
| `/om:retry` | 显式重试一个观察分块，不顺带触发维护 |
| `session_shutdown`、`session_compact` | 会话关闭取消全部请求；压缩后取消旧周期维护 |
| `/om:view` | 查看可见或完整记忆，并尝试复制到剪贴板 |
| `recall` | 按 ID 恢复原始证据 |

## 生命周期

```text
agent_start / turn_end
  → 检查 observation 水位
  → Observer（达到阈值时）
  → 检查 reflection 水位
  → Reflector（进度到期或 observation 池达到压力上限时）
  → Dropper（observation 池超过目标时，可独立启动）
  → append V3 ledger entry

agent_settled
  → 检查压缩阈值和 Pi idle 状态
  → ctx.compact()
  → session_before_compact
  → 折叠 ledger
  → 确定性渲染摘要
```

Observer 在 pipeline 中先执行。距离主动压缩阈值不足一轮 `observeAfterTokens` 预算，且存在未处理历史时，当前 pipeline 优先分块追赶该时刻的固定快照，暂缓 Reflector/Dropper；快照之后新增的源留给下次整理。追赶中观察池达到维护压力时，允许反思/精简先插入，避免记忆池增长挤掉后续 worker 的输入预算；追赶完成且不再积压时恢复普通维护。后台 worker 不会阻塞主回合，压缩也不会等待正在运行的 worker。

## 进度计数

源文本 entry 只有以下三类：

- `message`
- `custom_message`
- `branch_summary`

Observer 的完整覆盖须有连续源片段的 `processing` 回执；零观察可完成，部分源不算整条已处理。阶段水位如下：

| Worker | 水位 |
| --- | --- |
| Observer | 带显式处理回执的 `om.observations.recorded` |
| Reflector | 含完整审阅回执的 `om.reflections.recorded`（兼容读取旧非空记录） |
| Dropper | 不设源文本时钟，按活跃观察池压力启动 |
| 主动压缩 | 最近一次 compaction boundary |

如果 Pi 提供了 provider usage，Observer 和 Reflector 的阶段时钟会优先使用可靠的真实上下文增量；无法建立基线、上下文计数变小或旧 Pi 没有该接口时，回退到源 entry token 估算。主动压缩始终使用源 entry 估算，因为它的设置定义就是该口径。

## Consolidation pipeline

### 1. 启动检查

`src/hooks/consolidation-trigger.ts` 会：

1. 加载配置；
2. 跳过 `passive` 模式；
3. 防止已有 pipeline 重复启动；
4. 检查 observation/reflection 进度或尚未维护的观察池压力；
5. 在后台保存独立取消信号、in-flight、阶段和错误状态；旧任务的结束回调不能解锁新任务。

模型解析只在真正需要运行的阶段发生，并缓存于当前 pipeline。认证支持 API key、OAuth headers，以及 Pi 在请求时使用的环境凭据。

### 2. Observer

1. 根据显式回执定位最旧未读源及字符游标；
2. 扣除提示词、既有记忆、工具声明和输出预留后，选择预算内的连续片段；
3. 先保存源位置的 `om.worker.attempted`，再调用 `runObserver()`，校验来源与单行内容并生成事件 ID；
4. 仅在 `finish_observation` 确认全部提供片段已审阅后，原子写入观察与处理回执。

每个分块只生成一次模型响应，在同次响应中提交记录及完成确认；失败整批不写，源位置暂停，只有显式 `/om:retry` 可再次尝试。尝试记录不是覆盖证明。零观察仍可推进游标；超长源续读中部，原始 entry 不变。

### 3. Reflector

读取当前活跃观察和有效反思，调用 `runReflector()`。一次工具提交同时包含新增结论、明确失效的旧结论撤回，以及全部观察的审阅回执。代码校验引用与单行内容后原子写入；没有变化也记录审阅完成。

来源引用不再被换算成覆盖等级。撤回内容退出当前投影，历史证据仍可召回。

### 4. Dropper

折叠当前 ledger，活跃观察超过目标时调用 `runDropper()`，不要求同轮有新反思。每项提议包含原因及替代证据；代码拒绝未知、自引或同批被删除的证据，并按完整行的估算 token 选择安全候选。

没有安全项就不删除。反思和精简在两次成功压缩之间各最多一次模型响应，发起前即记次数；失败或取消也不返还，重载与新增观察不重置。旧版已保存的成功维护同样计数。反思失败不拦住精简，维护失败不影响基础记录与压缩。候选协议见[精简模型](concepts.md#drop)。

## 主动压缩

`src/hooks/compaction-trigger.ts` 有两条不等待 worker 的路径。

### 回合边界直接折叠

源 entry token 达到主动压缩阈值后，在正常完成的 `turn_end` 读取已提交 ledger，直接返回 `compaction` entry，由 Pi 在进入下一回合前提交。它不调用 `ctx.compact()` 或摘要模型。

切点取宿主当前模型的 `keepRecentTokens` 所需边界与完整处理覆盖边界中更早的一个，并沿用宿主切点规则，保留工具调用与结果配对。未处理消息及其后的历史始终原样保留。切点没有推进、记忆为空或估算摘要不比待替换内容更小时，不压缩。

取消、失败、长度截断、其他扩展已有边界提案或宿主缺少所需设置能力时，跳过此优化，不更改 Pi 的恢复及续跑决定。

### Idle 主动压缩

在 `agent_settled` 后继续检查：

- 不是 `passive`；
- 没有其他主动压缩；
- 最近 compaction boundary 之后的源 entry token 达到阈值；
- `setTimeout(0)` 延迟复查时 Pi 仍然 idle；
- 延迟期间阈值仍然满足。

满足后调用 `ctx.compact()`，由现有压缩 Hook 判定是否接管。后台未覆盖待移除历史时，Pi 原生摘要器仍是安全出口；不保证每次都能免除原生摘要等待。

## 压缩 Hook

`src/hooks/compaction-hook.ts` 是压缩延迟的关键路径，只做确定性工作：

1. 防止重复进入；
2. 读取 `firstKeptEntryId` 和 `tokensBefore`；
3. 仅在没有自定义摘要重点、且切点之前所有源均有完整处理回执时构建 projection；
4. 渲染 reflections 和 observations；
5. 返回 `{ summary, firstKeptEntryId, tokensBefore, details }`。

它不会：

- 调用模型；
- 临时运行 Observer、Reflector 或 Dropper；
- 等待后台 worker；
- append ledger entry。

指定了自定义摘要重点、待移除历史尚未处理，或 projection 为空时，Hook 均不接管，由 Pi 原生 summarizer 处理。不会用旧记忆覆盖未处理约束。

## Projection

`src/session-ledger/projection.ts` 统一负责命令、压缩和状态查看所需的视图：

- `fullProjection()`：折叠当前边界之前的完整 V3 ledger；
- `visibleProjection()`：读取最近 V3 compaction 的 `om.folded` details；
- `buildCompactionProjection()`：按观察来源位置选择待压缩内容，始终应用当前维护结果；
- `diffProjection()`：比较可见记忆与完整记忆。

观察按自身 `sourceEntryIds` 判断与切点的关系，不按整批 `coversUpToId` 过滤，避免跨切点的批次丢失早期决定。每次记忆摘要均应用当前反思、撤回和精简，`fullFold` 写为 `true`。

## Recall

`src/tools/recall-observation.ts` 调用 `src/session-ledger/recall.ts`：

1. 校验 12 位小写十六进制 ID；
2. 索引当前分支上的 V3 observations、reflections 和 drops；
3. 匹配 observation/reflection；
4. reflection 展开支撑观察及撤回证据，标记当前有效或已撤回；
5. observation 展开 `sourceEntryIds`；
6. 返回记忆内容、原始 source entry、观察的 active/dropped 状态、反思的 active/retired 状态和缺失证据诊断。

它只读取当前分支，不执行语义搜索，也不读取 V2 entry。

## 错误与竞态

- `Runtime` 的 in-flight 标记防止重复 worker；
- 阶段错误保存在 `lastObserverError`、`lastReflectorError`、`lastDropperError`；
- 无 UI 时不发送通知；
- 无效提议由工具回执暴露，修正后才能完成；零产出须有显式处理或审阅回执；
- 失败及缺回执不伪装成成功；完整输入超预算时显式报错，不截断既有记忆；
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
