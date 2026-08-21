# pi-lean-tool-display

Pi 的紧凑显示扩展：折叠思考内容、压缩工具调用和用户消息，并在 Codex 模型下显示 5 小时窗口剩余额度。

## 使用

```bash
pi -e ./packages/pi-lean-tool-display
# 或安装到项目设置
pi install ./packages/pi-lean-tool-display
```

功能包括：

- `Ctrl+Shift+T` 或 `/thinking [toggle|show|hide]` 切换思考内容；
- 工具调用显示为紧凑标题和结果摘要，文件路径、行数、错误和 diff 保留可读信息；
- 连续工具调用自动合并显示，`write` 保持独立；
- 用户消息使用紧凑边框渲染；
- 当前模型为 `openai-codex` 时，从 Codex usage 接口读取并显示 5 小时窗口剩余额度。

额度显示依赖当前 Pi 认证信息和网络请求；请求失败只清空状态，不影响其他显示功能。

这个包通过 Pi 核心组件的 prototype patch 实现显示定制，依赖 `@earendil-works/pi-coding-agent` 和 `@earendil-works/pi-tui` 的运行时版本兼容性。

迁移完成并确认新包可用后，请停用或移走原 `~/.pi/agent/extensions/lean-tool-display`，避免旧目录与新包同时加载、重复注册命令和渲染补丁。
