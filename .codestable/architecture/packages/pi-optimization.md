# pi-optimization

## 职责

`pi-optimization` 是一个私有 Pi 优化工具箱：收纳那些确实能改善 Pi 使用或运行体验、但没有必要单独成为插件的可选低干扰能力；后续同类能力按这一边界继续归入本包。当前集中分发 Windows Bash `nul` 重定向修复、视觉 MCP 自动开关、fullscreen 滚轮优化、扩展包无感更新和会话内定时消息五项彼此独立的能力。

## 公开边界

- 包入口：`package.json` 中 `pi.extensions` 声明的 `extensions/index.ts`。
- 用户命令：`/nulfix`、`/vision-mcp`、`/fullscreen-scroll` 和 `/wait`。
- 全局配置：视觉功能读取 `vision-mcp-auto` 段；滚轮功能读取 `fullscreen-scroll` 段；定时消息不持久化配置或任务。
- 外部能力：Pi 的 Bash 后端、识图 MCP 工具、fullscreen TUI 运行时 seam、`DefaultPackageManager` 更新检查和 Pi 消息发送接口都是可选运行时能力，不由包强制安装。

## 架构规则

- `extensions/index.ts` 只负责五个功能的独立动态加载；一个功能失败不能阻止其他功能注册。
- `src/nul-redirect.ts` 拥有 Shell 重定向词法扫描、保守 Here-doc 边界、统计和 `/nulfix` 命令；AI `tool_call` 直接修改输入，手动 `user_bash` 只在可取得 Pi 原生 Bash backend 时接管执行。
- `src/vision-mcp-auto.ts` 拥有配置读写、模型视觉能力判断、工具发现和 active tools 同步；没有识图 MCP 工具时不修改 Pi 工具集合，并等待后续生命周期事件重试。
- `src/fullscreen-scroll.ts` 通过 `ctx.ui.setWidget()` 取得 Pi 的稳定 TUI 代理，在检测到 fullscreen TUI 的 `routeWheel` 与 `wheelScrollLines` seam 后临时提高滚轮行数；会话关闭时恢复原方法。
- `src/auto-extension-update.ts` 使用与 Pi 相同的更新检查；发现更新时只启动一个隐藏 runner，按检查结果逐个执行 `pi update --extension <source>`，不阻塞 Pi 启动。
- `src/wait.ts` 拥有时间解析、当前进程内存中的任务状态、捕获输入、到期派发、取消和会话清理；设置时间与捕获任务不调用 AI，只有到期后才通过 `sendUserMessage` 作为 `followUp` 进入 Pi。
- 可选依赖遵循[可选扩展依赖契约](../shared/optional-extension-dependencies.md)：缺失、晚注册或 API 不兼容只能让对应逻辑空操作或隐藏 UI。

## 代码锚点

- 入口：`packages/pi-optimization/extensions/index.ts`
- `nul` 重写与执行后端边界：`packages/pi-optimization/src/nul-redirect.ts`
- 视觉 MCP 同步与配置：`packages/pi-optimization/src/vision-mcp-auto.ts`
- fullscreen 滚轮适配与配置：`packages/pi-optimization/src/fullscreen-scroll.ts`
- 扩展包无感更新：`packages/pi-optimization/src/auto-extension-update.ts`
- 会话内定时消息：`packages/pi-optimization/src/wait.ts`
- 回归测试：`packages/pi-optimization/test/`
