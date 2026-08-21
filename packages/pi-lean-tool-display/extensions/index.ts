import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CODEX_PROVIDER_ID, createCodexUsageController } from "../src/codex-usage.ts";
import {
  getThinkingLabel,
  getThinkingState,
  installCompactUserMessage,
  installThinkingCollapse,
  isAssistantMessage,
  labelThinking,
  sanitizeThinking,
  setThinkingCollapsed,
  type Theme,
} from "../src/message-display.ts";
import { installContainerParentTracking, installToolRenderers } from "../src/tool-rendering.ts";

export default function leanToolDisplay(pi: ExtensionAPI): void {
  installContainerParentTracking();
  installToolRenderers();
  installThinkingCollapse();
  installCompactUserMessage();

  const codexUsage = createCodexUsageController();

  pi.registerCommand("thinking", {
    description: "折叠或展开思考内容",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      const state = getThinkingState();
      let collapsed: boolean;

      if (action === "" || action === "toggle") {
        collapsed = !state.collapsed;
      } else if (action === "show" || action === "on") {
        collapsed = false;
      } else if (action === "hide" || action === "off") {
        collapsed = true;
      } else {
        ctx.ui.notify("用法：/thinking [toggle|show|hide]", "warning");
        return;
      }

      setThinkingCollapsed(ctx, collapsed);
      ctx.ui.notify(`思考内容已${collapsed ? "折叠" : "展开"}`, "info");
    },
  });

  pi.registerShortcut("ctrl+shift+t", {
    description: "折叠或展开思考内容",
    handler: (ctx) => setThinkingCollapsed(ctx, !getThinkingState().collapsed),
  });

  pi.on("session_start", (_event, ctx) => {
    (globalThis as { __piLeanTheme?: Theme }).__piLeanTheme = ctx.ui.theme as unknown as Theme;
    ctx.ui.setHiddenThinkingLabel(getThinkingLabel(getThinkingState().collapsed));
    void codexUsage.refresh(ctx);
  });

  pi.on("model_select", (event, ctx) => {
    if (event.model.provider === CODEX_PROVIDER_ID) {
      void codexUsage.refresh(ctx);
    } else {
      codexUsage.clear(ctx);
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    codexUsage.clear(ctx);
  });

  pi.on("message_update", (event, ctx) => {
    if (isAssistantMessage(event.message)) {
      labelThinking(event.message, ctx.ui.theme as unknown as Theme);
    }
  });

  pi.on("message_end", (event, ctx) => {
    if (isAssistantMessage(event.message)) {
      labelThinking(event.message, ctx.ui.theme as unknown as Theme);
    }
  });

  pi.on("context", (event) => {
    event.messages.splice(0, event.messages.length, ...sanitizeThinking(event.messages));
  });
}
