import { loadProjectConfiguration } from "../src/config.js";
import { DiagnosticService } from "../src/diagnostic-service.js";
import { FeedbackTracker } from "../src/feedback.js";

export default function lspFeedbackExtension(pi) {
  let service;
  let feedback;
  let configurationIssue;
  let editSequence = 0;

  async function startSession(ctx) {
    await service?.close();
    feedback?.clear();
    configurationIssue = undefined;
    editSequence = 0;

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
    const outcome = await service.checkFile(filePath, ctx.signal);
    if (outcome.status === "unsupported") return;
    const toolCallId =
      typeof event.toolCallId === "string" && event.toolCallId.length > 0
        ? event.toolCallId
        : Symbol("lsp-feedback-tool-result");
    feedback.add(toolCallId, { ...outcome, editSequence: currentEditSequence });
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
