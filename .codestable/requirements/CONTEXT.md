# 需求上下文

## 作用域地图

| 作用域 | 语义所有者 | 实现包 | 当前页面 |
| --- | --- | --- | --- |
| `context:lsp-feedback` | 代理编辑文件后的 LSP 诊断反馈 | `pi-lsp-feedback` | [lsp-feedback](contexts/lsp-feedback.md) |
| `context:quick-panel` | Pi TUI 中的技能、模型、思考等级和组合选择 | `pi-quick-panel` | [quick-panel](contexts/quick-panel.md) |
| `context:lean-tool-display` | Pi TUI 中的紧凑工具、消息和思考显示 | `pi-lean-tool-display` | [lean-tool-display](contexts/lean-tool-display.md) |
| `context:pi-optimization` | Pi Bash 重定向修复、视觉 MCP 自动开关和扩展包无感更新 | `pi-optimization` | [pi-optimization](contexts/pi-optimization.md) |
| `context:pi-wait` | 不提前调用 AI 的会话内定时任务消息 | `pi-wait` | [pi-wait](contexts/pi-wait.md) |

目前没有单独的工作区业务领域；可选扩展依赖是跨包架构契约，权威记录见 [可选扩展依赖](../architecture/shared/optional-extension-dependencies.md)。`package:pi-lsp-feedback`、`package:pi-quick-panel`、`package:pi-lean-tool-display`、`package:pi-optimization` 和 `package:pi-wait` 分别是各自领域的实现边界。

## 工作区术语

- **Pi 扩展**：通过 Pi 包清单注册，并由 Pi 生命周期事件调用的包入口。
- **受支持文件**：扩展名匹配某个已启用内置语言服务器定义的文件。
