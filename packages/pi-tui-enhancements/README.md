# pi-tui-enhancements

Pi 的 TUI 体验增强扩展，把快捷面板和紧凑显示放在同一个包中，避免两个扩展同时安装时重复注册显示补丁或 provider usage。

## 安装

```bash
# 仅当前运行加载
pi -e ./packages/pi-tui-enhancements

# 安装并写入 Pi 设置
pi install ./packages/pi-tui-enhancements
```

## 快捷面板

- `Ctrl+L` 或 `/quick-panel` 打开面板；
- 集中选择技能、模型、思考等级和模型组合；
- 选择技能会在编辑器当前位置插入 `/skill:<name>`；
- 输入中的已知 `/skill:<name>` 会展开为技能正文，技能 frontmatter 不会发送给模型；
- 组合配置位于全局 `~/.pi/agent/quick-panel.json`，受信任项目可用 `.pi/quick-panel.json` 覆盖同名组合；
- 当前模型为 `openai-codex` 时显示 5 小时和周限额，当前模型为 `opencode-go` 时显示 5 小时、周和月限额及重置时间。

模型未配置认证或不支持组合指定的思考等级时，组合会显示为不可用并拒绝切换。

## 紧凑显示

- `Ctrl+Shift+T` 切换思考内容；折叠时移除 thinking 内容、标签和占位行；
- 模型回合进行时，在页脚显示动态 Thinking 标记；
- 工具调用显示为紧凑标题和结果摘要，保留路径、行数、错误和 diff；
- 连续工具调用自动合并，`edit` 和 `write` 保持独立；
- 用户消息使用紧凑边框渲染；
- 页脚自适应显示仓库/分支、统计、上下文、Thinking 标记和当前模型；
- Codex 与 OpenCode Go usage 作为可选状态显示，网络或认证失败不影响其他显示功能。

## 架构

入口只负责把两个相互独立的功能域动态装配：

- `src/panel/`：技能展开、快捷面板、组合和编辑器快捷键；
- `src/display/`：思考、用户消息、工具和 footer 显示补丁；
- `src/provider-usage.ts`：共享 Codex/OpenCode Go usage 请求、解析、格式化和 footer 轮询。

Pi 的 `@earendil-works/pi-ai`、`@earendil-works/pi-coding-agent` 和 `@earendil-works/pi-tui` 由运行时提供，作为可选 peer dependency，不会被本包重复打包。

## 迁移

本包替代原来的 `pi-quick-panel` 和 `pi-lean-tool-display`。安装确认可用后，请移除旧包，避免旧目录与新包同时加载并重复注册 `/quick-panel`、快捷键和显示补丁：

```bash
pi remove E:/path/to/packages/pi-quick-panel
pi remove E:/path/to/packages/pi-lean-tool-display
```
