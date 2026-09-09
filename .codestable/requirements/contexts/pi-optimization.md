---
scope: context:pi-optimization
code-paths:
  - packages/pi-optimization
---

# Pi 优化上下文

## 作用域

- 上下文：`pi-optimization`
- 实现包：`pi-optimization`
- 入口与证据：`packages/pi-optimization/extensions/index.ts`、`src/nul-redirect.ts`、`src/vision-mcp-auto.ts`、`src/fullscreen-scroll.ts`、`src/auto-extension-update.ts`、`src/wait.ts` 与 `README.md`

## 术语

- **优化工具箱**：集中收纳能改善 Pi 使用或运行体验、但没有必要单独成为插件的可选低干扰能力。
- **nul 重定向修复**：只把重定向操作符后的独立 `nul` 目标改写为 `/dev/null`；只处理 Pi 直接执行的 `bash`/`user_bash`，不改写 `write`/`edit` 传入的脚本文本。
- **识图 MCP 工具**：工具名匹配配置后缀、用于让不支持图片输入的模型间接识图的 MCP 工具。
- **视觉模式**：`auto` 按模型输入能力决定，`on` 强制激活，`off` 强制关闭。
- **无感扩展更新**：插件的包更新检查与 Pi 启动并行，不阻塞启动；确有更新时只更新检查结果中的扩展。
- **fullscreen 滚轮优化**：在 Pi fullscreen TUI 的滚轮处理 seam 可用时，将每次鼠标滚轮事件换算为配置的逻辑行数。
- **待发任务**：已保存在当前 Pi 进程内存中、尚未到期交给 AI 的用户内容。
- **到期派发**：到达指定时间后，才通过 `sendUserMessage` 把待发任务作为 `followUp` 送入 Pi 代理流程。
- **可选能力**：外部插件、MCP 工具、peer dependency 或运行时 API；不存在时不构成包加载错误。

## 稳定规则

- AI Bash 工具调用和手动 `!`/`!!` 命令都遵循 `PI_FIX_NUL_REDIRECT`；手动命令还受 `PI_FIX_NUL_USER_BASH` 控制。`write`/`edit` 工具写入或修改的脚本文本不经过该改写。
- 发现 Here-doc/Here-string 时只跳过脚本正文，正文之外的独立 `nul` 重定向仍改写；文件描述符复制如 `2>&1` 不改写。
- 视觉 MCP 工具没有注册、尚未注册或无法读取时不调用 active-tools API；`auto` 模式在模型尚未确定时等待，不发送临时通知。
- 无感扩展更新不增加轮询或常驻资源；发现更新后同一 Pi 进程只启动一个隐藏 runner，由 runner 顺序更新实际有变化的扩展。
- fullscreen 滚轮配置写入 `~/.pi/agent/settings.json` 的 `fullscreen-scroll` 段，默认原生 Windows 开启且每次滚动 3 行；实现不兼容时空操作，并在 `session_shutdown` 恢复。
- `/wait` 的设置时间、捕获输入、列出和取消都不调用 AI；任务只保存在当前 Pi 进程，不写 session 文件，不提前进入模型上下文。
- `/wait` 支持相对时间、本地时钟、本地日期时间和带时区 ISO 时间；斜杠命令必须用 `/wait <时间> -- <任务>` 一行保存，到期后才启用正常命令、技能和模板展开。
- session_start、reload、切换/fork/clone 会话和退出都会清除待发任务；Pi 未运行时没有后台调度能力。Pi 忙碌时到期任务等待当前工作结束；发送被同步拒绝时任务保留并在 30 秒后重试。
- 可选能力失败只能禁用所依赖的逻辑或 UI，不能让 Pi 启动失败，也不能影响同包其他功能。
