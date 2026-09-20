/**
 * 模型生成（思考）中的会话状态。
 *
 * Rule: 状态只由 Pi 的回合事件驱动——`turn_start` 进入思考，`tool_execution_start`、
 * `turn_end`、`agent_settled`、`session_shutdown` 结束思考。输入框上边框的呼吸图标只在
 * 思考期间显示，因此跑工具时只留 `⠋ Working…`。
 */
export type ThinkingState = {
  isActive(): boolean;
  setActive(active: boolean): void;
};

export function createThinkingState(): ThinkingState {
  let active = false;
  return {
    isActive: () => active,
    setActive(next: boolean) {
      active = next;
    },
  };
}

/** 只用到 Pi 事件订阅这一条 seam，便于测试时用同构的假实现替代。 */
export type ThinkingEventBinder = {
  on(
    event: "turn_start" | "tool_execution_start" | "turn_end" | "agent_settled" | "session_shutdown",
    handler: () => void,
  ): void;
};

export function bindThinkingState(pi: ThinkingEventBinder, state: ThinkingState): void {
  pi.on("turn_start", () => state.setActive(true));
  pi.on("tool_execution_start", () => state.setActive(false));
  pi.on("turn_end", () => state.setActive(false));
  pi.on("agent_settled", () => state.setActive(false));
  pi.on("session_shutdown", () => state.setActive(false));
}
