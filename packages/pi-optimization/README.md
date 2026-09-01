# pi 优化插件

把几个低干扰优化集中为一个可安装的 Pi 包：

- `fix-nul-redirect`：把 Bash 重定向目标中的 Windows `nul` 安全改写为 `/dev/null`；
- `vision-mcp-auto`：按当前模型是否支持图片，自动开关识图 MCP 工具；
- `fullscreen-scroll`：在 Windows fullscreen TUI 中提高鼠标滚轮的每次滚动行数；
- `auto-extension-update`：Pi 检查到扩展包更新时，不显示更新提示，只在不可见的独立进程中更新实际有变化的扩展。

## 安装

在仓库根目录运行：

```bash
# 仅当前运行加载
pi -e ./packages/pi-optimization

# 安装并写入 Pi 设置
pi install ./packages/pi-optimization
```

安装并确认新包可用后，请停用或移走原来的：

- `~/.pi/agent/extensions/fix-nul-redirect.ts`
- `~/.pi/agent/extensions/vision-mcp-auto.ts`

否则同一命令或事件可能被重复注册。

## 命令

- `/nulfix [on|off|manual-on|manual-off|preview <bash command>]`
- `/vision-mcp [auto|on|off]`
- `/fullscreen-scroll [on|off|<每次滚动行数>]`

`nul` 修复还支持环境变量：`PI_FIX_NUL_REDIRECT=0` 关闭总开关，`PI_FIX_NUL_USER_BASH=0` 不接管手动 `!`/`!!` 命令，`PI_FIX_NUL_NOTIFY=1` 在首次修复时提示。

`vision-mcp-auto` 不内置或强依赖识图 MCP；没有对应 MCP 工具时只跳过同步逻辑，其他功能仍可用。

`fullscreen-scroll` 默认只在原生 Windows 上启用，每次滚轮默认滚动 3 行，适配 ConPTY 下 fullscreen TUI 将一次滚轮事件按一行处理的问题。配置写入 `~/.pi/agent/settings.json`：

```json
{
  "fullscreen-scroll": {
    "enabled": true,
    "wheelScrollLines": 3
  }
}
```

也可以在 Pi 内执行 `/fullscreen-scroll 5` 立即改为每次 5 行，或用 `/fullscreen-scroll off` 关闭。Pi 运行时没有公开该参数时，此功能自动跳过，不影响其他功能。

Pi 0.84.4+ 的 fullscreen 选中复制是 Pi 自带设置，不属于本插件配置。若不希望“选中即复制”，在全局 `~/.pi/agent/settings.json` 设置 `"fullscreenCopyOnSelect": false`；关闭后仍可用 `Ctrl+X` 复制当前选区，终端自己的右键复制行为不受影响。

`auto-extension-update` 使用与 Pi 相同的更新检查，不增加轮询或常驻定时器。启动时只安装一个识别 Pi 内置包更新守卫的一次性闸门；插件自己的检查可以并行进行，不阻塞 Pi 启动，同时保留模型和 Pi 版本检查。只有确实发现更新时才启动一次后台 runner，并按检查结果逐个执行 `pi update --extension <source>`，不会把没有变化的扩展一起重装。runner 和更新子进程都不使用 shell、隐藏窗口、忽略标准流，完成后自然退出。

## 可选依赖降级

这个包的外部能力都按可选依赖处理：入口分别加载四个功能，缺少 Pi API、识图 MCP、fullscreen TUI 运行时 seam、包管理器或版本不兼容时，只停用受影响的逻辑，不让异常冒出到 Pi 加载器。没有 UI 时不发送通知；已有工具和其他扩展继续运行。

视觉配置仍兼容 `~/.pi/agent/settings.json` 中的 `"vision-mcp-auto"` 段：

```json
{
  "vision-mcp-auto": {
    "mode": "auto",
    "toolPatterns": ["analyze_image"]
  }
}
```
