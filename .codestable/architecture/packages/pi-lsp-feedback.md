# pi-lsp-feedback

## 职责

`pi-lsp-feedback` 是私有 Pi 扩展包。在 `write` 或 `edit` 工具结果成功后，它报告 LSP 的错误和警告诊断；它按语言服务器和工作区根目录启动并复用客户端，再把需要报告的诊断发送到代理的下一轮。未确认、不可用和无诊断结果只保留为本地状态，不会发送给代理。

## 公开边界

- 包入口：`package.json` 中 `pi.extensions` 清单声明的 `extensions/index.js`。
- 用户命令：`/lsp-feedback-status` 显示已配置的服务器 ID 与存活客户端。
- 受信任项目配置边界：`.pi/lsp-feedback.json`；除非 `ctx.isProjectTrusted()` 为真，否则 `src/config.js` 会忽略它。
- 运行时依赖：`vscode-jsonrpc`、Vue、TypeScript、HTML 与 Pyright 语言服务器作为包内依赖随扩展分发；Go 服务器由扩展在受信任项目按需通过 `go install` 托管安装。

## 架构规则

- `extensions/index.js` 负责 Pi 生命周期集成、按轮聚合、展示和状态报告。
- `DiagnosticService` 负责文件分类、根目录解析、客户端复用和标准化结果；客户端缓存键为 `<server id>:<root>`。
- `LspClient` 负责一个 JSON-RPC 服务器进程，并通过请求队列串行化文档检查。
- `servers.js` 是内置语言映射、根目录标记、包内与本地命令查找、以及允许的受信任覆盖项的来源。
- `managed-server-installer.js` 负责受信任项目中 `gopls` 的一次性托管安装；项目未受信任时不会调用安装器。

## 代码锚点

- 激活与反馈格式化：`packages/pi-lsp-feedback/extensions/index.js`（`lspFeedbackExtension`、`formatFeedback`）。
- 诊断编排：`packages/pi-lsp-feedback/src/diagnostic-service.js`（`DiagnosticService.checkFile`、`getClient`）。
- 协议生命周期与确认：`packages/pi-lsp-feedback/src/lsp-client.js`（`LspClient.initialize`、`checkDocumentNow`、`waitForPublication`）。
- 服务器选择与根目录：`packages/pi-lsp-feedback/src/servers.js`（`BUILTIN_SERVERS`、`findWorkspaceRoot`、`commandCandidates`、`mergeServerOverrides`）。
- 托管 Go 安装：`packages/pi-lsp-feedback/src/managed-server-installer.js`（`installManagedServer`）。

反馈结果的语义规则由 [lsp-feedback 领域上下文](../../requirements/contexts/lsp-feedback.md) 维护。
