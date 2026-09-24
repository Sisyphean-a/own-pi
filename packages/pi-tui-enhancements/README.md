# pi-tui-enhancements

Pi 的 TUI 体验增强扩展，把快捷面板、紧凑显示和上下文查看放在同一个包中，避免多个扩展同时安装时重复注册显示补丁、快捷键或 provider usage。

## 安装

```bash
# 仅当前运行加载
pi -e ./packages/pi-tui-enhancements

# 安装并写入 Pi 设置
pi install ./packages/pi-tui-enhancements
```

## 快捷面板

- 输入框为空时输入首字符 `/`，或使用 `Ctrl+/`，会打开命令面板；选择后把 `/命令 ` 插入当前输入框；`Ctrl+L` 或 `/quick-panel` 仍打开快捷面板；
- 集中选择技能、模型、思考等级和模型组合；
- TUI 会话启动 3 秒后，如果当前模型可用，会在后台把完全不含中文字符的命令/技能描述翻译为简体中文；请求不启用推理，只替换描述，命令名、技能名和实际插入值保持原样；
- 翻译缓存位于 `~/.pi/agent/tui-description-translations.json`：Pi 补全描述中的 `[u]`、`[t]`、`[u:npm:…]` 等来源标签不参与缓存身份，因此命令面板与 `Ctrl+L` 技能面板可复用同一译文；正文未变化时直接复用，变化后自动重译；模型输出必须符合固定 JSON 结构，格式错误最多重试三次，失败不阻塞面板或 Pi 启动，也不会在终端主动提示；
- 扩展内部后台任务和可选功能的失败记录在 `~/.pi/agent/pi-tui-enhancements/errors.ndjson`，不会直接写入 stdout/stderr；
- 选择技能会在编辑器当前位置插入 `/skill:<name>`；
- 输入中的已知 `/skill:<name>` 会展开为技能正文，技能 frontmatter 不会发送给模型；
- 组合配置位于全局 `~/.pi/agent/quick-panel.json`，受信任项目可用 `.pi/quick-panel.json` 覆盖同名组合；
- 当前模型为 `openai-codex` 时显示 5 小时和周限额，当前模型为 `opencode-go` 时显示 5 小时、周和月限额及重置时间；provider 名称匹配 `commandcode`/`cmdc` 时按 Command Code 查询官方额度，显示 5 小时、周和套餐月限额及重置时间，套餐未知时省略月限额。

模型未配置认证或不支持组合指定的思考等级时，组合会显示为不可用并拒绝切换。

## 临时技能包

不常用的技能不要放进自动发现的 `skills/`，可以按包放在它旁边：

```text
~/.pi/agent/
├── skills/                         # 常驻、自动加载
└── skill-packs/
    └── research/
        ├── browser/SKILL.md
        └── sources/SKILL.md
```

项目专用技能包放在 `<project>/.pi/skill-packs/`。在 Pi 中执行 `/skill-packs`，即可按包切换启用状态；启用一个普通包会一次加载该包内的全部技能，其他包仍不会进入提示词或 `/skill` 命令列表。

复杂路由包可以在包根放置 `skill-pack.json`，只向 Pi 暴露入口目录：

```json
{
  "skillPaths": ["skills"]
}
```

这样包内的 `skills/SKILL.md` 可以作为总控入口，其他技能文件仍保留在磁盘上，由总控技能按任务路由后再读取，不会全部进入 Pi 上下文。路径必须位于包目录内部。

选择只保存在当前会话记录中，不修改 `settings.json`：新会话默认不启用，恢复原会话时会恢复该会话的选择。关闭面板后 Pi 会自动 reload 当前会话。

## 上下文查看

- `/context` 打开带标签页的弹窗，展示当前会话的完整 LLM 上下文；
- 五个标签页：`统计` token 分布网格与分类明细、`系统` 系统提示词、`工具` 已启用工具定义、`消息` 全部会话消息、`完整` 完整上下文转储；
- `Tab` / `Shift+Tab` 切换标签页，内容页支持 `↑↓`/`j`/`k` 滚动、`/` 实时搜索、`n`/`N` 切换匹配、`y` 复制原始文本，`q` 或 `Esc` 关闭；
- token 分类按字符估算后整体缩放到 provider 上报的总量，读取技能文件的工具调用计入 `技能` 而不是 `工具`；
- 弹窗沿用快捷面板的边框与宽度计算：内容按显示宽度裁剪再补齐，中文和长行不会撑破边框，窄终端自动去掉网格和百分比列；
- 网格与色块使用普通方块字符着色，不依赖 Nerd Font 图标。

## 紧凑显示

- 默认只在模型流式生成思考时显示当前思考；开始输出正文或工具调用时立即隐藏之前的思考，消息结束后也不保留其占位行；`Ctrl+Shift+T` 可展开全部历史思考，再按一次恢复自动模式。仅隐藏界面内容，不删除会话记录；普通终端的滚动历史可能保留先前输出，需要完全从屏幕移除时建议使用 fullscreen 模式；
- 模型回合进行时，在页脚显示动态 Thinking 标记；
- 工具调用显示为紧凑标题和结果摘要，保留路径、行数、错误和 diff；
- 连续工具调用自动合并，`edit` 和 `write` 保持独立；
- 用户消息使用紧凑边框渲染；
- 页脚自适应显示仓库/分支、统计、上下文、Thinking 标记和当前模型；
- Codex 与 OpenCode Go usage 作为可选状态显示，网络或认证失败不影响其他显示功能。

## 架构

入口只负责把三个相互独立的功能域动态装配：

- `src/panel/`：技能展开、快捷面板、组合、编辑器快捷键，以及命令/技能描述的后台翻译与用户级缓存；
- `src/display/`：思考、用户消息、工具和 footer 显示补丁；
- `src/context/`：`/context` 上下文查看弹窗、标签页、滚动/搜索和 token 分类；
- `src/provider-usage.ts`：共享 Codex/OpenCode Go usage 请求、解析、格式化和 footer 轮询；
- `src/extension-log.ts`：后台任务和软依赖失败的用户级 NDJSON 日志，禁止直接写终端。

Pi 的 `@earendil-works/pi-ai`、`@earendil-works/pi-coding-agent` 和 `@earendil-works/pi-tui` 由运行时提供，作为可选 peer dependency，不会被本包重复打包。

## 迁移

本包替代原来的 `pi-quick-panel`、`pi-lean-tool-display` 和 npm 上的 `pi-context-inspector`。安装确认可用后，请移除旧包，避免旧目录与新包同时加载并重复注册 `/quick-panel`、`/context`、快捷键和显示补丁：

```bash
pi remove E:/path/to/packages/pi-quick-panel
pi remove E:/path/to/packages/pi-lean-tool-display
pi remove npm:pi-context-inspector
```

上下文查看的弹窗结构源自 MIT 许可的 `pi-context-inspector`（其本身是 `@agnishc/edb-context-viewer` 的 fork），本包在其基础上改为中文界面、宽度安全排版并移除了 Nerd Font 图标依赖。
