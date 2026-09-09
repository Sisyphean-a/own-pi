# 需求上下文

## 作用域地图

| 作用域 | 语义所有者 | 实现包 | 当前页面 |
| --- | --- | --- | --- |
| `context:lsp-feedback` | 代理编辑文件后的 LSP 诊断反馈 | `pi-lsp-feedback` | [lsp-feedback](contexts/lsp-feedback.md) |
| `context:tui-experience` | Pi TUI 中的面板选择与紧凑显示 | `pi-tui-enhancements` | [tui-experience](contexts/tui-experience.md) |
| `context:pi-optimization` | Pi Bash 重定向修复、视觉 MCP 自动开关、定时消息和扩展包无感更新 | `pi-optimization` | [pi-optimization](contexts/pi-optimization.md) |
| `context:pi-advisor` | 复杂 Pi 编码任务中的战略顾问调用与方向检查 | `pi-advisor` | [pi-advisor](contexts/pi-advisor.md) |

目前没有单独的工作区业务领域；可选扩展依赖是跨包架构契约，权威记录见 [可选扩展依赖](../architecture/shared/optional-extension-dependencies.md)。`package:pi-lsp-feedback`、`package:pi-tui-enhancements`、`package:pi-optimization` 和 `package:pi-advisor` 分别是各自领域的实现边界。

## 工作区术语

- **Pi 扩展**：通过 Pi 包清单注册，并由 Pi 生命周期事件调用的包入口。
- **受支持文件**：扩展名匹配某个已启用内置语言服务器定义的文件。
