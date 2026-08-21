# pi-lsp-feedback

Pi 的只读 LSP 诊断反馈扩展。

## 功能

- 在代理成功执行 `write` 或 `edit` 后检查受支持文件；
- 将真实的 LSP 错误和警告反馈到下一轮代理上下文；
- 支持 Vue、TypeScript/JavaScript、Go、Python 和 HTML；
- 包内携带 Node 语言服务器，可信项目可按需托管安装 `gopls`；
- 不格式化文件、不应用修复、不扫描项目，也不修改项目源码；
- 使用 `/lsp-feedback-status` 查看服务器和诊断状态。

## 安装

在仓库根目录运行：

```bash
# 仅当前运行加载
pi -e ./packages/pi-lsp-feedback

# 安装并写入 Pi 设置
pi install ./packages/pi-lsp-feedback
```
