# pi-deepseek-search

为 Pi 提供 `deepseek_search` 工具，调用 DeepSeek 的网页搜索 API，返回标题、链接、摘要、站点和日期。搜索内容会发送给 DeepSeek；搜索结果是外部不可信内容。

## 安装与密钥

在仓库根目录临时加载：

```bash
pi -e ./packages/pi-deepseek-search
```

持久安装：`pi install ./packages/pi-deepseek-search`。本地路径包需保留在原位置。仓库的 `node install-extensions.mjs --dry-run` 可预览批量安装。

从 [DeepSeek 开放平台](https://platform.deepseek.com/) 创建 API Key。启动加载了本扩展的 Pi 后，执行：

```text
/login deepseek-search
```

在 Pi 的登录界面输入搜索专用 Key。Pi 将其保存在用户目录 `~/.pi/agent/auth.json` 的 `deepseek-search` 条目中；若配置了 `PI_CODING_AGENT_DIR`，则位于该目录的 `auth.json`。搜索凭据与 `deepseek` 模型凭据相互独立，不自动复用。更换 Key 时重新运行上述命令；删除时使用 `/logout` 并选择 DeepSeek Search。

**隐私提示：**当前 Pi 1.4 的登录界面可能明文显示输入，请避开屏幕共享和录屏。`auth.json` 是明文凭据文件，应保持私有；不要将 Key 发到聊天或提交到 Git。泄露后在平台撤销并重新创建。

## 使用

直接告诉 Pi，例如：“使用 DeepSeek 搜索最近的 TypeScript 发布说明并附来源链接”。模型按需调用 `deepseek_search`，`query` 必填（1–128 个 Unicode 字符），`count` 可选（1–50，默认 5），`ori_question` 可选（1–128 字符）。查询支持 `site:`、`lang:`、`after:`、`before:` 等官方搜索语法。本扩展不提供单页 Fetch 接口或网页正文。

按[官方文档](https://api-docs.deepseek.com/zh-cn/guides/search/)当前价格，Search 每 1000 次成功且有结果的请求 5 元；失败或无结果不收费，价格以官方实时公告为准。扩展不自动重试；401 检查密钥，402 检查余额，429 检查限速。登录后即可使用；插件不读取 `DEEPSEEK_SEARCH_API_KEY`。
