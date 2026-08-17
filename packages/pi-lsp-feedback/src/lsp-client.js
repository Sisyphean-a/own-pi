import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";

const INITIALIZE_TIMEOUT_MS = 8_000;
const DIAGNOSTIC_TIMEOUT_MS = 2_500;

export class LspClient {
  static async start(options) {
    const client = new LspClient(options);
    try {
      await client.initialize();
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  constructor({ command, args, root, serverId, initializationOptions }) {
    this.command = command;
    this.args = args;
    this.root = root;
    this.serverId = serverId;
    this.initializationOptions = initializationOptions;
    this.documents = new Map();
    this.publications = new Map();
    this.waiters = new Map();
    this.queue = Promise.resolve();
    this.alive = false;
  }

  async initialize() {
    const shell = process.platform === "win32" && /\.(cmd|bat)$/i.test(this.command);
    this.process = spawn(this.command, this.args, {
      cwd: this.root,
      shell,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.process.stderr?.resume();
    this.exitPromise = new Promise((resolve) => {
      this.process.once("exit", () => {
        this.alive = false;
        this.rejectWaiters(new Error(`${this.serverId} exited`));
        resolve();
      });
    });
    await waitForSpawn(this.process);

    this.connection = createMessageConnection(
      new StreamMessageReader(this.process.stdout),
      new StreamMessageWriter(this.process.stdin),
    );
    this.connection.onNotification("textDocument/publishDiagnostics", (params) => {
      this.recordPublication(params);
    });
    this.connection.listen();

    const initialize = this.connection.sendRequest("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(this.root).href,
      workspaceFolders: [{ uri: pathToFileURL(this.root).href, name: this.root.split(/[\\/]/).at(-1) ?? this.root }],
      capabilities: {
        workspace: { workspaceFolders: true },
        textDocument: { publishDiagnostics: { versionSupport: true } },
      },
      initializationOptions: this.initializationOptions,
    });
    const result = await withDeadline(
      initialize,
      INITIALIZE_TIMEOUT_MS,
      undefined,
      `${this.serverId} initialization timed out`,
    );

    this.capabilities = result?.capabilities ?? {};
    this.connection.sendNotification("initialized", {});
    this.alive = true;
  }

  checkDocument(filePath, text, languageId, signal) {
    const task = this.queue.then(() => this.checkDocumentNow(filePath, text, languageId, signal));
    this.queue = task.catch(() => undefined);
    return task;
  }

  async checkDocumentNow(filePath, text, languageId, signal) {
    if (!this.alive) throw new Error(`${this.serverId} is not running`);

    const uri = pathToFileURL(filePath).href;
    const baseline = this.publications.get(uri)?.sequence ?? 0;
    const document = this.documents.get(uri);
    const version = (document?.version ?? 0) + 1;
    this.documents.set(uri, { version, text });

    if (document) {
      this.connection.sendNotification("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      });
    } else {
      this.connection.sendNotification("textDocument/didOpen", {
        textDocument: { uri, languageId, version, text },
      });
    }

    if (this.capabilities.diagnosticProvider) {
      try {
        const result = await withDeadline(
          this.connection.sendRequest("textDocument/diagnostic", {
            textDocument: { uri },
          }),
          DIAGNOSTIC_TIMEOUT_MS,
          signal,
          `${this.serverId} diagnostic pull timed out`,
        );
        if (result?.kind === "full" || result?.kind === "unchanged") {
          return {
            status: "confirmed",
            diagnostics: normalizeDiagnostics(result.items ?? []),
          };
        }
      } catch {
        // A server may advertise pull diagnostics but reject the request. Its
        // push publication remains usable only when it carries this document version.
      }
    }

    const publication = await this.waitForPublication(uri, version, baseline, signal);
    if (!publication) {
      return { status: "unconfirmed", diagnostics: [] };
    }
    return {
      status: publication.version === version ? "confirmed" : "unconfirmed",
      diagnostics: publication.diagnostics,
    };
  }

  async close() {
    const child = this.process;
    if (!child) return;
    this.alive = false;
    if (!this.connection) {
      if (!child.killed) child.kill();
      this.process = undefined;
      return;
    }
    try {
      await withDeadline(this.connection.sendRequest("shutdown"), 500, undefined, "shutdown timed out");
    } catch {
      // The process is still terminated below.
    }
    try {
      this.connection.sendNotification("exit");
    } catch {
      // The connection can already be closed after a server crash.
    }

    // Let a well-behaved server consume `exit` before closing its stdin. Killing
    // immediately races vscode-jsonrpc's writer and can surface an EPIPE later.
    try {
      await withDeadline(this.exitPromise, 500, undefined, "LSP exit timed out");
    } catch {
      if (!child.killed) child.kill();
      try {
        await withDeadline(this.exitPromise, 500, undefined, "LSP kill timed out");
      } catch {
        // A dead or unreapable child cannot keep this extension session alive.
      }
    }
    this.connection.dispose();
    this.process = undefined;
  }

  recordPublication(raw) {
    if (!raw || typeof raw !== "object" || typeof raw.uri !== "string") return;
    const previous = this.publications.get(raw.uri);
    const publication = {
      sequence: (previous?.sequence ?? 0) + 1,
      version: typeof raw.version === "number" ? raw.version : undefined,
      diagnostics: normalizeDiagnostics(Array.isArray(raw.diagnostics) ? raw.diagnostics : []),
    };
    this.publications.set(raw.uri, publication);
    const waiters = this.waiters.get(raw.uri) ?? [];
    this.waiters.delete(raw.uri);
    for (const waiter of waiters) waiter.resolve(publication);
  }

  waitForPublication(uri, version, baseline, signal) {
    const current = this.publications.get(uri);
    if (current && current.sequence > baseline) return Promise.resolve(current);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        signal?.removeEventListener("abort", abort);
        this.removeWaiter(uri, waiter);
        resolve(undefined);
      }, DIAGNOSTIC_TIMEOUT_MS);
      const abort = () => {
        clearTimeout(timeout);
        this.removeWaiter(uri, waiter);
        reject(abortError());
      };
      const waiter = {
        resolve: (publication) => {
          clearTimeout(timeout);
          signal?.removeEventListener("abort", abort);
          if (publication.sequence > baseline) resolve(publication);
          else resolve(undefined);
        },
        reject,
      };
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
      const waiters = this.waiters.get(uri) ?? [];
      waiters.push(waiter);
      this.waiters.set(uri, waiters);
    });
  }

  removeWaiter(uri, target) {
    const waiters = this.waiters.get(uri);
    if (!waiters) return;
    const next = waiters.filter((waiter) => waiter !== target);
    if (next.length === 0) this.waiters.delete(uri);
    else this.waiters.set(uri, next);
  }

  rejectWaiters(error) {
    for (const waiters of this.waiters.values()) {
      for (const waiter of waiters) waiter.reject(error);
    }
    this.waiters.clear();
  }
}

function waitForSpawn(child) {
  return new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
}

function normalizeDiagnostics(diagnostics) {
  return diagnostics
    .filter((diagnostic) => diagnostic && typeof diagnostic.message === "string")
    .map((diagnostic) => ({
      severity: Number.isInteger(diagnostic.severity) ? diagnostic.severity : 1,
      message: diagnostic.message.replace(/\s+/g, " ").trim(),
      code: diagnostic.code,
      source: diagnostic.source,
      range: diagnostic.range ?? {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 },
      },
    }));
}

function withDeadline(promise, timeoutMs, signal, timeoutMessage) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, abortError());
    const timer = setTimeout(() => finish(reject, new Error(timeoutMessage)), timeoutMs);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

function abortError() {
  return new DOMException("The operation was aborted", "AbortError");
}
