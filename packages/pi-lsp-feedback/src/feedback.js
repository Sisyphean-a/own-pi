import path from "node:path";

const DEFAULT_MAX_DIAGNOSTICS = 20;
const REPORTABLE_SEVERITY = 2;
const PARSER_CASCADE_MIN_DIAGNOSTICS = 2;
const PARSE_DIAGNOSTIC_PATTERNS = [
  /^(?:type|identifier|expression|property assignment|declaration or statement|operator|class member)\s+expected\.?$/i,
  /^[^a-z0-9]*expected\.?$/i,
  /^unterminated\b/i,
  /^unexpected token\b/i,
  /\bno corresponding closing tag\b/i,
  /^invalid syntax\b/i,
];

export class FeedbackTracker {
  constructor({ workspaceRoot, maxDiagnostics = DEFAULT_MAX_DIAGNOSTICS }) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.maxDiagnostics = maxDiagnostics;
    this.pending = new Map();
    this.lastReported = new Map();
    this.stabilityCandidates = new Map();
    this.stabilizedDiagnostics = new Map();
  }

  add(toolCallId, outcome) {
    this.pending.set(toolCallId, outcome);
  }

  flush(event) {
    const entries = this.selectTurnEntries(event);
    this.pending.clear();
    for (const [, outcome] of entries) this.observeOutcome(outcome);

    const { content, reported } = this.format(this.latestOutcomes(entries));
    for (const [filePath, fingerprint] of reported) {
      this.lastReported.set(filePath, fingerprint);
    }
    return content;
  }

  clear() {
    this.pending.clear();
    this.lastReported.clear();
    this.stabilityCandidates.clear();
    this.stabilizedDiagnostics.clear();
  }

  selectTurnOutcomes(event) {
    return this.latestOutcomes(this.selectTurnEntries(event));
  }

  selectTurnEntries(event) {
    const entries = [...this.pending.entries()];
    const toolResults = event?.toolResults;
    const currentToolCallIds = Array.isArray(toolResults)
      ? new Set(toolResults.map((result) => result?.toolCallId).filter(Boolean))
      : undefined;
    return entries
      .filter(([toolCallId]) => !currentToolCallIds || currentToolCallIds.has(toolCallId))
      .sort(([, left], [, right]) => compareEditSequence(left, right));
  }

  latestOutcomes(entries) {
    const latestByFile = new Map();
    for (const [, outcome] of entries) {
      const previous = latestByFile.get(outcome.filePath);
      if (!previous || isLaterOutcome(previous, outcome)) {
        latestByFile.set(outcome.filePath, outcome);
      }
    }
    return [...latestByFile.values()];
  }

  observeOutcome(outcome) {
    // Rule: uncertain freshness and parser cascades stay local until the same
    // content snapshot produces the same diagnostic set again.
    const diagnostics = reportableDiagnostics(outcome);
    const unstable = unstableDiagnostics(outcome, diagnostics);
    if (unstable.length === 0) {
      this.stabilityCandidates.delete(outcome.filePath);
      this.stabilizedDiagnostics.delete(outcome.filePath);
      return;
    }

    const fingerprint = stabilityFingerprint(outcome, unstable);
    if (this.stabilityCandidates.get(outcome.filePath) === fingerprint) {
      this.stabilizedDiagnostics.set(outcome.filePath, fingerprint);
    } else {
      this.stabilityCandidates.set(outcome.filePath, fingerprint);
      this.stabilizedDiagnostics.delete(outcome.filePath);
    }
  }

  format(outcomes) {
    const candidates = [];
    for (const outcome of outcomes) {
      const allDiagnostics = reportableDiagnostics(outcome);
      const diagnostics = visibleDiagnostics(
        outcome,
        allDiagnostics,
        this.stabilizedDiagnostics,
      );
      if (diagnostics.length === 0) {
        // Held diagnostics are not evidence that the file is clean. Only a
        // confirmed empty result may clear the session-level dedupe state.
        if (allDiagnostics.length === 0 && outcome.status === "confirmed") {
          this.lastReported.delete(outcome.filePath);
        }
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

function compareEditSequence(left, right) {
  if (Number.isInteger(left.editSequence) && Number.isInteger(right.editSequence)) {
    return left.editSequence - right.editSequence;
  }
  return 0;
}

function isLaterOutcome(previous, next) {
  if (Number.isInteger(previous.editSequence) && Number.isInteger(next.editSequence)) {
    return next.editSequence >= previous.editSequence;
  }
  return true;
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

function visibleDiagnostics(outcome, diagnostics, stabilizedDiagnostics) {
  const unstable = unstableDiagnostics(outcome, diagnostics);
  if (unstable.length === 0) return diagnostics;

  const fingerprint = stabilityFingerprint(outcome, unstable);
  if (stabilizedDiagnostics.get(outcome.filePath) === fingerprint) return diagnostics;

  const held = new Set(unstable);
  return diagnostics.filter((diagnostic) => !held.has(diagnostic));
}

function unstableDiagnostics(outcome, diagnostics) {
  if (outcome.status !== "confirmed") return diagnostics;
  const parseDiagnostics = diagnostics.filter(isLikelyParseDiagnostic);
  return parseDiagnostics.length >= PARSER_CASCADE_MIN_DIAGNOSTICS
    ? parseDiagnostics
    : [];
}

function isLikelyParseDiagnostic(diagnostic) {
  const message = normalizeDiagnosticMessage(diagnostic.message);
  return PARSE_DIAGNOSTIC_PATTERNS.some((pattern) => pattern.test(message));
}

function stabilityFingerprint(outcome, diagnostics) {
  return JSON.stringify([
    outcome.contentHash ?? "",
    diagnosticFingerprint(outcome, diagnostics),
  ]);
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
