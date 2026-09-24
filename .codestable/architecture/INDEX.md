# 架构索引

## 作用域地图

| 作用域 | 所有者 | 当前页面 | 代码锚点 |
| --- | --- | --- | --- |
| `package:pi-lsp-feedback` | `packages/pi-lsp-feedback` | [pi-lsp-feedback](packages/pi-lsp-feedback.md) | `extensions/index.js`、`src/feedback-session.js`、`src/diagnostic-service.js`、`src/lsp-client.js`、`src/servers.js` |
| `package:pi-tui-enhancements` | `packages/pi-tui-enhancements` | [pi-tui-enhancements](packages/pi-tui-enhancements.md) | `extensions/index.ts`、`src/display/`、`src/panel/`、`src/context/`、`src/overlay-frame.ts`、`src/provider-usage.ts`、`src/providers/` |
| `package:pi-optimization` | `packages/pi-optimization` | [pi-optimization](packages/pi-optimization.md) | `extensions/index.ts`、`src/nul-redirect.ts`、`src/fullscreen-scroll.ts`、`src/fullscreen-right-click-copy.ts`、`src/wait.ts` |
| `package:pi-advisor` | `packages/pi-advisor` | [pi-advisor](packages/pi-advisor.md) | `extensions/index.ts`、`src/advisor.ts`、`src/advisor-config.ts`、`src/advisor-runner.ts`、`src/advisor-tools.ts`、`src/advisor-messages.ts`、`src/advisor-signals.ts` |
| `package:pi-observational-memory` | `packages/pi-observational-memory` | [pi-observational-memory](packages/pi-observational-memory.md) | `src/index.ts`、`src/runtime.ts`、`src/hooks/`、`src/agents/`、`src/session-ledger/`、`src/tools/recall-observation.ts` |

## 共享机制

- [可选扩展依赖](shared/optional-extension-dependencies.md)：所有扩展对外部插件、可选 peer 和运行时能力的降级契约。
- [Pi 运行时契约](shared/pi-runtime-contract.md)：扩展的编译与验证基线、低层 agent loop 上下文和 Pi 类型边界。
