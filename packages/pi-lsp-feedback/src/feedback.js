import path from "node:path";

const DEFAULT_MAX_DIAGNOSTICS = 20;
const REPORTABLE_SEVERITY = 2;

export class FeedbackTracker {
  constructor({ workspaceRoot, maxDiagnostics = DEFAULT_MAX_DIAGNOSTICS }) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.maxDiagnostics = maxDiagnostics;
    this.pending = new Map();
    this.lastReported = new Map();
  }

  add(toolCallId, outcome) {
    this.pending.set(toolCallId, outcome);
  }

  flush(event) {
    const outcomes = this.selectTurnOutcomes(event);
    this.pending.clear();

    const { content, reported } = this.format(outcomes);
    for (const [filePath, fingerprint] of reported) {
      this.lastReported.set(filePath, fingerprint);
    }
    return content;
  }

  clear() {
    this.pending.clear();
    this.lastReported.clear();
  }

  selectTurnOutcomes(event) {
    const entries = [...this.pending.entries()];
    const toolResults = event?.toolResults;
    const currentToolCallIds = Array.isArray(toolResults)
      ? new Set(toolResults.map((result) => result?.toolCallId).filter(Boolean))
      : undefined;
    const latestByFile = new Map();

    for (const [toolCallId, outcome] of entries) {
      if (currentToolCallIds && !currentToolCallIds.has(toolCallId)) continue;
      latestByFile.set(outcome.filePath, outcome);
    }
    return [...latestByFile.values()];
  }

  format(outcomes) {
    const candidates = [];
    for (const outcome of outcomes) {
      const diagnostics = reportableDiagnostics(outcome);
      if (diagnostics.length === 0) {
        if (outcome.status === "confirmed") this.lastReported.delete(outcome.filePath);
        continue;
      }

      const fingerprint = diagnosticFingerprint(outcome, diagnostics);
      // Rule: unchanged semantic diagnostics are reported once per session.
      // Positions are omitted so parser cascades that move with edits do not
      // repeatedly consume context; counts and messages remain significant.
      if (this.lastReported.get(outcome.filePath) === fingerprint) continue;
      candidates.push({ outcome, diagnostics, fingerprint });
    }

    const diagnostics = candidates
      .flatMap(({ outcome, diagnostics }) =>
        diagnostics.map((diagnostic) => ({ outcome, diagnostic })),
      )
      .slice(0, this.maxDiagnostics);
    if (diagnostics.length === 0) return { content: undefined, reported: new Map() };

    const lines = ["LSP diagnostics after the latest edits:"];
    for (const { outcome, diagnostic } of diagnostics) {
      const location = diagnostic.range?.start;
      const line = location ? location.line + 1 : 1;
      const column = location ? location.character + 1 : 1;
      const level = diagnostic.severity === 1 ? "error" : "warning";
      const code = diagnostic.code === undefined ? "" : ` ${String(diagnostic.code)}`;
      lines.push(
        `- ${this.relative(outcome.filePath)}:${line}:${column} ${level}${code} [${outcome.serverId}]: ${diagnostic.message}`,
      );
    }

    const visibleFiles = new Set(diagnostics.map(({ outcome }) => outcome.filePath));
    const reported = new Map(
      candidates
        .filter(({ outcome }) => visibleFiles.has(outcome.filePath))
        .map(({ outcome, fingerprint }) => [outcome.filePath, fingerprint]),
    );
    return { content: lines.join("\n"), reported };
  }

  relative(filePath) {
    return path.relative(this.workspaceRoot, filePath) || path.basename(filePath);
  }
}

function reportableDiagnostics(outcome) {
  const seen = new Set();
  return outcome.diagnostics
    .filter((diagnostic) => diagnostic.severity <= REPORTABLE_SEVERITY)
    .filter((diagnostic) => {
      const key = diagnosticIdentity(outcome, diagnostic, true);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function diagnosticFingerprint(outcome, diagnostics) {
  return diagnostics
    .map((diagnostic) => diagnosticIdentity(outcome, diagnostic, false))
    .sort()
    .join("\n");
}

function diagnosticIdentity(outcome, diagnostic, includeLocation) {
  const range = diagnostic.range;
  const start = range?.start;
  const end = range?.end;
  return JSON.stringify([
    outcome.serverId ?? "",
    diagnostic.source ?? "",
    diagnostic.severity,
    diagnostic.code === undefined ? "" : String(diagnostic.code),
    normalizeDiagnosticMessage(diagnostic.message),
    includeLocation
      ? [start?.line ?? 0, start?.character ?? 0, end?.line ?? 0, end?.character ?? 0]
      : undefined,
  ]);
}

function normalizeDiagnosticMessage(message) {
  return String(message).replace(/\s+/g, " ").trim();
}
