# pi-quick-panel

Pi 的交互式快捷面板扩展，集中管理技能、模型、思考等级和模型组合，并在 Codex 或 OpenCode Go 模型下显示订阅限额。

## 使用

```bash
pi -e ./packages/pi-quick-panel
# 或安装到项目设置
pi install ./packages/pi-quick-panel
```

在 TUI 中：

- `Ctrl+L` 打开面板；
- `/quick-panel` 打开面板；
- 选择技能会在编辑器当前位置插入 `/skill:<name>`；
- 输入中的 `/skill:<name>` 会展开为技能正文，技能 frontmatter 不会发送给模型；
- 当前模型为 `openai-codex` 时显示 5 小时和周限额，当前模型为 `opencode-go` 时显示 5 小时、周和月限额及重置时间。

快捷面板仅在 TUI 中显示；技能指令展开仍由 `input` 事件处理。

迁移完成并确认新包可用后，请停用或移走原 `~/.pi/agent/extensions/quick-panel`，避免旧目录与新包同时加载、重复注册同一命令和输入处理器。

## 组合配置

全局配置位于 `~/.pi/agent/quick-panel.json`，受信任项目还可以在 `.pi/quick-panel.json` 中覆盖同名组合：

```json
{
  "balanced": {
    "provider": "openai-codex",
    "model": "gpt-5.4",
    "thinkingLevel": "medium"
  }
}
```

也可以使用 `modelId` 代替 `model`。项目配置优先于全局配置；模型未配置认证或不支持指定思考等级时，组合会显示为不可用并拒绝切换。

Pi 的 `@earendil-works/pi-ai`、`@earendil-works/pi-coding-agent` 和 `@earendil-works/pi-tui` 作为运行时提供的 peer dependency，不会被这个包重复打包。缺少或版本不兼容时，快捷面板和对应 UI 会被安全跳过，Pi 及同一包中仍可用的技能展开逻辑不会因此启动失败。
