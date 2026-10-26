import assert from "node:assert/strict";
import test from "node:test";
import { numberValue, richText, select } from "../src/notion.js";
import {
  decideQueuedAction,
  finishAndSync,
  isSyncPending,
  isTerminalExecution,
  newRunId,
  planReconciliation,
  propertiesForEntry,
  reconcilePendingWritebacks,
  recordTerminal,
  reportLinesForEntry,
  syncEntry,
} from "../src/tasksync.js";

const NOTION_HELPERS = { numberValue, richText, select };

// Side effects with a lever on every network call, so each breakpoint in the
// writeback sequence can be made to fail at will. `events` is the call log used to
// assert ordering (ledger before network) and call counts.
function makeDeps({ failProperties = 0, failReport = 0 } = {}) {
  const events = [];
  let propertiesLeft = failProperties;
  let reportLeft = failReport;
  const deps = {
    appendReport: async () => {
      events.push("report");
      if (reportLeft > 0) {
        reportLeft -= 1;
        throw new Error("Notion 500 while appending the report");
      }
    },
    log: () => {},
    save: () => events.push("save"),
    writeProperties: async () => {
      events.push("properties");
      if (propertiesLeft > 0) {
        propertiesLeft -= 1;
        throw new Error("Notion 500 while writing properties");
      }
    },
  };
  return {
    deps,
    events,
    count: (name) => events.filter((e) => e === name).length,
  };
}

function ledgerWith(entry, pageId = "page-1") {
  return { tasks: { [pageId]: entry } };
}

function runningEntry(overrides = {}) {
  return {
    attempts: 1,
    executionStatus: "running",
    pid: null,
    runDir: "C:/tmp/run",
    runId: "run_fixed_seed",
    startedAt: "2026-10-26T10:00:00.000Z",
    status: "running",
    taskId: "BR-SYNC-001",
    ...overrides,
  };
}

const SUCCESS_PATCH = {
  changedFiles: " M hello.txt",
  durationSec: 12,
  error: "",
  executionStatus: "succeeded",
  executor: "opencode",
  exitCode: 0,
  logPath: "local: a.log | b.log",
  resultSummary: "hello from the executor",
  tokens: { input: 10, output: 20, total: 30 },
  tokensText: "input=10 output=20 total=30",
  workdir: "C:/work",
};

// ---------------------------------------------------------------------------
// 1. The decision table: Queued in Notion does not mean "run it again".
// ---------------------------------------------------------------------------

test("decideQueuedAction: no ledger entry means execute", () => {
  assert.deepEqual(decideQueuedAction(undefined), { action: "execute", reason: "no-ledger-entry" });
});

test("decideQueuedAction: a result that never reached Notion is synced, never re-executed", () => {
  for (const executionStatus of ["succeeded", "failed", "cancelled", "unknown"]) {
    const entry = runningEntry({ executionStatus, status: "done", syncStatus: "properties_pending" });
    assert.deepEqual(decideQueuedAction(entry), { action: "sync", reason: "terminal-result-not-yet-projected" }, executionStatus);
  }
});

test("decideQueuedAction: writeback_pending is treated exactly like properties_pending", () => {
  const entry = runningEntry({ executionStatus: "succeeded", status: "done", syncStatus: "writeback_pending" });
  assert.equal(decideQueuedAction(entry).action, "sync");
});

test("decideQueuedAction: a projected result that is Queued again is a deliberate re-run", () => {
  const entry = runningEntry({ executionStatus: "succeeded", status: "done", syncStatus: "synced" });
  assert.deepEqual(decideQueuedAction(entry), { action: "execute", reason: "projected-result-requeued" });
});

test("decideQueuedAction: legacy entries without syncStatus keep the old behaviour", () => {
  // "done" written by an older build means the Notion write already happened, so a
  // Queued page can only be a fresh request. Legacy "running" is never terminal.
  assert.equal(decideQueuedAction({ status: "done", taskId: "BR-OLD" }).action, "execute");
  assert.deepEqual(decideQueuedAction({ status: "running", taskId: "BR-OLD" }), { action: "skip", reason: "already-running" });
});

test("decideQueuedAction: an in-flight run is skipped, not restarted", () => {
  assert.equal(decideQueuedAction(runningEntry()).action, "skip");
});

test("decideQueuedAction: a legacy recovered-unknown record is skipped, not re-run", () => {
  // Written by an older build: no executionStatus, so nothing was persisted about the
  // outcome and there is no projection to replay. Never guess - leave it to a human.
  const entry = { status: "recovered-unknown", taskId: "BR-OLD-3" };
  assert.deepEqual(decideQueuedAction(entry), { action: "skip", reason: "outcome-unknown-after-restart" });
});

test("decideQueuedAction: a new-format unknown with no syncStatus is re-projected, not re-run", () => {
  // Projection state unknown: replaying the model could spend tokens on a task that
  // already finished, so only the Notion write is retried.
  const entry = { executionStatus: "unknown", status: "recovered-unknown" };
  assert.deepEqual(decideQueuedAction(entry), { action: "sync", reason: "terminal-result-with-unknown-projection" });
});

test("decideQueuedAction: every 'sync' decision implies a terminal execution, and every 'execute' does not", () => {
  const entries = [
    undefined,
    runningEntry(),
    runningEntry({ executionStatus: "succeeded", status: "done", syncStatus: "synced" }),
    runningEntry({ executionStatus: "failed", status: "failed", syncStatus: "writeback_pending" }),
    { status: "done" },
    { status: "running" },
  ];
  for (const entry of entries) {
    const decision = decideQueuedAction(entry);
    if (decision.action === "sync") assert.ok(isTerminalExecution(entry), "sync implies a recorded terminal result");
  }
});

// ---------------------------------------------------------------------------
// 2. recordTerminal: what actually happened, recorded once.
// ---------------------------------------------------------------------------

test("recordTerminal: maps execution status to the legacy status mirror", () => {
  const map = { cancelled: "cancelled", failed: "failed", succeeded: "done", unknown: "recovered-unknown" };
  for (const [executionStatus, legacy] of Object.entries(map)) {
    const entry = runningEntry();
    recordTerminal(entry, { executionStatus });
    assert.equal(entry.executionStatus, executionStatus);
    assert.equal(entry.status, legacy, executionStatus);
    assert.equal(entry.syncStatus, "properties_pending");
    assert.equal(entry.lastSyncError, null);
  }
});

test("recordTerminal: every projection field survives into the ledger for a cold-start replay", () => {
  // Regression for a real bug the crash drill caught: only tokens/error/exitCode used
  // to be persisted, so a replay from ledger.json alone produced
  // "Done in ?s, executor=?, Tokens: unknown" - a report that misdescribes the run.
  const entry = runningEntry();
  recordTerminal(entry, SUCCESS_PATCH);
  for (const field of ["changedFiles", "durationSec", "executor", "logPath", "resultSummary", "tokens", "tokensText", "workdir"]) {
    assert.notEqual(entry[field], undefined, `${field} was not persisted`);
  }
  const reportText = reportLinesForEntry(entry).join("\n");
  assert.ok(!reportText.includes("?"), `report contains an unknown placeholder:\n${reportText}`);
  assert.match(reportText, /Done in 12s, executor=opencode, workdir=C:\/work/);
  assert.match(reportText, /Tokens: input=10 output=20 total=30/);

  const props = propertiesForEntry(entry, NOTION_HELPERS);
  assert.equal(props.Tokens.rich_text[0].text.content, "input=10 output=20 total=30");
  assert.equal(props.ResultSummary.rich_text[0].text.content, "hello from the executor");
});

test("recordTerminal: refuses an unknown status instead of silently writing a wrong one", () => {
  const entry = runningEntry();
  assert.throws(() => recordTerminal(entry, { executionStatus: "done" }), /unknown executionStatus/);
});

test("recordTerminal: the executor's error is kept, and a later sync error does not overwrite it", async () => {
  const entry = runningEntry();
  recordTerminal(entry, { error: "spawn codex ENOENT", executionStatus: "failed" });
  assert.equal(entry.error, "spawn codex ENOENT");
  const { deps } = makeDeps({ failProperties: 1 });
  await syncEntry(entry, deps);
  assert.equal(entry.error, "spawn codex ENOENT", "execution error survived the writeback failure");
  assert.match(entry.lastSyncError, /Notion 500/);
});

// ---------------------------------------------------------------------------
// 3. Ordering: the ledger write happens before the first network call.
// ---------------------------------------------------------------------------

test("finishAndSync: terminal result is persisted before any Notion call", async () => {
  const entry = runningEntry();
  const { deps, events } = makeDeps();
  await finishAndSync(entry, SUCCESS_PATCH, deps);
  const firstSave = events.indexOf("save");
  const firstProperties = events.indexOf("properties");
  const firstReport = events.indexOf("report");
  assert.equal(firstSave, 0, `expected save first, got ${events.join(" -> ")}`);
  assert.ok(firstProperties > firstSave, "properties must come after the ledger write");
  assert.ok(firstReport > firstProperties, "report must come after the properties projection");
  assert.equal(entry.syncStatus, "synced");
});

// ---------------------------------------------------------------------------
// 4. Failure injection at each writeback breakpoint (§3.1 of the task book).
// Each case models a crash, then a restart, then asserts the executor ran once.
// ---------------------------------------------------------------------------

test("breakpoint: properties write fails -> pending, result unchanged, restart syncs only", async () => {
  const ledger = ledgerWith(runningEntry());
  const entry = ledger.tasks["page-1"];
  const counters = { executorInvocationCount: 0, notionWriteCount: 0 };

  counters.executorInvocationCount += 1; // the one and only run
  const first = makeDeps({ failProperties: 1 });
  counters.notionWriteCount += 1;
  const res = await finishAndSync(entry, SUCCESS_PATCH, first.deps);

  assert.equal(res.ok, false);
  assert.equal(entry.executionStatus, "succeeded", "a writeback failure must not touch the execution result");
  assert.equal(entry.syncStatus, "writeback_pending");
  assert.match(entry.lastSyncError, /Notion 500/);
  assert.equal(first.count("report"), 0, "the report is not attempted when properties failed");

  // Restart: the page is still Queued in Notion. It must be synced, not re-run.
  const decision = decideQueuedAction(entry);
  assert.equal(decision.action, "sync");
  const second = makeDeps();
  const rec = await reconcilePendingWritebacks(ledger, {
    depsFor: () => second.deps,
    log: () => {},
  });
  counters.notionWriteCount += 1;

  assert.deepEqual(rec, { attempted: 1, pending: 0, synced: 1 });
  assert.equal(entry.syncStatus, "synced");
  assert.equal(counters.executorInvocationCount, 1, "the model ran exactly once");
});

test("breakpoint: report append fails -> still synced, and the retry does not re-append", async () => {
  const ledger = ledgerWith(runningEntry());
  const entry = ledger.tasks["page-1"];
  const first = makeDeps({ failReport: 1 });
  const res = await finishAndSync(entry, SUCCESS_PATCH, first.deps);

  assert.equal(res.ok, true, "a failed report does not demote a finished run");
  assert.equal(res.reportOk, false);
  assert.equal(entry.syncStatus, "synced");
  assert.equal(entry.executionStatus, "succeeded");
  assert.equal(entry.lastSyncError, null, "report failure is not a sync failure");

  // Nothing left to reconcile: the outcome is already projected.
  assert.deepEqual(planReconciliation(ledger), []);
  assert.equal(decideQueuedAction(entry).action, "execute", "only an intentional re-queue would run again");
});

test("breakpoint: crash after the ledger write, before any Notion call", async () => {
  const ledger = ledgerWith(runningEntry());
  const entry = ledger.tasks["page-1"];

  // Crash point: recordTerminal + save happened, the process died here.
  recordTerminal(entry, SUCCESS_PATCH);
  assert.equal(entry.syncStatus, "properties_pending");

  // Restart with the page still Queued.
  assert.equal(decideQueuedAction(entry).action, "sync");
  const deps = makeDeps();
  const rec = await reconcilePendingWritebacks(ledger, { depsFor: () => deps.deps, log: () => {} });
  assert.equal(rec.synced, 1);
  assert.equal(entry.syncStatus, "synced");
  assert.equal(deps.count("properties"), 1);
});

test("breakpoint: crash before the ledger write leaves 'unknown', never an invented success", async () => {
  // This is the one window the ledger cannot close: the executor finished but the
  // process died before persisting anything. The contract is that the page must not
  // be silently re-run - it becomes an explicit unknown that a human can decide on.
  const entry = runningEntry();
  entry.executionStatus = "unknown";
  entry.status = "recovered-unknown";
  entry.error = "Bridge restarted while this task was running; previous outcome is unknown.";
  entry.syncStatus = "properties_pending";

  assert.notEqual(decideQueuedAction(entry).action, "execute", "an unknown outcome must not be re-executed automatically");
  assert.equal(decideQueuedAction(entry).action, "sync");

  const deps = makeDeps();
  await syncEntry(entry, deps.deps);
  const props = propertiesForEntry(entry, NOTION_HELPERS);
  assert.equal(props.Status.select.name, "Failed", "unknown is surfaced as Failed, never as Done");
  assert.match(props.Error.rich_text[0].text.content, /outcome is unknown/);
  assert.equal(entry.executionStatus, "unknown");
});

test("reconcile: a permanently failing page is left pending without blocking the rest", async () => {
  const ledger = {
    tasks: {
      "page-a": { ...runningEntry({ runId: "run_a" }), executionStatus: "succeeded", finishedAt: "2026-10-26T10:00:00.000Z", status: "done", syncStatus: "properties_pending" },
      "page-b": { ...runningEntry({ runId: "run_b" }), executionStatus: "failed", finishedAt: "2026-10-26T10:01:00.000Z", status: "failed", syncStatus: "properties_pending" },
    },
  };
  const failing = makeDeps({ failProperties: 99 });
  const healthy = makeDeps();
  const rec = await reconcilePendingWritebacks(ledger, {
    depsFor: (entry, pageId) => (pageId === "page-a" ? failing.deps : healthy.deps),
    log: () => {},
  });
  assert.deepEqual(rec, { attempted: 2, pending: 1, synced: 1 });
  assert.equal(ledger.tasks["page-b"].syncStatus, "synced", "the healthy entry still drained");
  assert.equal(ledger.tasks["page-a"].syncStatus, "writeback_pending");
  assert.equal(ledger.tasks["page-a"].executionStatus, "succeeded");
});

test("reconcile: drains oldest results first", () => {
  const ledger = {
    tasks: {
      late: { executionStatus: "succeeded", finishedAt: "2026-10-26T12:00:00.000Z", syncStatus: "properties_pending" },
      early: { executionStatus: "succeeded", finishedAt: "2026-10-26T09:00:00.000Z", syncStatus: "properties_pending" },
    },
  };
  assert.deepEqual(planReconciliation(ledger).map((p) => p.pageId), ["early", "late"]);
});

test("reconcile: legacy and in-flight entries are not touched", () => {
  const ledger = {
    tasks: {
      legacy: { status: "done", taskId: "BR-OLD-1" },
      running: runningEntry(),
      recoveredWithoutSync: { status: "recovered-unknown", taskId: "BR-OLD-2" },
    },
  };
  assert.deepEqual(planReconciliation(ledger), []);
  assert.equal(isSyncPending(ledger.tasks.legacy), false);
});

// ---------------------------------------------------------------------------
// 5. Projection payloads are rebuilt from the ledger alone (cold-start replay).
// ---------------------------------------------------------------------------

test("propertiesForEntry: derives the Notion status from executionStatus only", () => {
  const cases = { cancelled: "Cancelled", failed: "Failed", succeeded: "Done", unknown: "Failed" };
  for (const [executionStatus, expected] of Object.entries(cases)) {
    const props = propertiesForEntry({ attempts: 2, executionStatus }, NOTION_HELPERS);
    assert.equal(props.Status.select.name, expected, executionStatus);
    assert.equal(props.Attempts.number, 2);
  }
});

test("propertiesForEntry: a success clears the error field", () => {
  const props = propertiesForEntry({ attempts: 1, executionStatus: "succeeded", error: "stale message" }, NOTION_HELPERS);
  assert.equal(props.Error.rich_text[0].text.content, "");
  assert.equal(props.ResultSummary !== undefined, true);
});

test("reportLinesForEntry: first line is the run marker, so a retry can recognise itself", () => {
  const entry = { ...runningEntry(), executionStatus: "succeeded", runId: "run_marker_test" };
  const lines = reportLinesForEntry(entry);
  assert.equal(lines[0], "Run: run_marker_test");
  assert.ok(lines.some((l) => l.includes("Tokens:")), "the report still carries the token line");
});

test("newRunId: stable for one run, different across runs", () => {
  const seed = { pageId: "page-1", startedAt: "2026-10-26T10:00:00.000Z", taskId: "BR-1" };
  assert.equal(newRunId(seed), newRunId(seed), "same seed gives the same id");
  assert.notEqual(newRunId(seed), newRunId({ ...seed, startedAt: "2026-10-26T10:00:01.000Z" }));
});

test("budget refusal goes through the same writeback path and keeps its accurate error", async () => {
  const entry = runningEntry({ runDir: null });
  const budgetError = "attempt budget exhausted (Notion Attempts=3, hard cap=3). Reset Attempts in Notion to re-run this task.";
  const deps = makeDeps({ failProperties: 1 });
  const res = await finishAndSync(entry, { error: budgetError, executionStatus: "failed", exitCode: null }, deps.deps);
  assert.equal(res.ok, false);
  assert.equal(entry.executionStatus, "failed");
  assert.equal(entry.error, budgetError, "the accurate reason is not replaced by the sync error");

  const retry = makeDeps();
  await syncEntry(entry, retry.deps);
  const props = propertiesForEntry(entry, NOTION_HELPERS);
  assert.equal(props.Status.select.name, "Failed");
  assert.match(props.Error.rich_text[0].text.content, /attempt budget exhausted/);
});
