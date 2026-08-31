# pi-optimization

## 职责

`pi-optimization` 是一个私有 Pi 优化工具箱：收纳那些确实能改善 Pi 使用或运行体验、但没有必要单独成为插件的可选低干扰能力；后续同类能力按这一边界继续归入本包。当前把 Windows Bash `nul` 重定向修复、视觉 MCP 自动开关和扩展包无感更新集中分发，三个功能彼此独立。

## 公开边界

- 包入口：`package.json` 中 `pi.extensions` 声明的 `extensions/index.ts`。
- 用户命令：`/nulfix` 管理 `nul` 重定向修复；`/vision-mcp` 查看或切换识图 MCP 模式。
- 全局配置：视觉功能继续读取 `~/.pi/agent/settings.json` 的 `vision-mcp-auto` 段。
- 外部能力：Pi 的 Bash 后端、识图 MCP 工具和 `DefaultPackageManager` 更新检查都是可选运行时能力，不由包强制安装。

## 架构规则

- `extensions/index.ts` 只负责三个功能的独立动态加载；一个功能失败不能阻止其他功能注册。
- `src/nul-redirect.ts` 拥有 Shell 重定向词法扫描、保守 Here-doc 边界、统计和 `/nulfix` 命令；AI `tool_call` 直接修改输入，手动 `user_bash` 只在可取得 Pi 原生 Bash backend 时接管执行。
- `src/vision-mcp-auto.ts` 拥有配置读写、模型视觉能力判断、工具发现和 active tools 同步；没有识图 MCP 工具时不修改 Pi 工具集合，并等待后续生命周期事件重试。`auto` 模式在模型尚未确定时也只等待、不改工具和不通知，避免启动临时状态与最终状态重复提示；状态变化只通过 UI 通知展示，不再同步写相同 stdout 日志。
- `src/auto-extension-update.ts` 使用与 Pi 相同的 `DefaultPackageManager` 检查包更新；启动时安装只匹配 Pi `checkForPackageUpdates` 调用栈的一次性 `PI_OFFLINE` 闸门，插件自己的多次检查读取仍看到原始环境，因此不阻塞 Pi 启动。发现更新时只启动一个隐藏 runner，按结果逐个执行 `pi update --extension <source>`，避免 `--extensions` 把没有变化的扩展一起更新；闸门在目标读取后或 `session_shutdown` 清理，runner 和更新子进程不使用 shell、窗口或标准流，并在完成后自然退出。
- 可选依赖遵循[可选扩展依赖契约](../shared/optional-extension-dependencies.md)：缺失、晚注册或 API 不兼容只能让对应逻辑空操作或隐藏 UI。

## 代码锚点

- 独立入口：`packages/pi-optimization/extensions/index.ts`
- `nul` 重写与执行后端边界：`packages/pi-optimization/src/nul-redirect.ts`
- 视觉 MCP 同步与配置：`packages/pi-optimization/src/vision-mcp-auto.ts`
- 扩展包无感更新：`packages/pi-optimization/src/auto-extension-update.ts`
- 回归测试：`packages/pi-optimization/test/`
