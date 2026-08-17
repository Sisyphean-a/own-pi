import path from "node:path";
import { loadProjectOverrides } from "../src/config.js";
import { DiagnosticService } from "../src/diagnostic-service.js";

const REPORTABLE_SEVERITY = 2;
const MAX_DIAGNOSTICS = 20;

export default function lspFeedbackExtension(pi) {
  let service;
  let configurationIssue;
  const pending = new Map();
  const reportedUnavailability = new Set();

  async function startSession(ctx) {
    await service?.close();
    pending.clear();
    reportedUnavailability.clear();
    configurationIssue = undefined;

    let overrides = {};
    try {
      const trusted = typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : false;
      overrides = await loadProjectOverrides(ctx.cwd, trusted);
    } catch (error) {
      configurationIssue = error instanceof Error ? error.message : String(error);
      if (ctx.hasUI) ctx.ui.notify(`lsp-feedback: ${configurationIssue}`, "warning");
    }
    service = new DiagnosticService({ workspaceRoot: ctx.cwd, overrides });
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

    const outcome = await service.checkFile(filePath, ctx.signal);
    if (outcome.status === "unsupported") return;
    pending.set(outcome.filePath, outcome);
    if (ctx.hasUI) ctx.ui.setStatus("lsp-feedback", statusLine(outcome));
  });

  pi.on("turn_end", () => {
    const content = formatFeedback([...pending.values()]);
    pending.clear();
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
    pending.clear();
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

  function formatFeedback(outcomes) {
    const lines = [];
    const diagnostics = outcomes
      .flatMap((outcome) =>
        outcome.diagnostics
          .filter((diagnostic) => diagnostic.severity <= REPORTABLE_SEVERITY)
          .map((diagnostic) => ({ outcome, diagnostic })),
      )
      .slice(0, MAX_DIAGNOSTICS);

    if (diagnostics.length > 0) {
      lines.push("LSP diagnostics after the latest edits:");
      for (const { outcome, diagnostic } of diagnostics) {
        const location = diagnostic.range?.start;
        const line = location ? location.line + 1 : 1;
        const column = location ? location.character + 1 : 1;
        const level = diagnostic.severity === 1 ? "error" : "warning";
        const code = diagnostic.code === undefined ? "" : ` ${String(diagnostic.code)}`;
        lines.push(`- ${relative(outcome.filePath)}:${line}:${column} ${level}${code} [${outcome.serverId}]: ${diagnostic.message}`);
      }
    }

    for (const outcome of outcomes) {
      if (outcome.status === "confirmed" || outcome.status === "cancelled") continue;
      const key = `${outcome.serverId ?? "unsupported"}:${outcome.reason ?? outcome.status}`;
      if (reportedUnavailability.has(key)) continue;
      reportedUnavailability.add(key);
      if (outcome.status === "unconfirmed") {
        lines.push(`- ${relative(outcome.filePath)}: ${outcome.serverId} did not confirm a fresh diagnostic result. Do not treat this file as clean.`);
      } else {
        lines.push(`- ${relative(outcome.filePath)}: ${outcome.serverId ?? "LSP"} unavailable${outcome.reason ? ` (${outcome.reason})` : ""}.`);
      }
    }

    return lines.length === 0 ? undefined : lines.join("\n");
  }

  function relative(filePath) {
    return path.relative(service?.workspaceRoot ?? process.cwd(), filePath) || path.basename(filePath);
  }
}

function statusLine(outcome) {
  if (outcome.status === "confirmed") {
    const errors = outcome.diagnostics.filter((diagnostic) => diagnostic.severity === 1).length;
    return errors === 0 ? "LSP: clean" : `LSP: ${errors} error${errors === 1 ? "" : "s"}`;
  }
  return `LSP: ${outcome.status}`;
}
