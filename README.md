# own-pi

本仓库维护三个可独立安装的 Pi 扩展包。下面的命令都在仓库根目录运行。

## pi-lsp-feedback

只读的 LSP 诊断反馈扩展。代理成功写入或编辑文件后，它会把真实的错误和警告反馈到下一轮上下文；支持 Vue、TypeScript/JavaScript、Go、Python 和 HTML，但不会修改项目源码。

```bash
pi -e ./packages/pi-lsp-feedback
pi install ./packages/pi-lsp-feedback
```

详见 [`packages/pi-lsp-feedback/README.md`](packages/pi-lsp-feedback/README.md)。

## pi-quick-panel

TUI 快捷面板扩展，用于选择技能、模型、思考等级和模型组合。可使用 `Ctrl+L` 或 `/quick-panel` 打开。

```bash
pi -e ./packages/pi-quick-panel
pi install ./packages/pi-quick-panel
```

详见 [`packages/pi-quick-panel/README.md`](packages/pi-quick-panel/README.md)。

## pi-lean-tool-display

紧凑显示扩展，用于折叠思考内容、压缩工具调用和用户消息，并显示 Codex 5 小时窗口额度状态。

```bash
pi -e ./packages/pi-lean-tool-display
pi install ./packages/pi-lean-tool-display
```

详见 [`packages/pi-lean-tool-display/README.md`](packages/pi-lean-tool-display/README.md)。
