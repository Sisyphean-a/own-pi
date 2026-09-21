/**
 * 一次反馈会话：拥有语言服务器客户端、诊断去重器、编辑顺序和后台收尾集合。
 *
 * Flow: Pi 的每次 write/edit 触发一次诊断检查；同步预算内完成则本轮反馈，超出预算则登记后台
 * 收尾，由同一个去重器在下一轮 turn_end 反馈。
 * Guarantee: 会话关闭时先让后台收尾落定再关客户端，迟到的检查不会新建客户端或留下孤儿进程。
 */

import { loadProjectConfiguration } from "./config.js";
import { DiagnosticService } from "./diagnostic-service.js";
import { FeedbackTracker } from "./feedback.js";

/**
 * `tool_result` 钩子在 Pi 的工具调用路径上是 await 的，因此每次写入/编辑的等待都直接落在
 * agent 循环上。这里给同步等待一个固定预算：预算内完成（健康服务器的常态）沿用原有语义，
 * 诊断在本轮 `turn_end` 上照常反馈；超出预算则交给后台任务收尾，结果在下一轮
 * `turn_end` 由同一个 FeedbackTracker 去重后反馈，不再拖住工具调用。
 */
const SYNC_CHECK_BUDGET_MS = 150;

function syncBudgetMs() {
  const raw = process.env.PI_LSP_SYNC_BUDGET_MS;
  if (raw === undefined) return SYNC_CHECK_BUDGET_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : SYNC_CHECK_BUDGET_MS;
}

/** 在预算内等待 `promise`；未完成时后台继续，`Value` 为 undefined 且 `settled` 为 false。 */
function settleWithinBudget(promise, budgetMs) {
  if (budgetMs <= 0) return Promise.resolve({ settled: false, Value: undefined });
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ settled: false, Value: undefined });
    }, budgetMs);
    promise.then(
      (Value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ settled: true, Value });
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ settled: false, Value: undefined });
      },
    );
  });
}

/** 后台收尾：同一个 outcome 形状，交给 FeedbackTracker 在下一轮按既有规则去重与稳定化。 */
async function completeCheckInBackground(check, tracker, toolCallId, editSequence) {
  try {
    const outcome = await check;
    tracker.add(toolCallId, { ...outcome, editSequence });
  } catch {
    // Failure: 客户端关闭、会话替换或检查被中止都不产生反馈，与同步路径的失败行为一致。
  }
}

/** 只有成功的 write/edit（带文件路径、非错误）才触发诊断检查。 */
export function isTrackedToolResult(event) {
  if (event?.toolName !== "write" && event?.toolName !== "edit") return false;
  if (event.isError || event.details?.isError) return false;
  return typeof event.input?.path === "string" && event.input.path.length > 0;
}

function statusLine(outcome) {
  if (outcome.status === "confirmed") {
    const errors = outcome.diagnostics.filter((diagnostic) => diagnostic.severity === 1).length;
    return errors === 0 ? "LSP: clean" : `LSP: ${errors} error${errors === 1 ? "" : "s"}`;
  }
  return `LSP: ${outcome.status}`;
}

export class FeedbackSession {
  constructor({ workspaceRoot, servers, allowManagedInstall, configurationIssue }) {
    /** 项目覆盖配置的问题；由 /lsp-feedback-status 展示。 */
    this.configurationIssue = configurationIssue;
    this.tracker = new FeedbackTracker({ workspaceRoot });
    this.service = new DiagnosticService({ workspaceRoot, servers, allowManagedInstall });
    this.editSequence = 0;
    /** 超出同步预算后在后台收尾的检查；会话关闭时必须先让它们落定再关客户端。 */
    this.backgroundChecks = new Set();
  }

  /**
   * 处理一次编辑工具结果。
   *
   * Rule: 用本实例的 service/tracker 收尾，不读取外部会话状态；会话替换后迟到的收尾只写入
   * 旧实例的 tracker，不会进入新会话。
   */
  async handleToolResult(event, ctx) {
    if (!isTrackedToolResult(event)) return;

    const editSequence = ++this.editSequence;
    const toolCallId =
      typeof event.toolCallId === "string" && event.toolCallId.length > 0
        ? event.toolCallId
        : Symbol("lsp-feedback-tool-result");

    const check = this.service.checkFile(event.input.path, ctx.signal);
    const { settled, Value: outcome } = await settleWithinBudget(check, syncBudgetMs());

    if (!settled) {
      const tracked = completeCheckInBackground(check, this.tracker, toolCallId, editSequence);
      this.backgroundChecks.add(tracked);
      void tracked.finally(() => this.backgroundChecks.delete(tracked));
      return;
    }
    if (outcome.status === "unsupported") return;

    this.tracker.add(toolCallId, { ...outcome, editSequence });
    if (ctx.hasUI) ctx.ui.setStatus("lsp-feedback", statusLine(outcome));
  }

  /** 把本轮待反馈的诊断格式化为注入内容；没有可报告内容时返回 undefined。 */
  flushTurn(event) {
    return this.tracker.flush(event);
  }

  /** 会话替换：先让旧客户端退出，令在途检查快速失败；不等待后台收尾。 */
  async release() {
    await this.service.close();
    this.tracker.clear();
    this.backgroundChecks.clear();
  }

  /**
   * 会话关闭：先清空待反馈状态，再等后台收尾落定，最后关客户端。
   * Guarantee: 迟到的检查不会在 close 之后新建客户端，也不留下孤儿语言服务器进程。
   */
  async shutdown() {
    this.tracker.clear();
    await Promise.allSettled([...this.backgroundChecks]);
    this.backgroundChecks.clear();
    await this.service.close();
  }

  snapshot() {
    return this.service.snapshot();
  }
}

/**
 * 按当前会话上下文创建反馈会话：读取项目信任状态与覆盖配置，并把配置问题提示一次。
 */
export async function createFeedbackSession(ctx) {
  const trusted = typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : false;
  const config = await loadProjectConfiguration(ctx.cwd, trusted);
  const configurationIssue = config.issues.length > 0 ? config.issues.join("\n") : undefined;
  if (configurationIssue && ctx.hasUI) {
    ctx.ui.notify(`lsp-feedback: ${configurationIssue}`, "warning");
  }
  return new FeedbackSession({
    workspaceRoot: ctx.cwd,
    servers: config.servers,
    allowManagedInstall: trusted,
    configurationIssue,
  });
}
