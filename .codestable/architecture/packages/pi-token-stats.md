# pi-token-stats

## 职责与边界

独立拥有本机模型用量的采集、归一化、官方价估算、日志、冷查询及离线报表；语义规则只定义在 [model-usage](../../requirements/contexts/model-usage.md)。其他扩展只发布可选计量通知，不拥有价格或持久化策略。

- 入口：`extensions/index.ts` 动态加载 `src/index.ts`，缺少可选 Pi peer 不阻断启动；资源只从 `session_start` 启动，`session_shutdown` 清理。
- `src/record.ts` 只读取计数、模型、时间和去重身份，不复制正文；原始 provider/response 身份仅进入内部摘要，不保存为统计维度。
- `src/pricing.ts` 拥有显式模型匹配与带官方来源的本地价格版本；不使用接入 Model 的厂商费用，不把未知日期后缀自动当作已知版本。
- `src/writer.ts` 拥有有界缓冲、异步合批、暂停/恢复和运行状态；日志按 UTC 日期/运行 UUID 分片，每个写入进程只写自己的文件。
- `src/index.ts` 监听主 finalized assistant、核心摘要完成事件与后台计量总线；预热用低频 leaf 水位检查和 O(1) getEntry 走新增条目，不调用全量 getEntries/getBranch。用于事件去重的最近条目集合上限 256，不持有全部历史。
- `src/query.ts` 仅命令时加载 Node 内建 SQLite：日志为权威来源，唯一记录 id 与分片字节水位构成可重建冷索引。导入以同一身份去重，先持久化再提交冷索引；损坏末行保留且报告，不掩盖数据库 IO 错误。
- `src/report.ts` 生成内嵌数据的离线 HTML，明细只读取显式日期范围，DOM 按页构建；模型字符串用 JSON 转义与 textContent，禁止网络连接。

## 可选计量协议

唯一协议所有者是本包，通道 `pi:model-usage:v1` 通过 `pi.events` 通知。生产者在每个 finalized assistant 后发送：`provider/model/responseModel/responseId/timestamp/durationMs/stopReason`，及 `usage.input/output/cacheRead/cacheWrite/cacheWrite1h/totalTokens`。不发送正文、提示词、厂商费用或认证。消费者同步入有界缓冲，不能阻塞流或反向控制模型；生产者必须隔离缺能力、订阅者异常与 stale-ctx。工具汇总 usage 不重复累计。

生产者接线：
- 顾问：`packages/pi-advisor/src/advisor-runner.ts` 与 `src/model-usage.ts`。
- 观察/反思/精简：`packages/pi-observational-memory/src/agents/*/agent.ts` 的可选 onUsage，经 `src/hooks/consolidation-trigger.ts` 和 `src/agents/model-usage.ts` 发布。
- 翻译：`packages/pi-tui-enhancements/src/panel/description-translations.ts` 在校验结果之前发布，`src/panel/index.ts` 注入总线，`src/model-usage.ts` 提取计数。

三个生产者的轻量提取器保持自包含，以便扩展单独分发；不引入统计包运行时硬依赖。继续遵循 [可选扩展依赖](../shared/optional-extension-dependencies.md)。

## 验证与版本边界

`test/stats.test.ts` 覆盖公开计量、去重、损坏日志、故障、导入、注册生命周期和 HTML 安全；`test/performance.mjs` 测量合成采集/入队。Node 基线为 24（内建 SQLite 仅冷路径加载）。开发依赖随 [Pi 运行时契约](../shared/pi-runtime-contract.md) 的当前基线，仅用于本包类型检查与测试，不分发 `node_modules`。

用户用法与数据恢复入口见 [包 README](../../../packages/pi-token-stats/README.md)。
