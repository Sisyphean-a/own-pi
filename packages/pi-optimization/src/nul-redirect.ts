import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const DEV_NULL = "/dev/null";

interface Replacement {
  start: number;
  end: number;
}

export interface NulRewriteResult {
  command: string;
  count: number;
  skippedHeredoc: boolean;
}

interface Stats {
  toolCommands: number;
  userCommands: number;
  replacements: number;
  skippedHeredocs: number;
}

export interface BashExecOptions {
  onData: (data: Buffer) => void;
  signal?: AbortSignal;
  timeout?: number;
  env?: NodeJS.ProcessEnv;
}

export interface BashOperations {
  exec(
    command: string,
    cwd: string,
    options: BashExecOptions,
  ): Promise<{ exitCode: number | null }>;
}

export interface NulRedirectDependencies {
  loadLocalBashOperations?: () => Promise<BashOperations | undefined> | BashOperations | undefined;
}

function isHorizontalWhitespace(char: string | undefined): boolean {
  return char === " " || char === "\t";
}

function isTokenBoundary(char: string | undefined): boolean {
  return (
    char === undefined ||
    char === " " ||
    char === "\t" ||
    char === "\r" ||
    char === "\n" ||
    char === ";" ||
    char === "&" ||
    char === "|" ||
    char === "(" ||
    char === ")" ||
    char === "<" ||
    char === ">"
  );
}

/** Bash 中 # 只有出现在一个新词的开头时才表示注释。 */
function isCommentStart(command: string, index: number): boolean {
  if (command[index] !== "#") return false;
  if (index === 0) return true;

  const previous = command[index - 1];
  return (
    previous === " " ||
    previous === "\t" ||
    previous === "\r" ||
    previous === "\n" ||
    previous === ";" ||
    previous === "|" ||
    previous === "&" ||
    previous === "(" ||
    previous === ")"
  );
}

/** 跳过单引号、双引号或反引号字符串。 */
function skipQuoted(command: string, start: number, quote: "'" | '"' | "`"): number {
  let index = start + 1;

  while (index < command.length) {
    const char = command[index];

    if (quote !== "'" && char === "\\") {
      index += 2;
      continue;
    }

    if (char === quote) return index + 1;
    index++;
  }

  return command.length;
}

/** 返回重定向操作符后的索引；文件描述符复制和 Here-doc 不在处理范围内。 */
function getRedirectOperatorEnd(command: string, index: number): number | undefined {
  const char = command[index];
  const next = command[index + 1];
  const third = command[index + 2];

  if (char === "&" && next === ">") {
    return third === ">" ? index + 3 : index + 2;
  }

  if (char === ">") {
    if (next === ">") return index + 2;
    if (next === "|") return index + 2;

    // `2>&1` 是文件描述符复制，不能改写；`>& file` 仍可改写目标。
    if (next === "&") {
      const previous = command[index - 1];
      if (previous !== undefined && /[0-9]/.test(previous)) return undefined;
      return index + 2;
    }

    return index + 1;
  }

  if (char === "<") {
    if (next === "<") return undefined;
    if (next === ">") return index + 2;
    if (next === "&") return undefined;
    return index + 1;
  }

  return undefined;
}

function parseNulTarget(command: string, operatorEnd: number): Replacement | undefined {
  let start = operatorEnd;

  while (isHorizontalWhitespace(command[start])) start++;

  if (start >= command.length || command[start] === "\r" || command[start] === "\n") {
    return undefined;
  }

  const first = command[start];

  if (first === "'" || first === '"') {
    const end = skipQuoted(command, start, first);
    if (end > command.length || command[end - 1] !== first) return undefined;

    const value = command.slice(start + 1, end - 1);
    if (value.toLowerCase() !== "nul") return undefined;
    if (!isTokenBoundary(command[end])) return undefined;

    return { start, end };
  }

  let end = start;
  while (!isTokenBoundary(command[end])) end++;

  const value = command.slice(start, end);
  if (value.toLowerCase() !== "nul") return undefined;

  return { start, end };
}

function applyReplacements(command: string, replacements: Replacement[]): string {
  let result = command;

  for (let index = replacements.length - 1; index >= 0; index--) {
    const replacement = replacements[index];
    result = result.slice(0, replacement.start) + DEV_NULL + result.slice(replacement.end);
  }

  return result;
}

/**
 * 安全改写 Bash 命令中的裸 `nul` 重定向目标。
 *
 * Guarantee: 不修改普通字符串、注释、命令替换或 Here-doc 正文；只改写
 * 重定向操作符后独立的 `nul` 目标。
 */
export function rewriteNulRedirects(command: string): NulRewriteResult {
  if (!command || !/nul/i.test(command)) {
    return { command, count: 0, skippedHeredoc: false };
  }

  const replacements: Replacement[] = [];
  let index = 0;

  while (index < command.length) {
    const char = command[index];

    if (char === "\\") {
      index += 2;
      continue;
    }

    if (char === "'" || char === '"' || char === "`") {
      index = skipQuoted(command, index, char);
      continue;
    }

    if (isCommentStart(command, index)) {
      const newline = command.indexOf("\n", index + 1);
      index = newline === -1 ? command.length : newline + 1;
      continue;
    }

    // Here-doc/Here-string 的正文不是普通 Shell 代码，整条命令保持不变。
    if (char === "<" && command[index + 1] === "<") {
      return { command, count: 0, skippedHeredoc: true };
    }

    const operatorEnd = getRedirectOperatorEnd(command, index);
    if (operatorEnd === undefined) {
      index++;
      continue;
    }

    const target = parseNulTarget(command, operatorEnd);
    if (target) {
      replacements.push(target);
      index = target.end;
      continue;
    }

    index = operatorEnd;
  }

  return {
    command: applyReplacements(command, replacements),
    count: replacements.length,
    skippedHeredoc: false,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning"): void {
  try {
    if (ctx.hasUI && typeof ctx.ui?.notify === "function") {
      ctx.ui.notify(message, level);
    }
  } catch {
    // UI is optional and can be stale while a session is being replaced.
  }
}

function isBashToolCall(
  event: unknown,
): event is { toolName: "bash"; input: { command: string } } {
  if (!event || typeof event !== "object") return false;
  const candidate = event as { toolName?: unknown; input?: unknown };
  if (candidate.toolName !== "bash" || !candidate.input || typeof candidate.input !== "object") {
    return false;
  }
  return typeof (candidate.input as { command?: unknown }).command === "string";
}

async function loadPiBashOperations(): Promise<BashOperations | undefined> {
  try {
    const module = await import("@earendil-works/pi-coding-agent") as {
      createLocalBashOperations?: () => BashOperations;
    };
    return typeof module.createLocalBashOperations === "function"
      ? module.createLocalBashOperations()
      : undefined;
  } catch (error) {
    console.error(`[pi-optimization/fix-nul-redirect] 手动 Bash 后端不可用：${errorMessage(error)}`);
    return undefined;
  }
}

export function installNulRedirect(
  pi: ExtensionAPI,
  dependencies: NulRedirectDependencies = {},
): void {
  let enabled = process.env.PI_FIX_NUL_REDIRECT !== "0";
  let userBashEnabled = process.env.PI_FIX_NUL_USER_BASH !== "0";
  const notifyOnFirstRewrite = process.env.PI_FIX_NUL_NOTIFY === "1";

  let hasNotified = false;
  let localBashPromise: Promise<BashOperations | undefined> | undefined;
  const stats: Stats = {
    toolCommands: 0,
    userCommands: 0,
    replacements: 0,
    skippedHeredocs: 0,
  };

  const getLocalBash = (): Promise<BashOperations | undefined> => {
    if (!localBashPromise) {
      const loader = dependencies.loadLocalBashOperations ?? loadPiBashOperations;
      localBashPromise = Promise.resolve().then(loader).catch((error) => {
        console.error(`[pi-optimization/fix-nul-redirect] 手动 Bash 后端不可用：${errorMessage(error)}`);
        return undefined;
      });
    }
    return localBashPromise;
  };

  function recordRewrite(
    source: "tool" | "user",
    count: number,
    skippedHeredoc: boolean,
    context: ExtensionContext,
  ): void {
    if (source === "tool") stats.toolCommands++;
    else stats.userCommands++;

    stats.replacements += count;
    if (skippedHeredoc) stats.skippedHeredocs++;

    if (notifyOnFirstRewrite && !hasNotified && count > 0) {
      hasNotified = true;
      notify(context, `pi 优化：已将 ${count} 处 nul 重定向改为 ${DEV_NULL}`, "info");
    }
  }

  if (typeof pi.on !== "function") return;

  pi.on("tool_call", (event, ctx) => {
    if (!enabled || !isBashToolCall(event)) return;

    const result = rewriteNulRedirects(event.input.command);
    recordRewrite("tool", result.count, result.skippedHeredoc, ctx);
    if (result.count > 0) event.input.command = result.command;
  });

  // user_bash 后端是可选能力：缺少它时保留 Pi 原始执行路径，不抛错。
  pi.on("user_bash", async (event, ctx) => {
    if (!enabled || !userBashEnabled) return;

    const result = rewriteNulRedirects(event.command);
    recordRewrite("user", result.count, result.skippedHeredoc, ctx);
    if (result.count === 0) return;

    const localBash = await getLocalBash();
    if (!localBash) return;

    return {
      operations: {
        exec(command: string, cwd: string, options: BashExecOptions) {
          const finalCommand = rewriteNulRedirects(command).command;
          return localBash.exec(finalCommand, cwd, options);
        },
      },
    };
  });

  if (typeof pi.registerCommand !== "function") return;

  pi.registerCommand("nulfix", {
    description: "查看、开关或预览 nul → /dev/null 安全改写",
    handler: async (args, ctx) => {
      try {
        const trimmed = args.trim();
        const [action = "status"] = trimmed.split(/\s+/, 1);

        if (action === "on") {
          enabled = true;
          notify(ctx, "pi 优化的 nul 重定向修复已启用", "info");
          return;
        }

        if (action === "off") {
          enabled = false;
          notify(ctx, "pi 优化的 nul 重定向修复已禁用", "warning");
          return;
        }

        if (action === "manual-on") {
          userBashEnabled = true;
          notify(ctx, "手动 ! / !! 命令修复已启用", "info");
          return;
        }

        if (action === "manual-off") {
          userBashEnabled = false;
          notify(ctx, "手动 ! / !! 命令修复已禁用；AI Bash 修复仍保留", "warning");
          return;
        }

        if (action === "preview") {
          const previewCommand = trimmed.slice("preview".length).trim();
          if (!previewCommand) {
            notify(ctx, "用法：/nulfix preview <bash command>", "warning");
            return;
          }

          const result = rewriteNulRedirects(previewCommand);
          const note = result.skippedHeredoc
            ? "检测到 Here-doc/Here-string，出于安全考虑未改写"
            : `改写 ${result.count} 处`;
          notify(ctx, `${note}\n${result.command}`, "info");
          return;
        }

        notify(
          ctx,
          [
            `总开关：${enabled ? "开启" : "关闭"}`,
            `手动 !/!!：${userBashEnabled ? "开启" : "关闭"}`,
            `AI Bash 命令：${stats.toolCommands}`,
            `手动命令：${stats.userCommands}`,
            `累计替换：${stats.replacements}`,
            `因 Here-doc 跳过：${stats.skippedHeredocs}`,
          ].join("\n"),
          "info",
        );
      } catch (error) {
        console.error(`[pi-optimization/fix-nul-redirect] 命令失败：${errorMessage(error)}`);
      }
    },
  });
}

export default installNulRedirect;
