# own-pi

本仓库维护六个可独立安装的 Pi 扩展包。停止开发的包归档在 `old-packages/`，不参与自动安装。下面的命令都在仓库根目录运行。

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

TUI 体验增强扩展，合并快捷面板、紧凑显示和上下文查看：可选择技能、模型、思考等级和模型组合，也可折叠思考内容、压缩工具/用户消息、优化页脚并显示 provider 额度，或用 `/context` 查看完整 LLM 上下文。

```bash
pi -e ./packages/pi-tui-enhancements
pi install ./packages/pi-tui-enhancements
```

详见 [`packages/pi-tui-enhancements/README.md`](packages/pi-tui-enhancements/README.md)。

## pi-optimization

Pi 优化工具箱，集中提供 `nul` 重定向修复、fullscreen 交互优化、扩展包无感更新和会话内定时任务。

```bash
pi -e ./packages/pi-optimization
pi install ./packages/pi-optimization
```

详见 [`packages/pi-optimization/README.md`](packages/pi-optimization/README.md)。

## pi-observational-memory

观察式记忆扩展：后台提取 observations/reflections，维护记忆池，并在压缩时快速恢复上下文；支持 `recall` 追溯原始证据。

```bash
pi -e ./packages/pi-observational-memory
pi install ./packages/pi-observational-memory
```

详见 [`packages/pi-observational-memory/README.md`](packages/pi-observational-memory/README.md)。

## pi-token-stats

按模型记录 Token、缓存、官方价估算与请求时间。使用 `/token` 查看今日/本月/累计，`/token html` 生成离线快照；采集有界异步写入，不加载全历史或启动服务器。

```bash
pi -e ./packages/pi-token-stats
pi install ./packages/pi-token-stats
```

详见 [`packages/pi-token-stats/README.md`](packages/pi-token-stats/README.md)。

## pi-deepseek-search

通过 DeepSeek API 搜索网页，返回来源和摘要；通过 Pi 原生登录管理独立搜索密钥。

```bash
pi -e ./packages/pi-deepseek-search
pi install ./packages/pi-deepseek-search
```

详见 [`packages/pi-deepseek-search/README.md`](packages/pi-deepseek-search/README.md)。

所有包对可选外部能力采用软依赖：缺少对应插件或运行时 API 时只停用受影响的逻辑，不阻断 Pi 或其他扩展启动。
