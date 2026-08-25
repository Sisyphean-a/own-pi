import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { FeedbackTracker } from "../src/feedback.js";

function outcome(filePath, diagnostics, status = "confirmed", contentHash = "") {
  return {
    filePath,
    status,
    serverId: "fake-lsp",
    diagnostics,
    contentHash,
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

test("holds a parser cascade until the same snapshot is observed again", () => {
  const filePath = path.join(process.cwd(), "sample.ts");
  const parserCascade = [
    diagnostic(0, "Type expected."),
    diagnostic(1, "'>' expected."),
  ];
  const tracker = new FeedbackTracker({ workspaceRoot: process.cwd() });

  tracker.add("edit-1", outcome(filePath, parserCascade, "confirmed", "snapshot-a"));
  assert.equal(
    tracker.flush({ toolResults: [{ toolCallId: "edit-1" }] }),
    undefined,
  );

  tracker.add("edit-2", outcome(filePath, parserCascade, "confirmed", "snapshot-a"));
  assert.match(
    tracker.flush({ toolResults: [{ toolCallId: "edit-2" }] }),
    /Type expected\./,
  );
});

test("drops a held parser cascade when the next snapshot is clean", () => {
  const filePath = path.join(process.cwd(), "sample.ts");
  const parserCascade = [
    diagnostic(0, "Type expected."),
    diagnostic(1, "'>' expected."),
  ];
  const tracker = new FeedbackTracker({ workspaceRoot: process.cwd() });

  tracker.add("edit-1", outcome(filePath, parserCascade, "confirmed", "snapshot-a"));
  assert.equal(
    tracker.flush({ toolResults: [{ toolCallId: "edit-1" }] }),
    undefined,
  );

  tracker.add("edit-2", outcome(filePath, [], "confirmed", "snapshot-b"));
  assert.equal(
    tracker.flush({ toolResults: [{ toolCallId: "edit-2" }] }),
    undefined,
  );

  tracker.add("edit-3", outcome(filePath, parserCascade, "confirmed", "snapshot-a"));
  assert.equal(
    tracker.flush({ toolResults: [{ toolCallId: "edit-3" }] }),
    undefined,
  );
});

test("holds unconfirmed semantic diagnostics until they repeat", () => {
  const filePath = path.join(process.cwd(), "sample.ts");
  const diagnostics = [diagnostic(0, "Cannot find name 'value'.")];
  const tracker = new FeedbackTracker({ workspaceRoot: process.cwd() });

  tracker.add("edit-1", outcome(filePath, diagnostics, "unconfirmed", "snapshot-a"));
  assert.equal(
    tracker.flush({ toolResults: [{ toolCallId: "edit-1" }] }),
    undefined,
  );

  tracker.add("edit-2", outcome(filePath, diagnostics, "unconfirmed", "snapshot-a"));
  assert.match(
    tracker.flush({ toolResults: [{ toolCallId: "edit-2" }] }),
    /Cannot find name/,
  );
});

test("does not classify an ordinary semantic message as a parser cascade", () => {
  const filePath = path.join(process.cwd(), "sample.ts");
  const tracker = new FeedbackTracker({ workspaceRoot: process.cwd() });

  tracker.add(
    "edit-1",
    outcome(filePath, [diagnostic(0, "Expected 2 arguments, but got 1.")]),
  );
  assert.match(
    tracker.flush({ toolResults: [{ toolCallId: "edit-1" }] }),
    /Expected 2 arguments/,
  );
});
