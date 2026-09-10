# pi-observational-memory

Pi 的观察式记忆扩展。它在后台把会话中的重要信息整理成 observations 和 reflections，并在上下文压缩时快速恢复可用记忆。

本包基于上游 `pi-observational-memory` V3 实现，已作为本仓库的独立 Pi 包接入；许可证和上游归属见 [`LICENSE`](LICENSE)。

## 功能

- **Observation**：从对话和工具结果中提取带时间、相关性和来源的事实；
- **Reflection**：把 observations 归纳为用户偏好、项目决策、约束和长期事实；
- **Dropper**：在观察池超过目标后，清理已被 reflection 充分覆盖的冗余 observation；
- **快速压缩**：已有 V3 记忆时，`session_before_compact` 只做确定性的 ledger 折叠和摘要渲染，不等待模型；
- **来源追溯**：`recall(<memory-id>)` 可以从记忆恢复支持它的 observation 和原始会话条目；
- **状态查看**：提供 `/om:status`、`/om:view` 和 `/om:view full`。

后台记忆工作会调用模型，因此会产生额外模型请求。压缩本身不等待后台 worker。

## 安装

在仓库根目录运行：

```bash
# 仅当前运行加载
pi -e ./packages/pi-observational-memory

# 安装并写入当前项目的 Pi 设置
pi install ./packages/pi-observational-memory
```

也可以运行仓库安装脚本，将当前仓库的所有扩展一起安装：

```bash
node install-extensions.mjs
```

## 使用

```text
/om:status       查看记录数、进度、记忆池和 worker 状态
/om:view         查看当前已对代理可见的记忆，并尝试复制到剪贴板
/om:view full    查看当前分支完整的 V3 ledger 记忆
recall(<id>)     由代理按明确的 12 位小写十六进制 ID 追溯来源
```

`recall` 不是语义搜索；必须先从压缩上下文、`/om:view` 或上一次 recall 结果中取得具体 ID。

## 工作方式

```text
Pi 会话事件
  → Observer 提取 observations
  → Reflector 生成长期 reflections
  → Dropper 清理活动 observation
  → V3 ledger 保存进当前分支
  → 压缩时折叠并渲染记忆
```

记忆不使用单独数据库，而是写入当前 Pi session branch 的自定义条目：

- `om.observations.recorded`
- `om.reflections.recorded`
- `om.observations.dropped`

`coversUpToId` 是各 worker 的进度水位，不是来源证明。来源关系分别保存在 observation 的 `sourceEntryIds` 和 reflection 的 `supportingObservationIds` 中。被 drop 的 observation 仍保留在 ledger 中，可以通过 ID recall。

## 配置

配置位于全局 `~/.pi/agent/settings.json` 或项目 `.pi/settings.json` 的 `observational-memory` 命名空间中。项目配置覆盖全局配置。

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

常用配置：

| 配置 | 默认值 | 作用 |
| --- | ---: | --- |
| `observeAfterTokens` | `10000` | 累积多少源文本后运行 Observer |
| `reflectAfterTokens` | `20000` | 累积多少源文本后运行 Reflector |
| `observerChunkMaxTokens` | 自动计算 | 单次送给 Observer 的源文本上限；默认取记忆模型上下文窗口的 20%，未知时为 `60000` |
| `compactAfterTokens` | `81000` | 主动触发 Pi 压缩的源文本估算阈值 |
| `compactAfterTokensMode` | `calibrated` | `calibrated` 使用固定阈值，`ratio` 按模型上下文窗口计算 |
| `compactAfterTokensRatio` | `0.68` | `ratio` 模式下使用的上下文窗口比例，必须在 `0` 和 `1` 之间 |
| `observationsPoolMaxTokens` | `20000` | 压缩时触发 full fold 的 observation 上限 |
| `observationsPoolTargetTokens` | 最大值的一半 | Dropper 维护的活动 observation 目标 |
| `agentMaxTurns` | `16` | 三类后台 memory agent 的共同回合上限 |
| `model` | 当前会话模型 | 可为 memory worker 指定更快或更便宜的模型 |
| `showWorkerNotifications` | `true` | 是否显示普通 worker 进度提示 |
| `passive` | `false` | 是否关闭后台记忆工作和主动压缩 |
| `debugLog` | `false` | 是否写入本地 NDJSON 调试日志 |

`passive` 也可以用环境变量临时覆盖：

```bash
PI_OBSERVATIONAL_MEMORY_PASSIVE=true pi
```

更多配置语义、V2 配置迁移和调优取舍见 [`docs/configuration.md`](docs/configuration.md)。

## 运行边界

- Observer、Reflector、Dropper 都是后台模型调用，会受模型认证、额度和上下文窗口影响；
- 没有可用模型或认证时，后台阶段会跳过或报告错误，不会伪造记忆；
- 记忆 worker 失败不会阻塞 Pi 的主回合；
- 压缩时只使用已经写入 ledger 的记忆，不等待正在运行的 worker；
- `passive: true` 仍保留手动/Pi 压缩、状态命令、查看命令和 recall；
- V3 不迁移 V2 的设置或记忆条目。升级后建议使用新会话。

## 代码入口

- `src/index.ts`：注册 Pi 事件、命令和 `recall` 工具；
- `src/hooks/consolidation-trigger.ts`：编排 Observer → Reflector → Dropper；
- `src/hooks/compaction-trigger.ts`：按阈值请求主动压缩；
- `src/hooks/compaction-hook.ts`：构建确定性的 V3 压缩摘要；
- `src/session-ledger/`：类型校验、折叠、进度、projection 和来源解析；
- `src/agents/`：三个后台 memory agent；
- `src/tools/recall-observation.ts`：代理侧来源追溯工具。

详细机制见：

- [`docs/concepts.md`](docs/concepts.md)：术语、数据模型和不变量；
- [`docs/how-it-works.md`](docs/how-it-works.md)：生命周期、ledger 和压缩流程；
- [`docs/configuration.md`](docs/configuration.md)：配置、迁移和调优。

## 测试

本包沿用上游的 Vitest 测试方案：

```bash
cd packages/pi-observational-memory
npm install
npm test
npm run typecheck
```

Vitest 只应作为本包的本地开发依赖使用，不推荐全局安装。全局版本会造成不同机器上的测试行为漂移；`npm test` 会优先使用本包 `devDependencies` 安装的版本。

## 许可证

MIT，见 [`LICENSE`](LICENSE)。
