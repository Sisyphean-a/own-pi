import { recordDiagnosticError } from "../debug-log.js";

type UsageEvents = { emit(channel: string, data: unknown): void };
export function publishUsage(events: UsageEvents | undefined, value: unknown): void {
  try {
    if (!events || typeof events.emit !== "function" || !value || typeof value !== "object") return;
    const m = value as Record<string, unknown>;
    if (m.role !== "assistant") return;
    const u = m.usage as Record<string, unknown> | undefined;
    // Rule: 只发送最终响应计数与身份，不传正文、提示词、厂商价格或认证。
    events.emit("pi:model-usage:v1", {
      provider: m.provider, model: m.model, responseModel: m.responseModel, responseId: m.responseId,
      timestamp: m.timestamp, durationMs: m.durationMs, stopReason: m.stopReason,
      usage: u && { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, cacheWrite1h: u.cacheWrite1h, totalTokens: u.totalTokens },
    });
  } catch (error) {
    // Failure: 可选统计消费者失败只记诊断，不改变模型结果或业务流程。
    recordDiagnosticError("usage.consumer_error", error);
  }
}
