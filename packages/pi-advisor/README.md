# pi-advisor

Pi 的战略顾问扩展。执行模型继续负责读文件、运行命令和修改代码；需要方向判断时，它可以调用一个更强的模型返回第二意见。

## 安装

在仓库根目录运行：

```bash
pi install ./packages/pi-advisor
```

临时试用：

```bash
pi -e ./packages/pi-advisor
```

如果原来的 `pi-advisor` 已经单独安装，请先停用或移除旧扩展，避免重复注册 `advisor` 工具。

## 使用

```text
/advisor on [provider/model]
/advisor off
/advisor config
/advisor config key=value
/advisor ask [具体决策问题]
```

如果当前执行模型不需要再调用顾问，可配置跳过规则：

```json
{
  "skipWhenCurrentModel": [
    "openai-codex/gpt-5.6-sol",
    "openai-codex/gpt-5.7-*"
  ]
}
```

规则支持精确的 `provider/model`、带 `*` 的 glob，或只写模型 ID（匹配任意 provider）。也可以在 Pi 内设置：

```text
/advisor config skipWhenCurrentModel=openai-codex/gpt-5.6-sol,openai-codex/gpt-5.7-*
/advisor config skipWhenCurrentModel=clear
```

匹配时会从 active tools 中隐藏 `advisor`，并在执行层再次拦截，避免配置刚切换或旧调用仍触发顾问。模型强弱没有跨 provider 的可靠排序；需要跳过更强模型时，请显式加入它的 ID 或使用合适的 glob。

执行模型也可以调用：

```ts
advisor({
  question: "串行化与重试，哪个能解决当前竞态且不改变公开 API？",
  context: "相关文件 src/queue.ts。假设重试足够，但尚未证明幂等性；不能修改调用方。",
  stage: "recovery",
})
```

`question` 必填，最多 1000 字符且不能全为空白；可选 `context` 最多 1600 字符，用于相关路径、约束、候选方案、假设和未知项。不传 `stage` 时根据本轮工具活动自动判断。旧的 `advisor({ stage })` 调用需补上问题。

顾问返回 `On track`、`Course-correct` 或 `Not done yet`，并说明依据、最大未知项及最多 5 条行动。它没有工具；缺证据时由执行模型补充调查，不得把本次咨询当作独立代码审查通过。

工具说明会指导执行模型先收集源码、diff、报错和验证结果，再针对一个决策提问；没有新证据或决策变化时不要重复咨询。执行者的 `context` 被标为未验证观点，不能代替工具原文。

## 上下文策略

顾问收到的是裁剪后的上下文：

- 用户文本每条最多 40 行/2800 字符；
- assistant 只保留文本，最多 24 行/1800 字符；
- 原始工具结果不完整重放，只保留工具路径、命令、退出码或短摘要；
- 超过消息上限时保留开头任务 framing、末尾最近证据，省略中间消息；
- system prompt 最多 12000 字符；
- 活动摘要保留最近 8 条；启用原文转发时另附有限证据，不做额外文件读取、命令执行或模型摘要调用。

### 原始证据转发（显式开启）

确认当前工具结果允许发送给顾问 provider 后，在执行调查前设置：

```text
/advisor config includeToolEvidence=true
```

插件保留当前 run 最近 16 次工具事件的有限原文，优先选取最近失败、识别到的验证命令、修改和读取，再以最新结果补足，最多 6 条。每条正文最多 1600 字符，保留首尾并标明中间截断；整个证据块最多 12000 字符。片段带工具调用 ID、路径/命令，`read` 带已知读取范围，`edit` 使用实际 patch，`write` 使用实际写入文本。窗口之外、抽样未选中或截断部分均不等于不存在问题；包装工具也不一定被识别为验证命令。

默认 `includeToolEvidence=false`，不额外转发这些原文。它不是全面隐私隔离：原有会话文本、系统提示和短工具摘要仍会发送。开启后源码、diff、日志可能包含密钥或私人数据；插件不保证自动脱敏，所有片段只作为不可信数据，不作为指令。不要将密钥放入 `question` 或 `context`。可用下列命令停止后续原文转发：

```text
/advisor config includeToolEvidence=false
```

自动采样减少执行者只挑有利证据的风险，但不能消除遗漏、确认偏误或提示注入；执行者仍须核对顾问建议。

## 运行边界

advisor 只在被执行模型调用时请求顾问模型并返回反馈；顾问不能调用工具，不注册自动状态栏提醒。单次咨询只有一个顾问轮次，不自动重试；并行调用也共享每个 run 的配额。

默认在请求 60000ms 后发出取消信号；超时、取消、截断及模型错误均显式标为失败，已有文本只作为未完成建议，不算完成确认。计时覆盖顾问模型请求，不含调用前认证和上下文准备；取消依赖 provider 配合，不能保证精确返回时限、服务端停止计费或有效答案的到达时间。推理强度和输出上限保持用户配置，不因超时偷偷切换模型或降级。

### 用量与耗时

每次真实咨询在工具详情及 `advisor-usage` 会话条目中记录 provider/model、请求耗时、停止原因，以及 provider 已报告的输入、输出、缓存读取/写入、1h 缓存写入、总 token 和推理 token（如有）。推理 token 是输出的子集，不另加到总量；不把历史 assistant 消息的用量累计到本次咨询。界面显示输入、输出、缓存、总量和秒数；缺失计数显示 `?`，不是 0。

失败、空响应、截断和取消也保留已经报告的计数；连接中断或取消前未收到最终用量时，无法恢复真实消耗，更不能承诺与账单完全一致。完整 `Usage` 同时返回给 Pi 工具统计；可选 `pi-token-stats` 通知沿用计数协议，不传正文和认证、不重复累计工具汇总。可选统计消费者故障不会改变顾问结果。

真实端到端延迟与建议质量需在实际 provider 上评估，自动化测试不代表模型效果保证。

## 配置

配置保存在 `~/.pi/agent/advisor.json`：

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `provider` | `anthropic` | 顾问模型 provider |
| `model` | `claude-fable-5` | 顾问模型 ID |
| `maxUsesPerRun` | `3` | 每轮最多实际调用次数 |
| `maxTokens` | `16384` | 每次顾问模型响应的输出上限 |
| `reasoning` | `high` | `minimal` 到 `xhigh` |
| `maxContextMessages` | `18` | 发送给顾问的消息总数上限 |
| `timeoutMs` | `60000` | 顾问请求取消时限；整数，1000～2147483647ms，非硬实时保证 |
| `includeToolEvidence` | `false` | 是否显式转发有限原始工具证据；可能包含敏感数据 |
| `skipWhenCurrentModel` | `[]` | 当前执行模型命中规则时不调用顾问；支持 `provider/model`、glob 或裸模型 ID |

本包不依赖 `pi-observational-memory` 或 `pi-token-stats`；计量通知为可选集成。
