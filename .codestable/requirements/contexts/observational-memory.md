---
scope: context:observational-memory
code-paths:
  - packages/pi-observational-memory
---

# 观察式记忆上下文

## 作用域

- 上下文：`observational-memory`
- 实现包：`pi-observational-memory`
- 入口与证据：`packages/pi-observational-memory/src/index.ts`、`src/runtime.ts`、`src/hooks/`、`src/agents/`、`src/session-ledger/`、`README.md`

## 术语

- **观察**：带时间、重要度和源条目 id 的会话事实记录，是压缩前的证据层。
- **反思**：从观察中结晶出的持久事实，带支撑观察 id。
- **精简**：把已被反思充分覆盖的活跃观察移出压缩记忆；ledger 仍保留，可按 id 召回。
- **会话代次**：后台任务启动时捕获的会话标识；会话替换、重载或退出后失效。

## 稳定规则

- 面向用户的通知、命令描述与输出、状态与查看内容、worker 提示词统一使用简体中文；代码、路径、命令、标识符和错误消息保留原文。
- 后台记忆 worker（观察/反思/精简）只在达到配置阈值时启动；失败不得阻塞 Pi 主回合，也不得伪造记忆内容。
- 会话替换（new/resume/fork）、重载或退出时，Pi 先触发 `session_shutdown` 再让旧 ctx/pi 失效；扩展必须先用会话代次作废在途后台任务，之后不得再触碰旧 ctx/pi；stale-ctx 错误按正常取消处理，不作为失败提示用户。
- 压缩摘要只使用已写入 ledger 的记忆，不等待运行中的 worker；没有可渲染记忆时放弃接管，交给 Pi 原生摘要器。
- `coversUpToId` 是进度水位而不是来源证明；来源关系只由观察的 `sourceEntryIds` 与反思的 `supportingObservationIds` 表达。
- 记忆按当前分支折叠重建，不迁移 V2 设置或条目。

## 非目标

本上下文不负责 Pi 的会话存储、压缩实现、模型认证或压缩触发策略本身；它只消费 Pi 的会话事件、模型与 UI seam，负责记忆的提取、折叠、渲染与召回。
