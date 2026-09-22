import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const EXTENSION_LOG_RELATIVE_PATH = join("pi-tui-enhancements", "errors.ndjson");
export const EXTENSION_LOG_MAX_BYTES = 10 * 1024 * 1024;

function defaultAgentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  if (!configured) return join(homedir(), ".pi", "agent");
  if (configured === "~") return homedir();
  if (configured.startsWith("~/") || configured.startsWith("~\\")) {
    return join(homedir(), configured.slice(2));
  }
  return configured;
}

export function extensionLogPath(agentDir = defaultAgentDir()): string {
  return join(agentDir, EXTENSION_LOG_RELATIVE_PATH);
}

/**
 * Rule: TUI 运行期间不得向 stdout/stderr 写入失败信息，否则会破坏终端布局。
 * Failure: 日志写入或轮转失败时静默放弃，不能回退到终端输出或影响原流程。
 */
export function logFailure(scope: string, message: string, path?: string): void {
  try {
    const targetPath = path ?? extensionLogPath();
    mkdirSync(dirname(targetPath), { recursive: true });
    rotateIfNeeded(targetPath);
    appendFileSync(targetPath, `${JSON.stringify({
      ts: new Date().toISOString(),
      scope,
      message,
    })}\n`, "utf8");
  } catch {
    // 日志本身是故障隔离边界，失败后不得再产生任何用户可见副作用。
  }
}

function rotateIfNeeded(path: string): void {
  if (!existsSync(path) || statSync(path).size < EXTENSION_LOG_MAX_BYTES) return;
  const backupPath = `${path}.1`;
  if (existsSync(backupPath)) unlinkSync(backupPath);
  renameSync(path, backupPath);
}
