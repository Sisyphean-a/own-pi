# 可选扩展依赖

## 契约

所有 Pi 扩展对外部插件、可选 peer dependency、运行时版本能力和可选包内功能都按软依赖处理：

- 入口不得让可选模块的静态导入失败阻断整个包；可选模块按功能独立加载并捕获 import/factory 错误。
- 事件、命令和 UI 使用前检查能力；外部插件缺失、晚注册、API 不存在或版本不兼容时，只跳过依赖该能力的逻辑。
- 可选功能失败不能向 Pi 加载器抛出未处理异常；同一包中其他功能和其他包继续加载。
- 只有能力存在且调用成功时才修改工具集合、注册对应 UI 或执行外部副作用。

## 代码锚点

- `packages/pi-optimization/extensions/index.ts`：两个优化功能独立激活。
- `packages/pi-optimization/src/nul-redirect.ts`：手动 Bash 后端动态加载，缺失时保留 Pi 原始执行路径。
- `packages/pi-optimization/src/vision-mcp-auto.ts`：识图 MCP 工具缺失时保持可重试的空操作。
- `packages/pi-quick-panel/extensions/index.ts`：面板 peer 缺失时隐藏面板，技能展开单独降级。
- `packages/pi-lean-tool-display/extensions/index.ts`：显示补丁、工具显示和 Codex usage 分别降级。
