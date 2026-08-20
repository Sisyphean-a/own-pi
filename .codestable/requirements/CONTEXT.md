# 需求上下文

## 作用域地图

| 作用域 | 语义所有者 | 实现包 | 当前页面 |
| --- | --- | --- | --- |
| `context:lsp-feedback` | 代理编辑文件后的 LSP 诊断反馈 | `pi-lsp-feedback` | [lsp-feedback](contexts/lsp-feedback.md) |
| `context:quick-panel` | Pi TUI 中的技能、模型、思考等级和组合选择 | `pi-quick-panel` | [quick-panel](contexts/quick-panel.md) |

目前没有证据表明存在工作区级领域规则或共享领域上下文。`package:pi-lsp-feedback` 和 `package:pi-quick-panel` 分别是各自领域的实现边界；领域语言分别属于 `context:lsp-feedback` 和 `context:quick-panel`。

## 工作区术语

- **Pi 扩展**：通过 Pi 包清单注册，并由 Pi 生命周期事件调用的包入口。
- **受支持文件**：扩展名匹配某个已启用内置语言服务器定义的文件。
