import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CancellationTokenSource,
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";

const INITIALIZE_TIMEOUT_MS = 8_000;
const DIAGNOSTIC_TIMEOUT_MS = 2_500;
// A cold TypeScript project can take longer to initialize than the regular
// push-publication window. Its custom diagnostics request has its own bound.
const TYPESCRIPT_DIAGNOSTIC_TIMEOUT_MS = 30_000;
// LSP clients are reused for a workspace, so bound per-file protocol state.
const MAX_TRACKED_DOCUMENTS = 128;

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

  constructor({
    command,
    args,
    root,
    serverId,
    initializationOptions,
    signal,
    maxTrackedDocuments = MAX_TRACKED_DOCUMENTS,
  }) {
    this.command = command;
    this.args = args;
    this.root = root;
    this.serverId = serverId;
    this.initializationOptions = initializationOptions;
    this.initializationSignal = signal;
    this.maxTrackedDocuments =
      Number.isInteger(maxTrackedDocuments) && maxTrackedDocuments > 0
        ? maxTrackedDocuments
        : MAX_TRACKED_DOCUMENTS;
    this.documents = new Map();
    this.publications = new Map();
    this.latestPublicationVersions = new Map();
    this.waiters = new Map();
    this.typeScriptDiagnosticsAttempted = new Set();
    this.documentAccess = new Map();
    this.evictedUris = new Map();
    // Keep versions monotonic across evictions so late versioned publications
    // from a closed document cannot be accepted after it is reopened.
    this.nextDocumentVersion = 0;
    this.queue = Promise.resolve();
    this.alive = false;
  }

  async initialize() {
    if (this.initializationSignal?.aborted) throw abortError();
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
        this.clearTrackingState();
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
    // Servers may wait for these optional client requests before starting
    // project diagnostics. Return safe defaults because this extension has no
    // editor configuration or dynamic capability registry to expose.
    this.connection.onRequest("workspace/configuration", (params) =>
      Array.isArray(params?.items) ? params.items.map(() => null) : [],
    );
    this.connection.onRequest("workspace/workspaceFolders", () => [
      {
        uri: pathToFileURL(this.root).href,
        name: this.root.split(/[\\/]/).at(-1) ?? this.root,
      },
    ]);
    this.connection.onRequest("window/workDoneProgress/create", () => null);
    this.connection.onRequest("client/registerCapability", () => null);
    this.connection.onRequest("client/unregisterCapability", () => null);
    this.connection.listen();

    const result = await this.sendRequestWithDeadline(
      "initialize",
      {
        processId: process.pid,
        rootUri: pathToFileURL(this.root).href,
        workspaceFolders: [{ uri: pathToFileURL(this.root).href, name: this.root.split(/[\\/]/).at(-1) ?? this.root }],
        capabilities: {
          workspace: { workspaceFolders: true, configuration: true },
          window: { workDoneProgress: true },
          textDocument: { publishDiagnostics: { versionSupport: true } },
        },
        initializationOptions: this.initializationOptions,
      },
      INITIALIZE_TIMEOUT_MS,
      this.initializationSignal,
      `${this.serverId} initialization timed out`,
    );

    this.capabilities = result?.capabilities ?? {};
    this.connection.sendNotification("initialized", {});
    this.alive = true;
  }

  async sendRequestWithDeadline(method, params, timeoutMs, signal, timeoutMessage) {
    const cancellation = new CancellationTokenSource();
    const cancel = () => cancellation.cancel();
    if (signal?.aborted) cancel();
    else signal?.addEventListener("abort", cancel, { once: true });
    try {
      return await withDeadline(
        this.connection.sendRequest(method, params, cancellation.token),
        timeoutMs,
        signal,
        timeoutMessage,
        cancel,
      );
    } finally {
      signal?.removeEventListener("abort", cancel);
      cancellation.dispose();
    }
  }

  checkDocument(filePath, text, languageId, signal) {
    const task = this.queue.then(() => this.checkDocumentNow(filePath, text, languageId, signal));
    this.queue = task.catch(() => undefined);
    return task;
  }

  async checkDocumentNow(filePath, text, languageId, signal) {
    if (!this.alive) throw new Error(`${this.serverId} is not running`);
    if (signal?.aborted) throw abortError();

    const uri = normalizeDocumentUri(pathToFileURL(filePath).href);
    const baseline = this.publications.get(uri)?.sequence ?? 0;
    const document = this.documents.get(uri);
    const version = ++this.nextDocumentVersion;
    this.evictedUris.delete(uri);
    this.documents.set(uri, { version });
    this.touchDocument(uri);

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

    let typeScriptDiagnostics;
    if (
      !this.typeScriptDiagnosticsAttempted.has(uri) &&
      supportsTypeScriptDiagnostics(this.serverId, this.capabilities)
    ) {
      this.typeScriptDiagnosticsAttempted.add(uri);
      try {
        // typescript-language-server starts its project diagnostics lazily.
        // semanticDiagnosticsSync forces the initial geterr work; its response
        // or resulting publishDiagnostics notification is consumed below.
        const result = await this.sendRequestWithDeadline(
          "workspace/executeCommand",
          {
            command: "typescript.tsserverRequest",
            arguments: ["semanticDiagnosticsSync", { file: uri }],
          },
          TYPESCRIPT_DIAGNOSTIC_TIMEOUT_MS,
          signal,
          "typescript diagnostic request timed out",
        );
        if (
          result?.type === "response" &&
          result.success !== false &&
          Array.isArray(result.body)
        ) {
          typeScriptDiagnostics = normalizeTypeScriptDiagnostics(result.body);
        }
      } catch (error) {
        if (error?.name === "AbortError") this.typeScriptDiagnosticsAttempted.delete(uri);
        // Fall back to the normal pull or push publication path for older or
        // custom TypeScript servers that do not implement this command.
      }
    }

    if (typeScriptDiagnostics) {
      const publication = await this.waitForPublication(
        uri,
        version,
        baseline,
        signal,
      );
      if (publication) return confirmedPublication(publication, version);
      return { status: "confirmed", diagnostics: typeScriptDiagnostics };
    }

    if (this.capabilities.diagnosticProvider) {
      try {
        const result = await this.sendRequestWithDeadline(
          "textDocument/diagnostic",
          { textDocument: { uri } },
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
        // A server may advertise pull diagnostics but reject the request. A
        // fresh push publication remains usable, with a version match checked
        // when the server provides one.
      }
    }

    const publication = await this.waitForPublication(uri, version, baseline, signal);
    if (!publication) {
      return { status: "unconfirmed", diagnostics: [] };
    }
    // PublishDiagnostics.version is optional in LSP. A new publication observed
    // after this document update is the freshest result available; the service
    // separately verifies that the file snapshot did not change while checking.
    return confirmedPublication(publication, version);
  }

  async close() {
    const child = this.process;
    if (!child) {
      this.clearTrackingState();
      return;
    }
    this.alive = false;
    this.rejectWaiters(new Error(`${this.serverId} closed`));
    if (!this.connection) {
      if (!child.killed) child.kill();
      this.process = undefined;
      this.clearTrackingState();
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
    this.clearTrackingState();
  }

  recordPublication(raw) {
    if (!raw || typeof raw !== "object" || typeof raw.uri !== "string") return;
    const uri = normalizeDocumentUri(raw.uri);
    if (this.evictedUris.has(uri) && !this.documents.has(uri)) return;
    const previous = this.publications.get(uri);
    const version = typeof raw.version === "number" ? raw.version : undefined;
    const currentDocument = this.documents.get(uri);
    if (
      currentDocument &&
      version !== undefined &&
      version < currentDocument.version
    ) {
      return;
    }
    const latestVersion = this.latestPublicationVersions.get(uri);
    if (version !== undefined && latestVersion !== undefined && version < latestVersion) {
      return;
    }
    if (version !== undefined) {
      this.latestPublicationVersions.set(uri, Math.max(latestVersion ?? version, version));
    }
    const publication = {
      sequence: (previous?.sequence ?? 0) + 1,
      version,
      diagnostics: normalizeDiagnostics(Array.isArray(raw.diagnostics) ? raw.diagnostics : []),
    };
    this.publications.set(uri, publication);
    this.touchDocument(uri);
    const waiters = this.waiters.get(uri) ?? [];
    const pending = [];
    for (const waiter of waiters) {
      if (publication.version === undefined || publication.version === waiter.version) {
        waiter.resolve(publication);
      } else {
        pending.push(waiter);
      }
    }
    if (pending.length > 0) this.waiters.set(uri, pending);
    else this.waiters.delete(uri);
  }

  waitForPublication(uri, version, baseline, signal, timeoutMs = DIAGNOSTIC_TIMEOUT_MS) {
    const current = this.publications.get(uri);
    if (
      current &&
      current.sequence > baseline &&
      (current.version === undefined || current.version === version)
    ) {
      return Promise.resolve(current);
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        signal?.removeEventListener("abort", abort);
        this.removeWaiter(uri, waiter);
        resolve(undefined);
      }, timeoutMs);
      const abort = () => {
        clearTimeout(timeout);
        this.removeWaiter(uri, waiter);
        reject(abortError());
      };
      const waiter = {
        version,
        resolve: (publication) => {
          clearTimeout(timeout);
          signal?.removeEventListener("abort", abort);
          if (publication.sequence > baseline) resolve(publication);
          else resolve(undefined);
        },
        reject: (error) => {
          clearTimeout(timeout);
          signal?.removeEventListener("abort", abort);
          reject(error);
        },
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

  touchDocument(uri) {
    this.documentAccess.delete(uri);
    this.documentAccess.set(uri, true);
    this.evictDocuments(uri);
  }

  evictDocuments(protectedUri) {
    while (this.documentAccess.size > this.maxTrackedDocuments) {
      let candidate;
      for (const uri of this.documentAccess.keys()) {
        if (uri !== protectedUri && !this.waiters.has(uri)) {
          candidate = uri;
          break;
        }
      }
      if (!candidate) return;
      this.evictDocument(candidate);
    }
  }

  evictDocument(uri) {
    this.documentAccess.delete(uri);
    this.markEvicted(uri);
    if (this.documents.has(uri) && this.alive && this.connection) {
      try {
        this.connection.sendNotification("textDocument/didClose", {
          textDocument: { uri },
        });
      } catch {
        // The server may already be closing; local state is still discarded.
      }
    }
    this.documents.delete(uri);
    this.publications.delete(uri);
    this.latestPublicationVersions.delete(uri);
    this.typeScriptDiagnosticsAttempted.delete(uri);
  }

  markEvicted(uri) {
    this.evictedUris.delete(uri);
    this.evictedUris.set(uri, true);
    while (this.evictedUris.size > this.maxTrackedDocuments) {
      this.evictedUris.delete(this.evictedUris.keys().next().value);
    }
  }

  clearTrackingState() {
    this.documents.clear();
    this.publications.clear();
    this.latestPublicationVersions.clear();
    this.waiters.clear();
    this.typeScriptDiagnosticsAttempted.clear();
    this.documentAccess.clear();
    this.evictedUris.clear();
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

function normalizeDocumentUri(uri) {
  try {
    const filePath = fileURLToPath(uri);
    return pathToFileURL(process.platform === "win32" ? filePath.toLowerCase() : filePath).href;
  } catch {
    return uri;
  }
}

function supportsTypeScriptDiagnostics(serverId, capabilities) {
  const commands = capabilities?.executeCommandProvider?.commands;
  return (
    serverId === "typescript" &&
    Array.isArray(commands) &&
    commands.includes("typescript.tsserverRequest")
  );
}

function confirmedPublication(publication, version) {
  return {
    status:
      publication.version === undefined || publication.version === version
        ? "confirmed"
        : "unconfirmed",
    diagnostics: publication.diagnostics,
  };
}

function normalizeTypeScriptDiagnostics(diagnostics) {
  return normalizeDiagnostics(
    diagnostics.map((diagnostic) => ({
      severity: Number.isInteger(diagnostic?.category) ? diagnostic.category : 1,
      message: diagnostic?.text,
      code: diagnostic?.code,
      source: "typescript",
      range: {
        start: typeScriptPosition(diagnostic?.start),
        end: typeScriptPosition(diagnostic?.end ?? diagnostic?.start),
      },
    })),
  );
}

function typeScriptPosition(position) {
  if (!position || !Number.isInteger(position.line) || !Number.isInteger(position.offset)) {
    return { line: 0, character: 0 };
  }
  return {
    line: Math.max(0, position.line - 1),
    character: Math.max(0, position.offset - 1),
  };
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

function withDeadline(promise, timeoutMs, signal, timeoutMessage, onTimeout) {
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
    const timer = setTimeout(() => {
      onTimeout?.();
      finish(reject, new Error(timeoutMessage));
    }, timeoutMs);
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
