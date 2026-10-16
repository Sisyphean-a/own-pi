# pi-token-stats

低常驻开销的本机模型用量统计：按模型查看 token、缓存和官方价估算，并生成可双击打开的离线 HTML。需要 Node.js 24 或更高版本。

## 使用

从仓库根临时加载（不修改设置）：

```bash
pi -e ./packages/pi-token-stats
```

需要持续启用时再执行安装；用户级安装会修改真实 Pi 设置：

```bash
pi install ./packages/pi-token-stats
```

在 Pi 中使用：

```text
/token
/token html
/token html 2026-10-01 2026-10-12
/token import
/token alias my-codex gpt-5.3-codex
/token resume
/token help
```

- `/token`：今日、本月、累计的模型概览，包含整体/分模型缓存命中率、已知费用与未知原因。
- `/token html`：输出报表路径；默认全历史按日/模型汇总。同时提供起止日期时附带该范围的请求明细。浏览器可筛选并分页，无需网络或服务器；重新生成才更新。
- `/token import`：扫描当前用户 agent 目录的 `sessions/`，导入可恢复用量。重复导入与 fork 副本不会重复累计；历史按导入时价估算，缺项明确未知。
- `/token alias`：把自定义名明确映射到已知官方模型。只影响后续记录，已有价格快照不重算；没有证据的日期后缀/未知型号不会自动猜价。
- `/token resume`：磁盘故障修复后恢复采集，使用新分片避免拼接坏末行。

缓存命中率按 token 加权，不平均各模型百分比；公式及缺项口径见[模型用量上下文](../../.codestable/requirements/contexts/model-usage.md)。HTML 顶部显示当前筛选范围的整体命中率。失败/取消未返回用量单独提示，不能当成零消耗；全部费用未知时不显示 `$0`。会话中途从 A 切到 B，无需重启统计，响应仍归入各自模型，后台调用也不归到当前选择的模型。

“历史退出未确认”统计的是未留下正常关闭标记的写入运行，不是失败请求数，也不能证明丢数据。提示同时列出最后状态仍有待写的运行数；即使为 0，也不能排除最后一次状态保存之后的尾部损失。历史记录不自动改成正常。正常退出会刷盘并保存关闭标记；强杀或崩溃无法保证执行清理。已知丢弃、写入失败和无法检查进程状态另行提示。

费用是官方 API 标准价的 **USD 估算**，不是订阅月费或真实扣款。默认包含有明确价格依据的 GPT、DeepSeek、Claude 型号；具体型号和版本见 [价表](src/pricing.ts)。DeepSeek 的标准估算显式采用官方峰值价，不含非高峰/节假日优惠；不计特殊服务档及工具额外收费。老型号、自定义名或核心合并摘要缺少可靠模型时，费用未知，不按零处理。

## 数据与性能

数据位于 `~/.pi/agent/pi-token-stats/`（遵循 `PI_CODING_AGENT_DIR`）。`journal/` 是按日/写入进程分片的权威 NDJSON；`index.sqlite` 是仅在命令执行期间打开的可重建查询索引，`token-report.html` 是报表快照。关闭 Pi 后，删除冷索引不会丢失权威日志，下次命令会重建；不要删除 `journal/`。

不记录提示词、回答、密钥或项目路径，不自动删除历史。统计模型请求的输入、缓存读写与输出；推理 token 不重复累计。来源不分类。仓库内顾问、记忆 worker、翻译请求通过可选通知上报；第三方私有调用不保证覆盖。缓存预热增量检查最多延后约 5 秒。没有可靠请求时间/耗时的核心摘要显示记录时间与未知耗时。

采集不处理逐 token 流、不加载全历史：待写数据约 256 KiB 上限、约 1 秒合批。满时丢新记录，磁盘故障暂停并释放缓冲，正常退出尽量刷盘；查询显示已知损失。价格不会后台联网更新。报表和导入为显式的冷操作，耗时/资源随所选数据量增长，不承诺零开销或账单级精确。

## 开发验证

```bash
npm --prefix packages/pi-token-stats install --ignore-scripts
npm --prefix packages/pi-token-stats run check
npm --prefix packages/pi-token-stats run benchmark
```

基准只测合成突发中的请求完成计量/入队，不代表生产端到端延迟。开发依赖随宿主 Pi 基线升级，仅用于本地类型检查与测试；本包无新增运行时依赖，也不分发 `node_modules`。

稳定统计口径见 [模型用量上下文](../../.codestable/requirements/contexts/model-usage.md)。
