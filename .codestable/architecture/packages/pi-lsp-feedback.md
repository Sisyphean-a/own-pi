# pi-lsp-feedback

## 职责

`pi-lsp-feedback` 是私有 Pi 扩展包。在 `write` 或 `edit` 工具结果成功后，它只在诊断可能帮助代理改进时报告 LSP 的错误和警告；它按语言服务器和工作区根目录启动并复用客户端，再把需要报告的诊断发送到代理的下一轮。同一文件即使被修改，只要仍然是同一问题也不重复发送；未确认、不可用和无诊断结果只保留为本地状态，不会发送给代理。

## 公开边界

- 包入口：`package.json` 中 `pi.extensions` 清单声明的 `extensions/index.js`。
- 用户命令：`/lsp-feedback-status` 显示已配置的服务器 ID 与存活客户端。
- 受信任项目配置边界：`.pi/lsp-feedback.json`；`src/config.js` 在受信任项目下读取、校验并合并覆盖，返回服务器清单与可显示问题；非受信任项目忽略该文件。
- 运行时依赖：`vscode-jsonrpc`、Vue、TypeScript、HTML 与 Pyright 语言服务器作为包内依赖随扩展分发；Go 服务器由扩展在受信任项目按需通过 `go install` 托管安装。

## 架构规则

- `extensions/index.js` 负责 Pi 生命周期集成、诊断服务装配、展示和状态报告；反馈选择与格式化由 `src/feedback.js` 集中负责。
- `config.js` 负责受信任项目覆盖的一次读取、校验和合并；未知服务器、未知字段和字段类型错误进入 `issues`，由扩展以警告展示。
- `DiagnosticService` 接收已解析的服务器清单，负责文件分类、根目录解析、客户端复用和标准化结果；客户端缓存键为 `<server id>:<root>`。
- `LspClient` 负责一个 JSON-RPC 服务器进程，并通过请求队列串行化文档检查；它不缓存文档正文，按最近使用顺序最多跟踪 128 个文件 URI，淘汰无等待者的 URI 时发送 `textDocument/didClose` 并清除对应协议状态；`DiagnosticService` 在检查前后核对文件内容，丢弃检查期间已变化的快照。
- `FeedbackTracker` 对未确认诊断和解析级联实施稳定性门禁：只在同一内容快照的诊断重复出现后反馈，并继续按轮次、文件和语义去重。
- `servers.js` 是内置语言映射、根目录标记、包内与本地命令查找、以及受信任覆盖项解析的规则来源。内置服务器在缺少项目标记时不再回退到工作区根（`fallbackToWorkspace: false`）；TypeScript/JavaScript 在 `findNodeTypesRoot` 解析不到 `@types/node` 时判为不可用，不启动服务器（`needsNodeTypes`）。
- `managed-server-installer.js` 负责受信任项目中 `gopls` 的一次性托管安装；项目未受信任时不会调用安装器。

## 代码锚点

- 激活与 Pi 生命周期集成：`packages/pi-lsp-feedback/extensions/index.js`（`lspFeedbackExtension`、`startSession`）。
- 按轮反馈选择、语义去重和格式化：`packages/pi-lsp-feedback/src/feedback.js`（`FeedbackTracker`）。
- 诊断编排：`packages/pi-lsp-feedback/src/diagnostic-service.js`（`DiagnosticService.checkFile`、`getClient`）。
- 协议生命周期与确认：`packages/pi-lsp-feedback/src/lsp-client.js`（`LspClient.initialize`、`checkDocumentNow`、`waitForPublication`）。
- 配置读取与合并：`packages/pi-lsp-feedback/src/config.js`（`loadProjectConfiguration`）、`packages/pi-lsp-feedback/src/servers.js`（`resolveServerOverrides`）。
- 服务器选择与根目录：`packages/pi-lsp-feedback/src/servers.js`（`BUILTIN_SERVERS`、`findWorkspaceRoot`、`commandCandidates`）。
- 托管 Go 安装：`packages/pi-lsp-feedback/src/managed-server-installer.js`（`installManagedServer`）。

反馈结果的语义规则由 [lsp-feedback 领域上下文](../../requirements/contexts/lsp-feedback.md) 维护。
