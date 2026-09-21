import { createFeedbackSession, isTrackedToolResult } from "../src/feedback-session.js";

/**
 * pi-lsp-feedback 包入口：只把 Pi 生命周期事件接到当前反馈会话上。
 *
 * Rule: 会话状态（语言服务器客户端、去重器、编辑顺序、后台收尾）由 FeedbackSession 拥有；
 * 入口只负责事件顺序、把可报告内容作为 steer 消息发回，以及状态命令的展示。
 */
export default function lspFeedbackExtension(pi) {
  let session;

  const startSession = async (ctx) => {
    await session?.release();
    session = await createFeedbackSession(ctx);
  };

  pi.on("session_start", async (_event, ctx) => {
    await startSession(ctx);
  });

  pi.on("tool_result", async (event, ctx) => {
    // Rule: 只有成功的 write/edit 需要语言服务器；其他工具结果不懒加载会话。
    if (!isTrackedToolResult(event)) return;
    if (!session) await startSession(ctx);
    await session.handleToolResult(event, ctx);
  });

  pi.on("turn_end", (event) => {
    const content = session?.flushTurn(event);
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
    await session?.shutdown();
    session = undefined;
  });

  pi.registerCommand("lsp-feedback-status", {
    description: "Show lsp-feedback server and diagnostic status.",
    handler: async (_args, ctx) => {
      const snapshot = session?.snapshot();
      const configurationIssue = session?.configurationIssue;
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
