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
  }

  async checkFile(filePath, signal) {
    const absolutePath = path.resolve(this.workspaceRoot, filePath);
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
    const clients = [...this.clients.values()];
    this.clients.clear();
    await Promise.allSettled(clients.map((client) => client.close()));
  }

  snapshot() {
    return {
      workspaceRoot: this.workspaceRoot,
      configuredServers: this.servers.map((server) => server.id),
      liveClients: [...this.clients.keys()],
    };
  }

  async getClient(server, root, signal) {
    const key = `${server.id}:${root}`;
    const existing = this.clients.get(key);
    if (existing?.alive) return existing;
    if (existing) {
      this.clients.delete(key);
      await existing.close();
    }

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
            this.clients.set(key, client);
            return client;
          } catch (error) {
            attempts.push(error instanceof Error ? error.message : String(error));
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
