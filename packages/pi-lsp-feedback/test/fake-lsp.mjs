function encode(message) {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

let buffer = Buffer.alloc(0);
const documents = new Map();
const pendingClientRequests = new Map();
let nextClientRequestId = 1;
let clientRequestsReady = process.env.FAKE_REQUIRE_CLIENT_REQUESTS !== "1";

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const boundary = buffer.indexOf("\r\n\r\n");
    if (boundary < 0) return;
    const header = buffer.subarray(0, boundary).toString("utf8");
    const length = Number.parseInt(
      /Content-Length:\s*(\d+)/i.exec(header)?.[1] ?? "0",
      10,
    );
    const end = boundary + 4 + length;
    if (buffer.length < end) return;
    const raw = buffer.subarray(boundary + 4, end).toString("utf8");
    buffer = buffer.subarray(end);
    handle(JSON.parse(raw));
  }
});

function send(message) {
  process.stdout.write(encode(message));
}

function handle(message) {
  if (message.id !== undefined && !message.method) {
    const onResponse = pendingClientRequests.get(message.id);
    if (onResponse) {
      pendingClientRequests.delete(message.id);
      onResponse(message);
    }
    return;
  }
  if (message.method === "initialize") {
    const response = {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        capabilities: {
          textDocumentSync: 1,
          ...(process.env.FAKE_PUSH_ONLY === "1"
            ? {}
            : { diagnosticProvider: {} }),
          ...(process.env.FAKE_TS_SERVER_REQUEST === "1"
            ? { executeCommandProvider: { commands: ["typescript.tsserverRequest"] } }
            : {}),
        },
      },
    };
    const delay = Number.parseInt(process.env.FAKE_INITIALIZE_DELAY_MS ?? "0", 10);
    if (delay > 0) setTimeout(() => send(response), delay);
    else send(response);
    if (process.env.FAKE_REQUIRE_CLIENT_REQUESTS === "1") {
      requestClient("workspace/configuration", { items: [{}] });
      requestClient("window/workDoneProgress/create", { token: "fake" });
    }
    return;
  }
  if (message.method === "textDocument/didOpen") {
    documents.set(
      message.params.textDocument.uri,
      message.params.textDocument.text,
    );
    if (process.env.FAKE_VERSIONED_REORDER === "1") {
      const { uri, text, version } = message.params.textDocument;
      publish(uri, text, version - 1);
      setTimeout(() => publish(uri, text, version), 50);
    } else if (process.env.FAKE_COMMAND_ONLY !== "1") {
      publishIfPushOnly(
        message.params.textDocument.uri,
        message.params.textDocument.text,
      );
    }
    return;
  }
  if (message.method === "textDocument/didChange") {
    const text = message.params.contentChanges.at(-1).text;
    documents.set(message.params.textDocument.uri, text);
    if (process.env.FAKE_COMMAND_ONLY !== "1") {
      publishIfPushOnly(message.params.textDocument.uri, text);
    }
    return;
  }
  if (message.method === "workspace/executeCommand") {
    const uri = [...documents.keys()][0];
    const text = uri ? documents.get(uri) ?? "" : "";
    const body = text.includes("broken")
      ? [
          {
            start: { line: 1, offset: 1 },
            end: { line: 1, offset: 7 },
            text: "broken source",
            code: "FAKE100",
            category: 1,
          },
        ]
      : [];
    send({ jsonrpc: "2.0", id: message.id, result: { type: "response", body } });
    if (
      process.env.FAKE_TS_SERVER_REQUEST === "1" &&
      process.env.FAKE_COMMAND_RESPONSE_ONLY !== "1" &&
      uri
    ) {
      publishIfPushOnly(uri, text);
    }
    return;
  }
  if (message.method === "textDocument/diagnostic") {
    const text = documents.get(message.params.textDocument.uri) ?? "";
    const items = process.env.FAKE_PULL_EMPTY === "1"
      ? []
      : text.includes("parse-cascade")
        ? [
          {
            severity: 1,
            code: 1005,
            source: "fake-lsp",
            message: "Type expected.",
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 1 },
            },
          },
          {
            severity: 1,
            code: 1005,
            source: "fake-lsp",
            message: "'>' expected.",
            range: {
              start: { line: 0, character: 1 },
              end: { line: 0, character: 2 },
            },
          },
        ]
      : text.includes("broken")
        ? [
            {
              severity: 1,
              code: "FAKE100",
              source: "fake-lsp",
              message: "broken source",
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 6 },
              },
            },
          ]
        : [];
    const response = {
      jsonrpc: "2.0",
      id: message.id,
      result: { kind: "full", items },
    };
    const delay = Number.parseInt(process.env.FAKE_DIAGNOSTIC_DELAY_MS ?? "0", 10);
    if (delay > 0) setTimeout(() => send(response), delay);
    else send(response);
    return;
  }
  if (message.method === "shutdown") {
    send({ jsonrpc: "2.0", id: message.id, result: null });
    return;
  }
  if (message.method === "exit") process.exit(0);
}

function publishIfPushOnly(uri, text) {
  if (process.env.FAKE_PUSH_ONLY !== "1" || !clientRequestsReady) return;
  publish(uri, text);
}

function requestClient(method, params) {
  const id = `client-request-${nextClientRequestId++}`;
  pendingClientRequests.set(id, () => {
    if (pendingClientRequests.size === 0) {
      clientRequestsReady = true;
      for (const [uri, text] of documents) publishIfPushOnly(uri, text);
    }
  });
  send({ jsonrpc: "2.0", id, method, params });
}

function publish(uri, text, version) {
  send({
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: {
      uri,
      ...(version === undefined ? {} : { version }),
      diagnostics: text.includes("broken")
        ? [
            {
              severity: 1,
              code: "FAKE100",
              source: "fake-lsp",
              message: "broken source",
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 6 },
              },
            },
          ]
        : [],
    },
  });
}
