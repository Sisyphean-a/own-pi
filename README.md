# own-pi

本仓库维护四个可独立安装的 Pi 扩展包。下面的命令都在仓库根目录运行。

## 一键重新安装当前目录扩展

`install-extensions.mjs` 会扫描脚本所在目录下 `packages/` 中声明了 `pi.extensions` 的包，并执行以下流程：

1. 只移除 Pi 设置中解析后位于当前仓库目录下的本地包；
2. 保留 npm、git 和其他目录来源的扩展；
3. 重新安装当前目录下发现的全部扩展。

默认安装到当前项目的 `.pi/settings.json`，不会修改真实 Pi 用户设置；明确要更新用户设置时使用 `--global`。执行前可以先预览：

```bash
node install-extensions.mjs --dry-run
node install-extensions.mjs
# 明确操作用户设置
node install-extensions.mjs --global
```

脚本按自身位置确定仓库根目录，不依赖当前终端的工作目录。

## pi-lsp-feedback

只读的 LSP 诊断反馈扩展。代理成功写入或编辑文件后，它会把真实的错误和警告反馈到下一轮上下文；支持 Vue、TypeScript/JavaScript、Go、Python 和 HTML，但不会修改项目源码。

```bash
pi -e ./packages/pi-lsp-feedback
pi install ./packages/pi-lsp-feedback
```

详见 [`packages/pi-lsp-feedback/README.md`](packages/pi-lsp-feedback/README.md)。

## pi-tui-enhancements

TUI 体验增强扩展，合并快捷面板和紧凑显示：可选择技能、模型、思考等级和模型组合，也可折叠思考内容、压缩工具/用户消息、优化页脚并显示 provider 额度。

```bash
pi -e ./packages/pi-tui-enhancements
pi install ./packages/pi-tui-enhancements
```

详见 [`packages/pi-tui-enhancements/README.md`](packages/pi-tui-enhancements/README.md)。

## pi-optimization

Pi 优化工具箱，集中提供 `nul` 重定向修复、视觉 MCP 自动开关、fullscreen 滚轮优化、扩展包无感更新和会话内定时任务。

```bash
pi -e ./packages/pi-optimization
pi install ./packages/pi-optimization
```

详见 [`packages/pi-optimization/README.md`](packages/pi-optimization/README.md)。

## pi-advisor

战略顾问扩展。主模型在复杂任务的探索、纠偏或最终检查阶段，可调用更强模型获得第二意见；顾问可按需使用受限的 `read`/`bash` 诊断工具，不获得 `edit`/`write` 工具，也不注册自动状态栏提醒。可配置当前执行模型命中规则时跳过顾问调用。

```bash
pi -e ./packages/pi-advisor
pi install ./packages/pi-advisor
```

详见 [`packages/pi-advisor/README.md`](packages/pi-advisor/README.md)。

所有包对可选外部能力采用软依赖：缺少对应插件或运行时 API 时只停用受影响的逻辑，不阻断 Pi 或其他扩展启动。
