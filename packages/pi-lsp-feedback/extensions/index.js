import { loadProjectConfiguration } from "../src/config.js";
import { DiagnosticService } from "../src/diagnostic-service.js";
import { FeedbackTracker } from "../src/feedback.js";

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
export function settleWithinBudget(promise, budgetMs) {
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
    if (tracker) tracker.add(toolCallId, { ...outcome, editSequence });
  } catch {
    // Failure: 客户端关闭、会话替换或检查被中止都不产生反馈，与同步路径的失败行为一致。
  }
}

export default function lspFeedbackExtension(pi) {
  let service;
  let feedback;
  let configurationIssue;
  let editSequence = 0;
  /** 超出同步预算后在后台收尾的检查；会话关闭时必须先让它们落定再关客户端。 */
  const backgroundChecks = new Set();

  async function startSession(ctx) {
    await service?.close();
    feedback?.clear();
    configurationIssue = undefined;
    editSequence = 0;
    backgroundChecks.clear();

    const trusted = typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : false;
    const config = await loadProjectConfiguration(ctx.cwd, trusted);
    configurationIssue = config.issues.length > 0 ? config.issues.join("\n") : undefined;
    if (configurationIssue && ctx.hasUI) {
      ctx.ui.notify(`lsp-feedback: ${configurationIssue}`, "warning");
    }
    service = new DiagnosticService({
      workspaceRoot: ctx.cwd,
      servers: config.servers,
      allowManagedInstall: trusted,
    });
    feedback = new FeedbackTracker({ workspaceRoot: service.workspaceRoot });
  }

  pi.on("session_start", async (_event, ctx) => {
    await startSession(ctx);
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "write" && event.toolName !== "edit") return;
    if (event.isError || event.details?.isError) return;
    const filePath = event.input?.path;
    if (typeof filePath !== "string" || filePath.length === 0) return;
    if (!service) await startSession(ctx);

    const currentEditSequence = ++editSequence;
    const toolCallId =
      typeof event.toolCallId === "string" && event.toolCallId.length > 0
        ? event.toolCallId
        : Symbol("lsp-feedback-tool-result");

    // Rule: 捕获当前 service/tracker 实例，会话替换或重载后仍用启动时的实例收尾，
    // 不读取被替换的模块级变量。
    const activeService = service;
    const activeFeedback = feedback;
    const check = activeService.checkFile(filePath, ctx.signal);
    const { settled, Value: outcome } = await settleWithinBudget(check, syncBudgetMs());

    if (!settled) {
      // Guarantee: 后台收尾登记在案，会话关闭时先等它落定再关客户端，避免留下孤儿语言服务器进程。
      const tracked = completeCheckInBackground(check, activeFeedback, toolCallId, currentEditSequence);
      backgroundChecks.add(tracked);
      void tracked.finally(() => backgroundChecks.delete(tracked));
      return;
    }
    if (outcome.status === "unsupported") return;

    activeFeedback.add(toolCallId, { ...outcome, editSequence: currentEditSequence });
    if (ctx.hasUI) ctx.ui.setStatus("lsp-feedback", statusLine(outcome));
  });

  pi.on("turn_end", (event) => {
    const content = feedback?.flush(event);
    if (!content) return;
    pi.sendMessage(
      {
        customType: "lsp-feedback",
        content,
        display: true,
      },
      { deliverAs: "steer", triggerTurn: true },
    );
  });

  pi.on("session_shutdown", async () => {
    feedback?.clear();
    feedback = undefined;
    editSequence = 0;
    // Guarantee: 先让后台收尾的检查落定，再关客户端；否则迟到的检查可能在 close 之后新建客户端。
    await Promise.allSettled([...backgroundChecks]);
    backgroundChecks.clear();
    await service?.close();
    service = undefined;
  });

  pi.registerCommand("lsp-feedback-status", {
    description: "Show lsp-feedback server and diagnostic status.",
    handler: async (_args, ctx) => {
      const snapshot = service?.snapshot();
      const lines = [
        `workspace: ${snapshot?.workspaceRoot ?? ctx.cwd}`,
        `configured servers: ${snapshot?.configuredServers.join(", ") ?? "none"}`,
        `live clients: ${snapshot?.liveClients.join(", ") || "none"}`,
      ];
      if (configurationIssue) lines.push(`configuration: ${configurationIssue}`);
      ctx.ui.notify(lines.join("\n"), configurationIssue ? "warning" : "info");
    },
  });

}

function statusLine(outcome) {
  if (outcome.status === "confirmed") {
    const errors = outcome.diagnostics.filter((diagnostic) => diagnostic.severity === 1).length;
    return errors === 0 ? "LSP: clean" : `LSP: ${errors} error${errors === 1 ? "" : "s"}`;
  }
  return `LSP: ${outcome.status}`;
}
