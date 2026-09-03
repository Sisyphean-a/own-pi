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
/advisor ask
```

执行模型也可以调用：

```ts
advisor({ stage: "initial" })
advisor({ stage: "recovery" })
advisor({ stage: "final-check" })
```

不传 `stage` 时根据本轮工具活动自动判断。

顾问会返回 `On track`、`Course-correct` 或 `Not done yet`，以及最多 5 条下一步行动。它可以在需要时自行调用受限的 `read` 和 `bash` 诊断工具，但不会获得 `edit`/`write` 工具；工具调用不是强制步骤。

## 上下文策略

顾问收到的是裁剪后的上下文：

- 用户文本每条最多 40 行/2800 字符；
- assistant 只保留文本，最多 24 行/1800 字符；
- 原始工具结果不完整重放，只保留工具路径、命令、退出码或短摘要；
- 超过消息上限时保留开头任务 framing、末尾最近证据，省略中间消息；
- system prompt 最多 12000 字符；
- 只保留最近 8 条工具活动。
- 顾问内工具输出最多保留 12000 字符；`read` 默认返回 200 行、最多 400 行，`bash` 默认超时 30 秒、最多 120 秒。

## 运行边界

advisor 只在被执行模型调用时请求顾问模型并返回反馈；顾问可按需执行 `read` 或 `bash` 诊断，但不会自动触发这些工具，也不注册任何自动状态栏提醒。单次咨询最多运行 6 个顾问轮次和 12 次内部工具调用。

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

本包当前按原版顾问上下文实现，暂不依赖 `pi-observational-memory`。
