import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { LspClient } from "./lsp-client.js";
import { installManagedServer } from "./managed-server-installer.js";
import {
  BUILTIN_SERVERS,
  commandCandidates,
  findNodeTypesRoot,
  findWorkspaceRoot,
  initializationOptions,
  languageIdForFile,
  serverForFile,
  typescriptBridgeOptions,
} from "./servers.js";

export class DiagnosticService {
  constructor({
    workspaceRoot,
    servers = BUILTIN_SERVERS,
    allowManagedInstall = false,
    managedInstaller = installManagedServer,
  }) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.servers = servers;
    this.clients = new Map();
    this.managedInstallFailures = new Map();
    this.allowManagedInstall = allowManagedInstall;
    this.managedInstaller = managedInstaller;
    /**
     * `close()` 之后本实例不再可用。
     *
     * Rule: 关闭期间必须继续持有客户端引用，直到它真正终止；否则迟到的检查会通过
     * `getClient` 新建一个无人持有的语言服务器，留下孤儿进程。会话由 `startSession`
     * 重建 DiagnosticService 实例，因此关闭后拒绝新建客户端不会影响后续会话。
     */
    this.closed = false;
    this.pendingClients = new Map();
  }

  async checkFile(filePath, signal) {
    const absolutePath = path.resolve(this.workspaceRoot, filePath);
    if (this.closed) {
      return result(absolutePath, "unavailable", { reason: "diagnostic service is closed" });
    }
    const server = serverForFile(this.servers, absolutePath);
    if (!server) {
      return result(absolutePath, "unsupported", { reason: "no configured LSP for this file type" });
    }

    const root = findWorkspaceRoot(absolutePath, this.workspaceRoot, server);
    if (!root) {
      return result(absolutePath, "unavailable", {
        serverId: server.id,
        reason: `no ${server.rootMarkers.join(" or ")} workspace marker found`,
      });
    }

    if (server.needsNodeTypes && !findNodeTypesRoot(absolutePath)) {
      // 无 @types/node（Node 类型环境）时，tsserver 只会报 2307 无法解析 node:*
      // 及连锁 7006/2580 一类“缺少对应环境”的噪音，并非真实代码错误。
      // 按“有则报、无则静默”：返回 unavailable，不反馈这些诊断。
      return result(absolutePath, "unavailable", {
        serverId: server.id,
        reason: "no @types/node available for Node runtime types",
      });
    }

    let text;
    try {
      text = await readFile(absolutePath, "utf8");
    } catch (error) {
      return result(absolutePath, "unavailable", {
        serverId: server.id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      const client = await this.getClient(server, root, signal);
      const outcome = await client.checkDocument(
        absolutePath,
        text,
        languageIdForFile(server, absolutePath),
        signal,
      );

      // Rule: diagnostics for a snapshot already replaced on disk are never
      // allowed to reach the feedback tracker.
      let currentText;
      try {
        currentText = await readFile(absolutePath, "utf8");
      } catch (error) {
        return result(absolutePath, "unconfirmed", {
          serverId: server.id,
          root,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      if (currentText !== text) {
        return result(absolutePath, "unconfirmed", {
          serverId: server.id,
          root,
          reason: "file changed while diagnostics were collected",
          contentHash: hashText(currentText),
        });
      }

      return result(absolutePath, outcome.status, {
        serverId: server.id,
        root,
        diagnostics: outcome.diagnostics,
        contentHash: hashText(text),
      });
    } catch (error) {
      if (error?.name === "AbortError") {
        return result(absolutePath, "cancelled", { serverId: server.id });
      }
      return result(absolutePath, "unavailable", {
        serverId: server.id,
        root,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async close() {
    this.closed = true;
    // Guarantee: 保持 clients 引用直到每个客户端真正终止，避免关闭期间重启语言服务器。
    const clients = [...this.clients.values()];
    await Promise.allSettled(clients.map((client) => client.close()));
    this.clients.clear();
    // Guarantee: 进行中的启动在返回前会关闭自己新建的客户端，close() 等它们落定。
    await Promise.allSettled([...this.pendingClients.values()]);
    this.pendingClients.clear();
  }

  snapshot() {
    return {
      workspaceRoot: this.workspaceRoot,
      configuredServers: this.servers.map((server) => server.id),
      liveClients: [...this.clients.keys()],
    };
  }

  async getClient(server, root, signal) {
    if (this.closed) throw new Error("diagnostic service is closed");
    const key = `${server.id}:${root}`;
    const existing = this.clients.get(key);
    if (existing?.alive) return existing;
    if (existing) {
      this.clients.delete(key);
      await existing.close();
    }

    // Rule: 同一个 workspace 的启动可能并发：同步预算超时后，下一次编辑会在前一个启动完成前
    // 再次进入这里。复用进行中的启动，否则后一个客户端覆盖前一个，前者再无人关闭。
    const pending = this.pendingClients.get(key);
    if (pending) return pending;
    const launching = this.startClient(server, root, signal, key);
    this.pendingClients.set(key, launching);
    try {
      return await launching;
    } finally {
      this.pendingClients.delete(key);
    }
  }

  /** 启动并登记一个客户端；所有候选命令都不可用时返回 undefined。 */
  async startClient(server, root, signal, key) {
    const initialization = initializationOptions(server, root, this.workspaceRoot);
    const typescriptBridge = typescriptBridgeOptions(server, root, this.workspaceRoot);
    const attempts = [];
    const launch = async () => {
      for (const commandSpec of server.commands) {
        for (const command of commandCandidates(root, this.workspaceRoot, commandSpec.command)) {
          try {
            const client = await LspClient.start({
              command,
              args: commandSpec.args,
              root,
              serverId: server.id,
              initializationOptions: initialization,
              typescriptBridge,
              signal,
            });
            // Rule: closed 检查与写入 clients 必须在同一个同步块内完成；
            // 否则 close() 可能在两者之间跑完整个关闭流程，让这个客户端留在已关闭的 map 里。
            if (this.closed) {
              await client.close().catch(() => undefined);
              throw new Error("diagnostic service is closed");
            }
            this.clients.set(key, client);
            return client;
          } catch (error) {
            attempts.push(error instanceof Error ? error.message : String(error));
            // 关闭后不再尝试后续候选：每个候选启动后都会立即被关闭。
            if (this.closed) throw error;
          }
        }
      }
      return undefined;
    };

    const existingClient = await launch();
    if (existingClient) return existingClient;

    if (server.managedInstaller && this.allowManagedInstall) {
      const priorFailure = this.managedInstallFailures.get(server.managedInstaller);
      if (priorFailure) {
        attempts.push(priorFailure);
      } else {
        try {
          const installed = await this.managedInstaller(server.managedInstaller);
          if (installed) {
            const installedClient = await launch();
            if (installedClient) return installedClient;
          } else {
            const reason = `${server.managedInstaller} installation did not complete`;
            this.managedInstallFailures.set(server.managedInstaller, reason);
            attempts.push(reason);
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          this.managedInstallFailures.set(server.managedInstaller, reason);
          attempts.push(reason);
        }
      }
    } else if (server.managedInstaller) {
      attempts.push(`${server.managedInstaller} automatic installation requires a trusted project`);
    }

    throw new Error(`${server.id} could not start: ${attempts.at(-1) ?? "no command candidates"}`);
  }
}

function result(filePath, status, fields = {}) {
  return { filePath, status, diagnostics: [], ...fields };
}

function hashText(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
