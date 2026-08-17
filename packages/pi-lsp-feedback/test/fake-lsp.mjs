function encode(message) {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

let buffer = Buffer.alloc(0);
const documents = new Map();

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
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        capabilities: {
          textDocumentSync: 1,
          ...(process.env.FAKE_PUSH_ONLY === "1"
            ? {}
            : { diagnosticProvider: {} }),
        },
      },
    });
    return;
  }
  if (message.method === "textDocument/didOpen") {
    documents.set(
      message.params.textDocument.uri,
      message.params.textDocument.text,
    );
    publishIfPushOnly(
      message.params.textDocument.uri,
      message.params.textDocument.text,
    );
    return;
  }
  if (message.method === "textDocument/didChange") {
    const text = message.params.contentChanges.at(-1).text;
    documents.set(message.params.textDocument.uri, text);
    publishIfPushOnly(message.params.textDocument.uri, text);
    return;
  }
  if (message.method === "textDocument/diagnostic") {
    const text = documents.get(message.params.textDocument.uri) ?? "";
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        kind: "full",
        items: text.includes("broken")
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
    return;
  }
  if (message.method === "shutdown") {
    send({ jsonrpc: "2.0", id: message.id, result: null });
    return;
  }
  if (message.method === "exit") process.exit(0);
}

function publishIfPushOnly(uri, text) {
  if (process.env.FAKE_PUSH_ONLY !== "1") return;
  send({
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: {
      uri,
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
