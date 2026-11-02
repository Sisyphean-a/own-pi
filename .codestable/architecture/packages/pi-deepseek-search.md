# pi-deepseek-search

## 职责与边界

- 注册 `deepseek_search`，直接调用 DeepSeek Search API，返回来源和摘要；不提供网页 Fetch 或模型调用。
- 通过 Pi 原生 provider `deepseek-search` 使用独立 `auth.json` 凭据，不复用 `deepseek` 模型凭据；用户以 `/login deepseek-search` 配置。搜索词发送给 DeepSeek，成功且有结果的请求可能计费；不自动重试。
- 未配置密钥时仅工具调用失败，不阻断 Pi 启动。取消信号传递给 HTTP 请求。
- 入口和请求实现：`packages/pi-deepseek-search/extensions/index.js`；用户配置与计费说明：`packages/pi-deepseek-search/README.md`。
