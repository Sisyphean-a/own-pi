# pi-lsp-feedback

`pi-lsp-feedback` is a diagnostic-only extension for pi. After the agent writes or edits a supported file, it sends the final file contents to the matching language server and injects errors or warnings into the next agent context.

It does not format files, apply fixes, install tools, scan the project, or modify source files.

## Supported languages

| Files | Server | Root selection |
| --- | --- | --- |
| `.vue` | `vue-language-server` | nearest frontend `package.json` or lockfile |
| TypeScript and JavaScript | `typescript-language-server` | nearest `tsconfig.json`, `jsconfig.json`, or `package.json` |
| `.go` | `gopls` | nearest `go.work` or `go.mod` |
| `.py`, `.pyi` | `pyright-langserver` or `basedpyright-langserver` | nearest Python project marker |
| `.html`, `.htm` | `vscode-html-language-server` | nearest `package.json` or `.git` |

A Wails project normally uses two workspaces at once: `gopls` runs from the Go module root and Vue/TypeScript servers run from `frontend/`.

## Install

Run this package directly while developing:

```bash
pi -e ./packages/pi-lsp-feedback
```

Or add the absolute package path to pi settings with `pi install`:

```bash
pi install /absolute/path/to/pi-lsp-feedback
```

Install the server binaries before starting pi. The extension reports an unavailable server to the agent. It does not download anything.

```bash
# Wails frontend, run in frontend/
npm install --save-dev typescript typescript-language-server @vue/language-server vscode-langservers-extracted

# Go backend
go install golang.org/x/tools/gopls@latest

# Python, choose one
npm install --save-dev pyright
# or: pipx install basedpyright
```

## Feedback behavior

- A server that supports pull diagnostics produces `confirmed` results.
- A versioned `publishDiagnostics` notification also produces a confirmed result.
- A versionless publication, timeout, or silent server produces `unconfirmed`. The extension tells the agent not to treat that file as clean.
- Missing binaries and missing Go module markers produce `unavailable`.
- Unsupported file types are silently ignored.
- Confirmed clean files do not consume agent context.

Use `/lsp-feedback-status` to see the configured server IDs and active client processes.

## Project overrides

For trusted projects, `.pi/lsp-feedback.json` may override a built-in server's command, arguments, root markers, or disable it:

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

No configuration file is required for the default setup.
