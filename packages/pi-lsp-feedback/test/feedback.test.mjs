import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { FeedbackTracker } from "../src/feedback.js";

function outcome(filePath, diagnostics, status = "confirmed") {
  return {
    filePath,
    status,
    serverId: "fake-lsp",
    diagnostics,
  };
}

function diagnostic(line, message = "broken source") {
  return {
    severity: 1,
    code: "FAKE100",
    source: "fake-lsp",
    message,
    range: {
      start: { line, character: 0 },
      end: { line, character: 6 },
    },
  };
}

test("removes exact duplicate diagnostics and ignores position-only changes", () => {
  const filePath = path.join(process.cwd(), "sample.ts");
  const tracker = new FeedbackTracker({ workspaceRoot: process.cwd() });

  tracker.add(
    "edit-1",
    outcome(filePath, [diagnostic(0), diagnostic(0)]),
  );
  const first = tracker.flush({ toolResults: [{ toolCallId: "edit-1" }] });
  assert.equal(first.split("\n").filter((line) => line.startsWith("- ")).length, 1);

  tracker.add("edit-2", outcome(filePath, [diagnostic(20)]));
  assert.equal(tracker.flush({ toolResults: [{ toolCallId: "edit-2" }] }), undefined);
});

test("does not flush an outcome belonging to another turn", () => {
  const filePath = path.join(process.cwd(), "sample.ts");
  const tracker = new FeedbackTracker({ workspaceRoot: process.cwd() });

  tracker.add("late-edit", outcome(filePath, [diagnostic(0)]));
  assert.equal(tracker.flush({ toolResults: [{ toolCallId: "bash-1" }] }), undefined);

  tracker.add("current-edit", outcome(filePath, [diagnostic(0)]));
  assert.match(
    tracker.flush({ toolResults: [{ toolCallId: "current-edit" }] }),
    /sample\.ts:1:1 error FAKE100/,
  );
});
