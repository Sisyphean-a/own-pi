import { randomUUID } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "pi-wait";
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const RETRY_DELAY_MS = 30_000;

type WaitContent = string | Array<Record<string, unknown>>;

export interface WaitTask {
  id: string;
  dueAt: number;
  createdAt: number;
  content: WaitContent;
  preview: string;
}

export interface WaitRuntime {
  now(): number;
  createId(): string;
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
}

const defaultRuntime: WaitRuntime = {
  now: () => Date.now(),
  createId: () => randomUUID().slice(0, 8),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function parseRelativeTime(expression: string): number | undefined {
  const normalized = expression
    .trim()
    .replace(/^(?:in|after)\s+/i, "")
    .replace(/后$/, "")
    .trim();
  const token = /(\d+(?:\.\d+)?)\s*(毫秒|ms|秒|s|分钟|分|m|小时|时|h|天|d)/gi;
  const unitMs: Record<string, number> = {
    毫秒: 1,
    ms: 1,
    秒: 1_000,
    s: 1_000,
    分钟: 60_000,
    分: 60_000,
    m: 60_000,
    小时: 3_600_000,
    时: 3_600_000,
    h: 3_600_000,
    天: 86_400_000,
    d: 86_400_000,
  };

  let total = 0;
  let consumed = "";
  for (const match of normalized.matchAll(token)) {
    const value = Number(match[1]);
    const unit = match[2].toLowerCase();
    total += value * unitMs[unit];
    consumed += match[0];
  }

  if (
    !Number.isFinite(total) ||
    total <= 0 ||
    consumed.replace(/\s/g, "") !== normalized.replace(/\s/g, "")
  ) {
    return undefined;
  }
  return total;
}

/** Rule: 只接受明确的相对时间、本地时间或带时区 ISO 时间。 */
export function parseWaitTime(expression: string, now = Date.now()): number {
  const relativeMs = parseRelativeTime(expression);
  if (relativeMs !== undefined) return now + relativeMs;

  const localDateTime = expression.trim().match(
    /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/,
  );
  if (localDateTime) {
    const [, yearText, monthText, dayText, hourText, minuteText, secondText = "0"] = localDateTime;
    const [year, month, day, hour, minute, second] = [
      yearText,
      monthText,
      dayText,
      hourText,
      minuteText,
      secondText,
    ].map(Number);
    const due = new Date(year, month - 1, day, hour, minute, second);
    if (
      due.getFullYear() !== year ||
      due.getMonth() !== month - 1 ||
      due.getDate() !== day ||
      due.getHours() !== hour ||
      due.getMinutes() !== minute ||
      due.getSeconds() !== second
    ) {
      throw new Error("时间格式无效");
    }
    const dueAt = due.getTime();
    if (dueAt <= now) throw new Error("指定时间必须晚于现在");
    return dueAt;
  }

  const localClock = expression.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (localClock) {
    const [, hour, minute, second = "0"] = localClock;
    if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) {
      throw new Error("时间格式无效");
    }
    const due = new Date(now);
    due.setHours(Number(hour), Number(minute), Number(second), 0);
    if (due.getTime() <= now) due.setDate(due.getDate() + 1);
    return due.getTime();
  }

  const isoTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
  const parsed = isoTimestamp.test(expression.trim()) ? Date.parse(expression.trim()) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    throw new Error("无法识别时间；可用 30m、2小时、09:30 或 2026-08-30 09:30");
  }
  if (parsed <= now) throw new Error("指定时间必须晚于现在");
  return parsed;
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

function splitInlineTask(args: string): { time: string; task?: string } {
  const match = args.match(/^(.*?)\s+--\s+([\s\S]+)$/);
  if (!match) return { time: args.trim() };
  return { time: match[1].trim(), task: match[2].trim() };
}

export function activateWaitExtension(
  pi: ExtensionAPI,
  runtime: WaitRuntime = defaultRuntime,
): void {
  let tasks = new Map<string, WaitTask>();
  let armedDueAt: number | undefined;
  let timer: unknown;
  let activeContext: ExtensionContext | undefined;
  let sessionGeneration = 0;
  let dispatching = false;

  const notify = (
    ctx: ExtensionContext,
    message: string,
    level: "info" | "warning" | "error",
  ): void => {
    try {
      ctx.ui.notify(message, level);
    } catch {
      // Effect: UI 故障不能改变消息派发或重试决定。
    }
  };

  const clearTimer = (): void => {
    if (timer !== undefined) runtime.clearTimer(timer);
    timer = undefined;
  };

  const updateStatus = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI) return;
    try {
      if (armedDueAt !== undefined) {
        ctx.ui.setStatus(STATUS_KEY, `wait: 等待任务（${formatTime(armedDueAt)}）`);
        return;
      }
      const next = [...tasks.values()].sort((a, b) => a.dueAt - b.dueAt)[0];
      ctx.ui.setStatus(
        STATUS_KEY,
        next ? `wait: ${tasks.size} 项，最近 ${formatTime(next.dueAt)}` : undefined,
      );
    } catch {
      // Effect: 状态栏只是可选展示，不能阻断调度。
    }
  };

  const armNextTimer = (ctx: ExtensionContext): void => {
    clearTimer();
    updateStatus(ctx);
    const next = [...tasks.values()].sort((a, b) => a.dueAt - b.dueAt)[0];
    if (!next) return;
    const delay = Math.max(0, Math.min(next.dueAt - runtime.now(), MAX_TIMER_DELAY_MS));
    const generation = sessionGeneration;
    timer = runtime.setTimer(() => {
      timer = undefined;
      void dispatchDue(generation);
    }, delay);
  };

  const dispatchDue = async (generation: number): Promise<void> => {
    const ctx = activeContext;
    if (dispatching || generation !== sessionGeneration || !ctx) return;
    dispatching = true;
    try {
      const now = runtime.now();
      const due = [...tasks.values()]
        .filter((task) => task.dueAt <= now)
        .sort((a, b) => a.dueAt - b.dueAt);

      for (const task of due) {
        tasks.delete(task.id);
        try {
          pi.sendUserMessage(task.content as never, {
            deliverAs: "followUp",
            expandPromptTemplates: true,
          });
          notify(ctx, `定时任务 ${task.id} 已发送`, "info");
        } catch (error) {
          const retryTask = { ...task, dueAt: runtime.now() + RETRY_DELAY_MS };
          tasks.set(task.id, retryTask);
          const message = error instanceof Error ? error.message : String(error);
          notify(ctx, `定时任务 ${task.id} 未被 Pi 接受，30 秒后重试：${message}`, "error");
        }
      }
    } finally {
      dispatching = false;
      if (generation === sessionGeneration && ctx === activeContext) armNextTimer(ctx);
    }
  };

  const schedule = (
    ctx: ExtensionContext,
    dueAt: number,
    content: WaitContent,
    preview: string,
  ): WaitTask => {
    const task: WaitTask = {
      id: runtime.createId(),
      dueAt,
      createdAt: runtime.now(),
      content,
      preview,
    };
    tasks.set(task.id, task);
    armedDueAt = undefined;
    armNextTimer(ctx);
    return task;
  };

  const reset = (ctx?: ExtensionContext): void => {
    clearTimer();
    tasks = new Map();
    armedDueAt = undefined;
    dispatching = false;
    if (ctx?.hasUI) {
      try {
        ctx.ui.setStatus(STATUS_KEY, undefined);
      } catch {
        // Guarantee: 即使宿主 UI 不可用，也必须完成关闭清理。
      }
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    reset();
    sessionGeneration += 1;
    activeContext = ctx;
    updateStatus(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    reset(ctx);
    sessionGeneration += 1;
    activeContext = undefined;
  });

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension" || armedDueAt === undefined) {
      return { action: "continue" };
    }

    const text = event.text.trim();
    if (!text && (!event.images || event.images.length === 0)) {
      notify(ctx, "任务不能为空；继续等待下一条输入", "warning");
      return { action: "handled" };
    }

    const content: WaitContent = event.images?.length
      ? ([{ type: "text", text: event.text }, ...event.images] as Array<Record<string, unknown>>)
      : event.text;
    const task = schedule(ctx, armedDueAt, content, text || "[图片任务]");
    notify(ctx, `已保存定时任务 ${task.id}，将在 ${formatTime(task.dueAt)} 发送`, "info");
    return { action: "handled" };
  });

  pi.registerCommand("wait", {
    description: "延迟发送下一条普通任务输入，不提前调用 AI",
    handler: async (rawArgs, ctx) => {
      const args = rawArgs.trim();
      if (!args) {
        notify(ctx, "用法：/wait <时间>，然后输入任务；或 /wait <时间> -- <任务>", "warning");
        return;
      }

      if (args === "list") {
        const pending = [...tasks.values()].sort((a, b) => a.dueAt - b.dueAt);
        const capture = armedDueAt === undefined ? [] : [`等待输入：${formatTime(armedDueAt)}`];
        const lines = pending.map(
          (task) => `${task.id}  ${formatTime(task.dueAt)}  ${task.preview.replace(/\s+/g, " ").slice(0, 80)}`,
        );
        notify(ctx, [...capture, ...lines].join("\n") || "没有待发送任务", "info");
        return;
      }

      if (args === "cancel") {
        if (armedDueAt === undefined) {
          notify(ctx, "当前没有等待输入的任务", "warning");
          return;
        }
        armedDueAt = undefined;
        updateStatus(ctx);
        notify(ctx, "已取消等待下一条输入", "info");
        return;
      }

      if (args.startsWith("cancel ")) {
        const prefix = args.slice("cancel ".length).trim();
        const matches = [...tasks.keys()].filter((id) => id === prefix || id.startsWith(prefix));
        if (matches.length !== 1) {
          notify(
            ctx,
            matches.length === 0 ? `找不到任务：${prefix}` : `任务 ID 前缀不唯一：${prefix}`,
            "warning",
          );
          return;
        }
        const id = matches[0];
        tasks.delete(id);
        armNextTimer(ctx);
        notify(ctx, `已取消定时任务 ${id}`, "info");
        return;
      }

      const { time, task: inlineTask } = splitInlineTask(args);
      let dueAt: number;
      try {
        dueAt = parseWaitTime(time, runtime.now());
      } catch (error) {
        notify(ctx, error instanceof Error ? error.message : String(error), "warning");
        return;
      }

      if (inlineTask) {
        const task = schedule(ctx, dueAt, inlineTask, inlineTask);
        notify(ctx, `已保存定时任务 ${task.id}，将在 ${formatTime(dueAt)} 发送`, "info");
        return;
      }

      armedDueAt = dueAt;
      updateStatus(ctx);
      notify(ctx, `请发送下一条普通任务；它会在 ${formatTime(dueAt)} 才交给 AI`, "info");
    },
  });
}

export default activateWaitExtension;
