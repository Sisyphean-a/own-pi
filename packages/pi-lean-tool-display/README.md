# pi-lean-tool-display

Pi 的紧凑显示扩展：隐藏折叠的思考内容、在页脚显示实时思考状态、压缩工具调用和用户消息，并在 Codex 模型下显示 5 小时窗口剩余额度。

## 使用

```bash
pi -e ./packages/pi-lean-tool-display
# 或安装到项目设置
pi install ./packages/pi-lean-tool-display
```

功能包括：

- `Ctrl+Shift+T` 切换思考内容；折叠时完全移除 thinking 内容、标签和占位行，使连续工具调用保持连贯；
- 模型回合进行时，在 footer 摘要行的统计数值与模型之间显示 `● Thinking`，尾部圆点每秒按 0～3 个循环，窄屏缩为 `●`，进入工具执行或回合结束后隐藏；
- 工具调用显示为紧凑标题和结果摘要，文件路径、行数、错误和 diff 保留可读信息；
- 连续工具调用自动合并显示，`write` 保持独立；
- 用户消息使用紧凑边框渲染；
- 页脚在空间足够时用 `|` 把仓库/分支、统计、实时思考标记和右对齐模型分组；空间不足时才拆成两行，扩展状态仍保持独立行；
- 页脚只显示仓库目录名；隐藏 cache read token 数、金额和 `(auto)`，保留输入/输出、cache write、方括号命中率与上下文，并用低饱和近似主题色区分数值类别，其中输入/输出共用 `thinkingLow`；
- 当前模型为 `openai-codex` 时，从 Codex usage 接口读取并显示 5 小时窗口剩余额度。

额度显示依赖当前 Pi 认证信息和网络请求；请求失败只清空状态，不影响其他显示功能。

这个包通过 Pi 核心组件的 prototype patch 实现显示定制，依赖 `@earendil-works/pi-coding-agent` 和 `@earendil-works/pi-tui` 的运行时版本兼容性。缺少或版本不兼容时，只跳过受影响的显示补丁或 UI；Codex usage 和其他仍可加载的功能不阻断 Pi 启动。

迁移完成并确认新包可用后，请停用或移走原 `~/.pi/agent/extensions/lean-tool-display`，避免旧目录与新包同时加载、重复注册快捷键和渲染补丁。
