# 术语与数据模型

这份文档记录 `pi-observational-memory` V3 的领域模型。它面向需要修改或排查记忆链路的维护者。

## 整体模型

长会话超过上下文窗口后，Pi 会压缩较早的消息。这个扩展在会话进行时维护一份**当前分支上的记忆 ledger**，让压缩摘要不只是一次性的模型改写。

V3 的原则是：

- ledger 是记忆的事实来源；
- compaction entry 只保存代理当前看到的折叠结果；
- 记忆状态通过折叠当前分支上的 V3 ledger entry 重建；
- 非空记忆的压缩摘要由代码确定性渲染，不调用模型。

## 三层记忆

### Observation

Observation 是带时间、相关性和来源的会话事件，不是长期结论：

```ts
type Observation = {
  id: string;                 // 确定性的 12 位小写十六进制 ID
  content: string;            // 单行纯文本
  timestamp: string;          // YYYY-MM-DD HH:MM
  relevance: "low" | "medium" | "high" | "critical";
  sourceEntryIds: string[];   // 支持该 observation 的原始条目
  tokenCount: number;         // 渲染行的估算 token 数
}
```

Observer 只能引用它收到的源条目 ID。事件 ID 由内容、来源和片段位置共同生成：同一次事件重放去重，不同源上的同文重申保留独立身份，避免复用旧精简标记。代码计算渲染行的估算 token 数。

### Reflection

Reflection 是从 observations 中提炼的稳定结论，例如用户偏好、项目约束、架构决定、重复行为和长期事实：

```ts
type Reflection = {
  id: string;
  content: string;                    // 单行纯文本
  supportingObservationIds: string[]; // 支持该结论的 observation
  tokenCount: number;
}
```

Reflection 只保留会影响后续决定的当前持久结论，内容带项目/任务作用域、限定条件和必要理由。支持 ID 仅供溯源，不代表原观察已被完整覆盖。

明确纠正、取代或失效时，Reflector 可原子提交新反思与旧反思撤回。撤回包含旧 ID、支撑变化的观察 ID 和理由；旧反思退出当前投影，但保留历史与召回通道。提问、未再次提及或预算压力本身不构成撤回依据。

### Drop

Drop 把观察移出活动投影，不删除账本历史。新记录包含精简原因及替代记忆 ID；冗余、被取代和已解决都须有实际留存的证据，仅 low 级例行回执可无替代证据。多个替代 ID 视为共同证据，必须全部留存；证据失效时恢复原观察。旧 V3 tombstone 仍可读取。

## 三个后台角色

### Observer

在 `agent_start`/`turn_end` 检查中，进度达到 `observeAfterTokens` 后运行。从最旧未读源开始分块；超长源连续分片，保留续读位置。

通过 `record_observations` 记录事实，再用 `finish_observation` 确认全部提供的源片段已审阅。完成回执允许零观察；失败或缺回执不提交部分产出，也不推进进度。

### Reflector

进度达到 `reflectAfterTokens`，或活跃观察达到池上限时运行；需已有完整源处理水位。读取当前活动观察和有效反思，通过一次 `record_reflections` 原子提交新增、撤回及全部观察的审阅回执。无变化也可完成，不按引用次数生成覆盖等级。

### Dropper

活动观察池超过 `observationsPoolTargetTokens` 时独立尝试，不要求同轮新增反思。同一记忆修订已完成检查后，零候选不会导致逐轮重试。

模型提交原因与替代证据；代码校验当前 ID、排除同批删除的替代证据，按完整行估算 token 选择候选，达到目标即停止。预算是方向而非删除配额，没有安全项就保留。

`critical` 不是永久锁定，但仍有效的用户约束、未完成工作和决定理由须完整留存。

## Ledger entry

V3 使用三种自定义 entry：

```ts
om.observations.recorded: {
  observations: Observation[]; // 允许零条
  coversUpToId: string;
  processing: {
    processedSourceEntryIds: string[];
    startSourceOffset?: number; // 首个源的起读位置
    nextSourceOffset?: number;  // 最后一个源尚未读完时的续读位置
  };
}

om.reflections.recorded: {
  reflections: Reflection[]; // 允许零条
  coversUpToId: string;
  retirements?: { reflectionId: string; supportingObservationIds: string[]; reason: string }[];
  reviewedObservationIds: string[];
}

om.observations.dropped: {
  observationIds: string[];
  coversUpToId: string;
  evidence: {
    observationId: string;
    reason: "redundant" | "superseded" | "resolved" | "routine";
    replacementIds: string[];
  }[];
}
```

压缩 entry 的 `details` 保存代理当前可见的折叠结果：

```ts
type MemoryDetails = {
  type: "om.folded";
  version: 1;
  fullFold: boolean;
  observations: Observation[];
  reflections: Reflection[];
}
```

以上是新写入协议；[`src/session-ledger/types.ts`](../src/session-ledger/types.ts) 定义类型与校验。旧 V3 可缺少新增元数据并继续读取，但旧水位不证明完整处理；不迁移或改写会话。无效数据、旧 V2 数据和未知自定义 entry 会被忽略。

## 水位与来源

`coversUpToId` 是 worker 的**进度水位**。Observer 的整源覆盖还必须由连续片段的 `processing` 回执证明；部分源不算整条处理完成。它不是：

- observation 的来源证明；
- reflection 的依赖指针；
- 后写入的 ledger entry 由前一条生成的证明。

来源关系由以下字段表达：

- `Observation.sourceEntryIds` → 原始消息、工具结果或分支摘要；
- `Reflection.supportingObservationIds` → 支持该 reflection 的 observation。

源文本只统计 `message`、`custom_message` 和 `branch_summary`；记忆 entry 和 compaction metadata 不计入源文本进度。

## 可见、完整和漂移

V3 区分三种 projection：

- **可见记忆**：最近一次 V3 压缩的 `om.folded` details，代理当前能看到的内容；
- **完整记忆**：当前分支 tip 折叠出的全部 V3 ledger 真相；
- **漂移**：完整记忆相对于可见记忆新增或移除的部分。

后台 worker 可能在上次压缩之后写入 ledger，因此可见记忆和完整记忆暂时不同是正常的。`/om:view` 查看可见记忆，`/om:view full` 查看完整记忆，`/om:status` 显示漂移。

## Recall

`recall` 是代理工具，不是语义搜索命令。它只接受具体的 12 位小写十六进制 ID，并在当前分支中：

1. 查找 observation 或 reflection；
2. 对 observation 标记 `active` 或 `dropped`；
3. 对 reflection 标记 `active`/`retired`，展开支撑观察，以及撤回理由与撤回证据；
4. 从 observation 的 source ID 恢复原始 entry；
5. 报告缺失、非源类型和部分证据。

这样可以在记忆摘要不足以支持重要决定时恢复原文、路径、命令、错误和用户原话。

## 相关性等级

| 等级 | 用途 |
| --- | --- |
| `critical` | 身份、明确纠正、硬约束、关键完成结果 |
| `high` | 重要决定、技术方向、阻塞、关键偏好 |
| `medium` | 任务级上下文和普通进展 |
| `low` | 常规状态、工具确认和容易重新推导的细节 |

相关性是 Dropper 的判断信号之一，不是绝对保留锁。

## V2 边界

V3 不迁移 V2：

- 旧 V2 配置名会被忽略；
- 旧 V2 memory entry 和 compaction details 会被忽略；
- V3 ledger 创建后不要期待回退到 V2 仍然可见；
- 从 V2 升级时应更新配置并新建干净会话。

## 代码入口

- `src/session-ledger/types.ts`：数据模型和校验；
- `src/session-ledger/fold.ts`：ledger 折叠；
- `src/session-ledger/progress.ts`：源文本进度和 token 水位；
- `src/session-ledger/projection.ts`：可见/完整/压缩 projection；
- `src/session-ledger/recall.ts`：记忆来源解析。

- [运行机制](how-it-works.md)
- [配置参考](configuration.md)
