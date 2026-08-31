# Pi 优化上下文

## 作用域

- 上下文：`pi-optimization`
- 实现包：`pi-optimization`
- 入口与证据：`packages/pi-optimization/extensions/index.ts`、`src/nul-redirect.ts`、`src/vision-mcp-auto.ts`、`src/auto-extension-update.ts` 与 `README.md`

## 术语

- **优化工具箱**：集中收纳能改善 Pi 使用或运行体验、但没有必要单独成为插件的可选低干扰能力。
- **nul 重定向修复**：只把重定向操作符后的独立 `nul` 目标改写为 `/dev/null`；普通字符串、注释、命令替换和 Here-doc 不改写。
- **识图 MCP 工具**：工具名匹配配置后缀、用于让不支持图片输入的模型间接识图的 MCP 工具。
- **视觉模式**：`auto` 按模型输入能力决定，`on` 强制激活，`off` 强制关闭。
- **无感扩展更新**：插件的包更新检查与 Pi 启动并行，不阻塞启动；一次性闸门只隐藏 bundle 内置包更新守卫，确有更新时只更新检查结果中的扩展，不更新没有变化的扩展。
- **可选能力**：外部插件、MCP 工具、peer dependency 或运行时 API；不存在时不构成包加载错误。

## 稳定规则

- AI Bash 工具调用和手动 `!`/`!!` 命令都遵循 `PI_FIX_NUL_REDIRECT`；手动命令还受 `PI_FIX_NUL_USER_BASH` 控制。
- 发现未加引号的 Here-doc/Here-string 时整条命令保持不变；文件描述符复制如 `2>&1` 不改写。
- 视觉 MCP 工具没有注册、尚未注册或无法读取时不调用 active-tools API；后续 `before_agent_start` 仍可重试。
- `auto` 模式在模型尚未确定时不把未知状态当作“不支持图片”，不调用 active-tools API，也不发送临时通知；模型确定后只在工具集合实际变化时提示一次。状态变化只发送一条 UI 通知，不向 stdout 重复写相同内容。
- 视觉模式变更写入 `~/.pi/agent/settings.json` 的 `vision-mcp-auto` 段；配置损坏时回到 `auto` 和默认工具后缀。
- 无感扩展更新不增加轮询或常驻资源；启动闸门只匹配 Pi 内置 `checkForPackageUpdates` 调用栈，插件自身检查不消耗闸门，命中目标或 `session_shutdown` 时恢复。检查发现更新后，同一 Pi 进程只启动一个隐藏、脱离引用的 runner，由 runner 顺序更新实际有变化的扩展；所有子进程结束后自然释放。
- 可选能力失败只能禁用所依赖的逻辑或 UI，不能让 Pi 启动失败，也不能影响同包其他功能。
