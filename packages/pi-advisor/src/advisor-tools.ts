import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MAX_READ_LINES = 400;
const DEFAULT_READ_LINES = 200;
const MAX_TOOL_OUTPUT_CHARS = 12000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30000;
const MAX_COMMAND_TIMEOUT_MS = 120000;

const ReadFileSchema = Type.Object({
  path: Type.String({ minLength: 1, description: "Path to a text file, relative to the project when possible." }),
  offset: Type.Optional(Type.Integer({ minimum: 1, description: "1-based first line to return." })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_READ_LINES, description: "Maximum number of lines to return." })),
});

const BashSchema = Type.Object({
  command: Type.String({
    minLength: 1,
    description: "A diagnostic shell command. Use normal shell syntax; do not modify project files.",
  }),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: MAX_COMMAND_TIMEOUT_MS })),
});

function clipText(text: string, maxChars = MAX_TOOL_OUTPUT_CHARS): string {
  if (text.length <= maxChars) return text;
  const headChars = Math.floor(maxChars * 0.7);
  const tailChars = maxChars - headChars;
  return `${text.slice(0, headChars).trimEnd()}\n…[advisor tool output truncated]…\n${text.slice(-tailChars).trimStart()}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shellInvocation(command: string): { executable: string; args: string[] } {
  if (process.platform === "win32") {
    return {
      executable: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", command],
    };
  }
  return {
    executable: process.env.SHELL || "/bin/sh",
    args: ["-lc", command],
  };
}

function readFileTool(cwd: string, onToolCall?: () => void): AgentTool<typeof ReadFileSchema> {
  return {
    name: "read",
    label: "Read file",
    description: "Read a bounded text-file excerpt when exact source context is needed for the advisory assessment.",
    parameters: ReadFileSchema,
    executionMode: "sequential",
    execute: async (_toolCallId, params) => {
      onToolCall?.();
      const path = resolve(cwd, params.path);
      const source = readFileSync(path, "utf8");
      const lines = source.split(/\r?\n/);
      const startLine = params.offset ?? 1;
      const lineLimit = Math.min(params.limit ?? DEFAULT_READ_LINES, MAX_READ_LINES);
      const selected = lines.slice(startLine - 1, startLine - 1 + lineLimit);
      const numbered = selected.map((line, index) => `${startLine + index}\t${line}`).join("\n");
      const suffix = startLine - 1 + selected.length < lines.length ? "\n…[more lines available]" : "";
      const text = numbered ? `${numbered}${suffix}` : `(no lines available at ${path}:${startLine})`;
      return {
        content: [{ type: "text", text: clipText(`FILE: ${path}\n${text}`) }],
        details: { path, startLine, lineCount: selected.length },
      };
    },
  };
}

function bashTool(pi: ExtensionAPI, cwd: string, onToolCall?: () => void): AgentTool<typeof BashSchema> {
  return {
    name: "bash",
    label: "Run diagnostic command",
    description: "Run a diagnostic shell command when it materially improves confidence. Tool use is optional; do not edit project files.",
    parameters: BashSchema,
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal) => {
      onToolCall?.();
      const timeout = Math.min(params.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS);
      const invocation = shellInvocation(params.command);
      let result;
      try {
        result = await pi.exec(invocation.executable, invocation.args, { cwd, signal, timeout });
      } catch (error) {
        throw new Error(`Could not run diagnostic command: ${errorMessage(error)}`);
      }

      const parts = [
        `$ ${params.command}`,
        `exit code: ${result.code}${result.killed ? " (killed or timed out)" : ""}`,
      ];
      if (result.stdout.trim()) parts.push(`stdout:\n${clipText(result.stdout)}`);
      if (result.stderr.trim()) parts.push(`stderr:\n${clipText(result.stderr)}`);
      if (!result.stdout.trim() && !result.stderr.trim()) parts.push("(no output)");

      return {
        content: [{ type: "text", text: clipText(parts.join("\n\n")) }],
        details: { command: params.command, code: result.code, killed: result.killed },
      };
    },
  };
}

export function createAdvisorTools(pi: ExtensionAPI, cwd: string, onToolCall?: () => void): AgentTool[] {
  return [readFileTool(cwd, onToolCall), bashTool(pi, cwd, onToolCall)];
}

export function summarizeAdvisorToolCall(toolName: string, args: unknown): string {
  if (!args || typeof args !== "object") return toolName;
  const record = args as Record<string, unknown>;
  if (toolName === "read" && typeof record.path === "string") return `read ${record.path}`;
  if (toolName === "bash" && typeof record.command === "string") return `$ ${record.command.replace(/\s+/g, " ").trim().slice(0, 140)}`;
  return toolName;
}
