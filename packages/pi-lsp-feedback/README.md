# pi-lsp-feedback

`pi-lsp-feedback` 是 Pi 的只读诊断扩展。代理成功写入或编辑受支持文件后，扩展把最终内容交给匹配的语言服务器，并将错误或警告注入下一次代理上下文。

安装扩展一次即可在任意项目使用。项目不需要再安装 TypeScript、Vue、HTML 或 Python 语言服务器。扩展不格式化文件、不应用修复、不扫描项目，也不修改项目源码。

## 支持语言

| 文件 | 服务器 | 分发与启动方式 | 根目录选择 |
| --- | --- | --- | --- |
| `.vue` | `vue-language-server` | 包内携带 | 最近的前端 `package.json` 或锁文件 |
| TypeScript 和 JavaScript | `typescript-language-server` | 包内携带 | 最近的 `tsconfig.json`、`jsconfig.json` 或 `package.json` |
| `.go` | `gopls` | 在可信项目首次需要时由扩展自动安装 | 最近的 `go.work` 或 `go.mod` |
| `.py`、`.pyi` | `pyright-langserver` | 包内携带 | 最近的 Python 项目标记 |
| `.html`、`.htm` | `vscode-html-language-server` | 包内携带 | 最近的 `package.json` 或 `.git` |

Vue 在项目没有本地 TypeScript 时会使用扩展自带的 TypeScript SDK。Go 的自动安装不写入项目目录，但要求系统已安装并可执行 `go`；下载或安装失败会明确报告为不可用。非受信任项目不会触发 Go 安装。

## 安装

开发时直接加载本地包：

```bash
pi -e ./packages/pi-lsp-feedback
```

或安装包路径：

```bash
pi install /absolute/path/to/pi-lsp-feedback
```

发布的包会携带 Node 语言服务器依赖。实际项目无需额外执行 `npm install`、`pipx install` 或 `go install`。

## 反馈行为

- 支持拉取诊断的服务器会产生 `confirmed` 结果。
- 带当前文档版本的 `publishDiagnostics` 通知也会产生 `confirmed` 结果。
- 不带版本的诊断发布、超时或静默服务器会产生 `unconfirmed` 结果。扩展会提示代理不能将该文件视为干净。
- 缺少 Go 运行时、安装失败或缺少 Go 模块标记时会产生 `unavailable` 结果。
- 不受支持的文件类型会被静默忽略。
- 已确认且无诊断的文件不会消耗代理上下文。

使用 `/lsp-feedback-status` 查看已配置服务器和已启动的客户端。

## 项目覆盖

对于受信任项目，`.pi/lsp-feedback.json` 可以替换内置命令、参数、根目录标记，或禁用某个服务器。显式命令覆盖不会使用包内命令：

```json
{
  "servers": {
    "python": {
      "command": "basedpyright-langserver",
      "args": ["--stdio"]
    },
    "html": { "enabled": false }
  }
}
```

默认配置不需要项目文件。
