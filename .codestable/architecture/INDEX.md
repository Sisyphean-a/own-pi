# 架构索引

## 作用域地图

| 作用域 | 所有者 | 当前页面 | 代码锚点 |
| --- | --- | --- | --- |
| `package:pi-lsp-feedback` | `packages/pi-lsp-feedback` | [pi-lsp-feedback](packages/pi-lsp-feedback.md) | `extensions/index.js`、`src/diagnostic-service.js`、`src/lsp-client.js`、`src/servers.js` |
| `package:pi-quick-panel` | `packages/pi-quick-panel` | [pi-quick-panel](packages/pi-quick-panel.md) | `extensions/index.ts`、`src/quick-panel.ts`、`src/quick-panel-ui.ts`、`src/skills.ts`、`src/combos.ts` |
| `package:pi-lean-tool-display` | `packages/pi-lean-tool-display` | [pi-lean-tool-display](packages/pi-lean-tool-display.md) | `extensions/index.ts`、`src/message-display.ts`、`src/tool-rendering.ts`、`src/compact-footer.ts`、`src/codex-usage.ts` |
| `package:pi-optimization` | `packages/pi-optimization` | [pi-optimization](packages/pi-optimization.md) | `extensions/index.ts`、`src/nul-redirect.ts`、`src/vision-mcp-auto.ts`、`src/auto-extension-update.ts` |

## 共享机制

- [可选扩展依赖](shared/optional-extension-dependencies.md)：所有扩展对外部插件、可选 peer 和运行时能力的降级契约。
