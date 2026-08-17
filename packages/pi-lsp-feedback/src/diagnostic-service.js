import { readFile } from "node:fs/promises";
import path from "node:path";
import { LspClient } from "./lsp-client.js";
import {
  commandCandidates,
  findWorkspaceRoot,
  initializationOptions,
  mergeServerOverrides,
  serverForFile,
} from "./servers.js";

export class DiagnosticService {
  constructor({ workspaceRoot, overrides = {} }) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.servers = mergeServerOverrides(overrides);
    this.clients = new Map();
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
      const outcome = await client.checkDocument(absolutePath, text, server.languageId, signal);
      return result(absolutePath, outcome.status, {
        serverId: server.id,
        root,
        diagnostics: outcome.diagnostics,
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
    const attempts = [];
    for (const commandSpec of server.commands) {
      for (const command of commandCandidates(root, this.workspaceRoot, commandSpec.command)) {
        try {
          const client = await LspClient.start({
            command,
            args: commandSpec.args,
            root,
            serverId: server.id,
            initializationOptions: initialization,
            signal,
          });
          this.clients.set(key, client);
          return client;
        } catch (error) {
          attempts.push(error instanceof Error ? error.message : String(error));
        }
      }
    }
    throw new Error(`${server.id} could not start: ${attempts.at(-1) ?? "no command candidates"}`);
  }
}

function result(filePath, status, fields = {}) {
  return { filePath, status, diagnostics: [], ...fields };
}
