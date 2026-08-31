# pi-wait

## 职责

`pi-wait` 是独立的 Pi 定时消息扩展：它将用户把消息交给 Pi 与 AI 实际执行的时间解耦，先把任务保存在当前 Pi 进程内存中，到期后才作为正常用户消息交给 AI；用户当前是否有模型额度不影响 Pi 接收和暂存消息。

## 公开边界

- 包入口：`package.json` 中 `pi.extensions` 声明的 `extensions/index.ts`。
- 用户命令：`/wait <时间>` 捕获下一条普通输入，`/wait <时间> -- <任务>` 直接保存任务，`/wait list` 和 `/wait cancel` 管理待发任务。Pi 先于 input 事件分发斜杠命令，因此定时斜杠命令必须使用 `--` 一行形式。
- 状态：待发任务只存在进程内存，不写入 Pi session 文件，也不进入模型上下文。
- 发送：仅在到期后调用 `sendUserMessage`，统一作为 `followUp` 交给 Pi，并在到期时启用命令、技能和模板展开。

## 架构规则

- 设置时间和捕获任务只操作插件状态，不调用模型，也不提前创建参与模型上下文的消息。
- 每个活动 Pi 会话实例独立拥有自己的待发任务；session_start 会清空旧内存，session_shutdown 会清理定时器和任务，避免跨会话派发。
- 插件不创建常驻后台进程，不写 session 文件；Pi 完全退出或扩展重载期间不执行、也不恢复任务。
- 派发只在到期后调用 `sendUserMessage`；同步拒绝时任务留在内存并在 30 秒后重试。UI 通知和状态栏故障不改变调度决定。
- 包入口动态加载实现并捕获失败，遵循[可选扩展依赖契约](../shared/optional-extension-dependencies.md)。

## 代码锚点

- 软失败入口：`packages/pi-wait/extensions/index.ts`
- 时间解析、会话状态与派发：`packages/pi-wait/src/wait.ts`
- 用户说明：`packages/pi-wait/README.md`
- 回归测试：`packages/pi-wait/test/`
