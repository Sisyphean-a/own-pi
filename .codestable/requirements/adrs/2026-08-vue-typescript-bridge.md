# Vue TypeScript 语义诊断采用 sidecar bridge

- 状态：accepted
- 范围：package:pi-lsp-feedback、context:lsp-feedback
- 日期：2026-08-31

## 背景

Volar 主语言服务器能够提供 Vue SFC/parser 诊断，但在当前 Pi 的 LSP 客户端中不会自行完成 `@vue/typescript-plugin` 所需的 tsserver 请求转发。只启动 standalone Volar 时，Vue 文件中的 TypeScript 语义错误可能被报告为 confirmed、空诊断，造成错误的 clean 结果；把依赖补到用户项目也会把扩展能力错误地转嫁给项目。

## 决定

`pi-lsp-feedback` 随包携带 `@vue/typescript-plugin` 和 `typescript-language-server`，Vue 客户端按工作区 TypeScript SDK 启动一个可选 TypeScript sidecar。`LspClient` 负责：

1. 同步当前 Vue 文档到 sidecar；
2. 转发 Volar 的 `tsserver/request`，并以 Volar 兼容的 `tsserver/response` 返回；
3. 对当前快照主动请求 `semanticDiagnosticsSync`，把 TypeScript 语义诊断与 Volar 的 SFC 诊断合并；
4. 将 sidecar 启动、预热、请求失败降级为主 Vue 服务器的 parser-only 路径，不阻断扩展加载或主 LSP；bridge 请求有独立上限，不能占用 TypeScript 主服务器的长冷启动等待。

## 备选方案

- 只使用 Volar standalone：无法可靠覆盖 Vue `<script setup lang="ts">` 的 TypeScript 语义诊断。
- 修改用户项目并要求安装 Vue TypeScript 插件：破坏诊断扩展的包内分发边界，并要求每个项目承担运行时配置。
- 在 Pi 客户端中实现完整 tsserver 协议：范围和维护成本超过本扩展需要；现有 `typescript-language-server` 已提供可复用的请求入口。

## 后果

- Vue 语义错误可在不修改 dsChat 等用户项目依赖的情况下被反馈。
- 每个 Vue 工作区可能多一个 TypeScript 进程，包体积增加；sidecar 诊断必须按当前文档快照同步，超时或不可用时只保留 parser 诊断。
- sidecar 协议兼容性由 `LspClient`、fake LSP 测试和 bundled Vue 集成测试共同守护；若 Volar 或 TypeScript 协议改变，应优先修改 bridge 边界而不是业务项目。

## 代码锚点

- sidecar 配置：`packages/pi-lsp-feedback/src/servers.js`（`typescriptBridgeOptions`、`BUILTIN_SERVERS`）。
- 生命周期、请求转发与诊断合并：`packages/pi-lsp-feedback/src/lsp-client.js`（`LspClient.initialize`、`updateTypeScriptBridge`、`handleTypeScriptRequest`、`requestVueTypeScriptDiagnostics`、`checkDocumentNow`）。
- 服务装配：`packages/pi-lsp-feedback/src/diagnostic-service.js`（`DiagnosticService.getClient`）。
- 协议和语义回归：`packages/pi-lsp-feedback/test/lsp-client.test.mjs`、`test/fake-lsp.mjs`、`test/diagnostic-service.test.mjs`。
