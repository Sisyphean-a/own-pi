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

Observer 只能引用它收到的源条目 ID。代码会校验 ID、去重，并重新计算 ID 和 token 数。

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

Reflection 应该少于 observation，不能机械地为每条 observation 生成一条 reflection。支持 ID 是后续 Dropper 判断冗余覆盖的证据，不能为了提高覆盖数量而虚增。

### Drop

Drop 是 observation ID 的 tombstone：

```ts
om.observations.dropped: {
  observationIds: string[];
  coversUpToId: string;
}
```

Drop 只移除活动 projection 中的 observation，不删除 ledger 历史。只要 ID 仍在当前分支上，已经 dropped 的 observation 仍可以 recall。

## 三个后台角色

### Observer

在 `agent_start`/`turn_end` 的 consolidation 检查中，源文本达到 `observeAfterTokens` 后运行。它接收 observation 水位之后的源条目，按大小从旧到新分块，并通过 `record_observations` 工具提交结果。

没有值得记录的内容时不写空 ledger entry，也不推进覆盖水位；为避免每轮重复请求，故意的空结果会短暂退避。

### Reflector

源文本达到 `reflectAfterTokens` 且存在 observation 覆盖后运行。它读取当前活动 observations 和既有 reflections，通过 `record_reflections` 提交新的稳定结论。

每个 observation 会被标记为 `none`、`partial` 或 `strong` 覆盖等级，供模型判断遗漏，但覆盖等级不是必须生成 reflection 的配额。

### Dropper

Dropper 只在同一次 consolidation 中 Reflector 成功写入非空 reflection 后尝试运行，并且活动 observation 池超过 `observationsPoolTargetTokens` 时才有工作。

它可以提出要删除的活动 observation ID，但代码仍会：

- 过滤未知 ID 和重复 ID；
- 根据 reflection 覆盖、相关性、时间等因素排序；
- 限制最多删除的数量；
- 把删除记录写为 tombstone。

`critical` 是高阻力等级，不是永久锁定；只有模型判断旧内容已被安全覆盖、替代或去重时才可能被移除。

## Ledger entry

V3 使用三种自定义 entry：

```ts
om.observations.recorded: {
  observations: Observation[];
  coversUpToId: string;
}

om.reflections.recorded: {
  reflections: Reflection[];
  coversUpToId: string;
}

om.observations.dropped: {
  observationIds: string[];
  coversUpToId: string;
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

`src/session-ledger/types.ts` 负责类型、ID、相关性和 entry 数据校验；无效数据、旧 V2 数据和未知自定义 entry 会被忽略。

## 水位与来源

`coversUpToId` 是 worker 的**进度/投影水位**，表示它处理到哪个源 entry。它不是：

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
3. 对 reflection 找出支持它的 observations；
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
