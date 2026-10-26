// The ledger is the execution source of truth; Notion is a retryable projection.
//
// Why this module exists: before it, "did this task run?" had two answers that could
// disagree. The successful path wrote Notion first, then the ledger. Any failure in
// between left Notion saying Done (or still Queued) while the ledger said running, so
// the next poll could hand the same page to the executor a second time and spend model
// tokens again. Nothing in the old code could tell "Notion is stale" apart from
// "a human re-queued this task on purpose".
//
// The split here is deliberate:
//   - the planning functions are pure (no I/O) so the decision table is unit-testable;
//   - the writeback orchestration takes its side effects as `deps`, so a test can make
//     each network call fail at a chosen point without touching src/ or the network.
//
// Invariants this file is responsible for:
//   1. recordTerminal() + save() happen BEFORE the first network call for that result.
//   2. A writeback failure may only move syncStatus. executionStatus is never rewritten.
//   3. A queued page whose result has not been projected yet gets synced, not executed.

export const TERMINAL_EXECUTION_STATUSES = ["succeeded", "failed", "cancelled", "unknown"];

// Notion's Status is a display value; it is derived from executionStatus, never from
// "did the writeback work". Keeping the mapping here means a sync retry cannot
// accidentally promote or demote the run.
const NOTION_STATUS_FOR = {
  cancelled: "Cancelled",
  failed: "Failed",
  succeeded: "Done",
  unknown: "Failed",
};

// Ledger entries written before this round have no syncStatus at all. The old code
// wrote the Notion status first and the ledger second, so a legacy terminal record
// means the projection already happened; replaying it would be wrong. Legacy
// "running" is intentionally NOT terminal here - recoverRunning() owns that path.
const LEGACY_STATUS_TO_EXECUTION = {
  cancelled: "cancelled",
  done: "succeeded",
  failed: "failed",
};

const EXECUTION_TO_LEGACY_STATUS = {
  cancelled: "cancelled",
  failed: "failed",
  succeeded: "done",
  unknown: "recovered-unknown",
};

export function isTerminalExecution(entry) {
  return Boolean(entry) && TERMINAL_EXECUTION_STATUSES.includes(entry.executionStatus);
}

export function isSyncPending(entry) {
  if (!entry) return false;
  return entry.syncStatus === "properties_pending" || entry.syncStatus === "writeback_pending";
}

export function isLegacyTerminal(entry) {
  if (!entry || entry.syncStatus !== undefined) return false;
  return Object.prototype.hasOwnProperty.call(LEGACY_STATUS_TO_EXECUTION, entry.status);
}

// The single decision for "this page is Queued in Notion - now what?".
// The hard case is telling these two apart:
//   (a) the result never reached Notion  -> sync only, never run the model again;
//   (b) a human deliberately set the page back to Queued after a finished run
//       (the "reset Attempts to re-run" workflow) -> running again is intended.
// They are distinguished by syncStatus: once the projection landed, a Queued page
// can only be a fresh request. While it is still pending, Queued is just stale state.
export function decideQueuedAction(entry) {
  if (!entry) return { action: "execute", reason: "no-ledger-entry" };
  if (entry.status === "running") return { action: "skip", reason: "already-running" };
  if (isSyncPending(entry)) return { action: "sync", reason: "terminal-result-not-yet-projected" };
  if (isLegacyTerminal(entry)) return { action: "execute", reason: "legacy-terminal-requeued" };
  // New-format terminal record with no syncStatus at all: the projection state is
  // unknown. Re-running could spend tokens on a task that already succeeded, so the
  // safe move is to replay the projection, not the model.
  if (isTerminalExecution(entry) && entry.syncStatus === undefined) {
    return { action: "sync", reason: "terminal-result-with-unknown-projection" };
  }
  if (isTerminalExecution(entry)) return { action: "execute", reason: "projected-result-requeued" };
  if (entry.status === "recovered-unknown") return { action: "skip", reason: "outcome-unknown-after-restart" };
  return { action: "execute", reason: "no-terminal-result" };
}

// Everything the startup/ poll reconciliation should retry, oldest result first so a
// backlog drains in the order the runs actually happened.
export function planReconciliation(ledger) {
  const plan = [];
  for (const [pageId, entry] of Object.entries(ledger?.tasks ?? {})) {
    if (!isSyncPending(entry)) continue;
    plan.push({ entry, pageId });
  }
  plan.sort((a, b) => String(a.entry.finishedAt ?? "").localeCompare(String(b.entry.finishedAt ?? "")));
  return plan;
}

// Stable for the whole life of one run: created when the run starts, never regenerated
// on a retry. Deterministic on purpose - the report marker and the "have we already
// appended this report?" check both key off it, so it has to be reproducible from the
// ledger for a cold-start replay. `attempt` is part of the seed so a genuine re-queue
// of the same page never reuses the previous run's marker.
export function newRunId({ attempt, pageId, taskId, startedAt } = {}) {
  const stamp = startedAt ?? new Date().toISOString();
  const seed = `${taskId ?? "task"}|${pageId ?? "local"}|${stamp}|${attempt ?? 0}`;
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) % 0xffffffff;
  }
  return `run_${hash.toString(36)}`;
}

// Fields the projection needs. They live on the ledger entry so a cold start can
// rebuild the exact same Notion write (and the same report text) from ledger.json
// alone. Without this the replay ran with an empty task object and produced
// "Done in ?s, executor=?, Tokens: unknown" - a report that lies about what happened.
const PROJECTION_FIELDS = [
  "attempts",
  "changedFiles",
  "durationSec",
  "error",
  "executor",
  "exitCode",
  "logPath",
  "promptIgnoredBlocks",
  "resultPath",
  "resultSummary",
  "tokens",
  "tokensText",
  "workdir",
];

// Terminal result lands in the ledger. status is kept as a legacy mirror because the
// existing readers (recoverRunning, the tests, anyone reading ledger.json by hand)
// still speak it.
export function recordTerminal(entry, patch) {
  const { executionStatus } = patch;
  if (!TERMINAL_EXECUTION_STATUSES.includes(executionStatus)) {
    throw new Error(`recordTerminal: unknown executionStatus ${executionStatus}`);
  }
  entry.executionStatus = executionStatus;
  entry.status = EXECUTION_TO_LEGACY_STATUS[executionStatus];
  entry.syncStatus = "properties_pending";
  entry.finishedAt = patch.finishedAt ?? new Date().toISOString();
  entry.lastSyncError = null;
  for (const field of PROJECTION_FIELDS) {
    if (patch[field] !== undefined) entry[field] = patch[field];
  }
  return entry;
}

export function markSynced(entry) {
  entry.syncStatus = "synced";
  entry.lastSyncError = null;
  return entry;
}

export function markWritebackError(entry, message) {
  entry.syncStatus = "writeback_pending";
  entry.lastSyncError = String(message ?? "unknown writeback error");
  return entry;
}

// Project one terminal result to Notion. Never changes what actually happened.
// Order: properties (the projection that matters) -> report (commentary) -> synced.
// Report failure is logged and does NOT demote a synced result: the report is not
// the outcome, and failing it again on the next poll would keep a finished task
// permanently "pending".
export async function syncEntry(entry, deps) {
  const label = entry.taskId || "unknown";
  try {
    await deps.writeProperties(entry);
  } catch (err) {
    markWritebackError(entry, err?.message ?? String(err));
    deps.save();
    deps.log(
      `writeback: ${label}: Notion properties failed (${entry.lastSyncError}); ` +
        `execution stays ${entry.executionStatus}, will retry sync only (never re-run)`,
    );
    return { error: entry.lastSyncError, ok: false, reportOk: null };
  }

  let reportOk = true;
  try {
    await deps.appendReport(entry);
  } catch (err) {
    reportOk = false;
    deps.log(`writeback: ${label}: report append failed (${err?.message ?? err}); properties already synced, task outcome unchanged`);
  }

  markSynced(entry);
  deps.save();
  deps.log(`writeback: ${label}: synced (execution=${entry.executionStatus}, report=${reportOk ? "written" : "failed"})`);
  return { ok: true, reportOk };
}

// Startup and pre-poll pass: finish the projections that a crash or a Notion outage
// left behind. It only ever calls syncEntry, so "reconcile" structurally cannot reach
// an executor. A failing entry is logged and skipped - one unreachable page must not
// stall the rest of the queue.
export async function reconcilePendingWritebacks(ledger, { depsFor, log }) {
  const plan = planReconciliation(ledger);
  if (!plan.length) return { attempted: 0, pending: 0, synced: 0 };
  if (log) log(`reconcile: ${plan.length} terminal result(s) waiting for Notion writeback (no executor call)`);
  let pending = 0;
  let synced = 0;
  for (const { entry, pageId } of plan) {
    try {
      const res = await syncEntry(entry, depsFor(entry, pageId));
      if (res.ok) synced += 1;
      else pending += 1;
    } catch (err) {
      pending += 1;
      if (log) log(`reconcile: ${entry.taskId || pageId}: ${err?.message ?? err}`);
    }
  }
  return { attempted: plan.length, pending, synced };
}

// The one entry point the bridge uses for a finished run. Recording the result and
// persisting it happen before any network call, because that is the only ordering
// in which a crash or a Notion outage cannot turn a finished run into a re-run.
export async function finishAndSync(entry, patch, deps) {
  recordTerminal(entry, patch);
  deps.save();
  return syncEntry(entry, deps);
}

// ---------------------------------------------------------------------------
// Projection payloads.
//
// These read only from the ledger entry, never from the in-memory task. That is what
// makes a writeback retryable from a cold start: if the process dies after the result
// is persisted, the next start can rebuild the exact same Notion write from ledger.json
// alone, with no task object and no second model call.
// ---------------------------------------------------------------------------

export function propertiesForEntry(entry, { numberValue, richText, select }) {
  const status = NOTION_STATUS_FOR[entry.executionStatus] ?? "Failed";
  const props = {
    Error: richText(entry.executionStatus === "succeeded" ? "" : (entry.error ?? "")),
    Status: select(status),
  };
  if (entry.attempts !== null && entry.attempts !== undefined) props.Attempts = numberValue(entry.attempts);
  if (entry.executionStatus === "succeeded") {
    props.ChangedFiles = richText(String(entry.changedFiles ?? ""));
    props.LogPath = richText(String(entry.logPath ?? ""));
    props.ResultSummary = richText(String(entry.resultSummary ?? ""));
    props.Tokens = richText(String(entry.tokensText ?? ""));
  } else if (entry.executionStatus === "failed" || entry.executionStatus === "unknown") {
    if (entry.logPath) props.LogPath = richText(String(entry.logPath));
    if (entry.tokensText) props.Tokens = richText(String(entry.tokensText));
  }
  return props;
}

// The first line is the run marker. appendReport uses it to refuse a second append of
// the same run, which is what makes "properties succeeded, report crashed, poll again"
// safe. It sits after the divider, so it never becomes part of a prompt.
export function reportLinesForEntry(entry) {
  const lines = [`Run: ${entry.runId ?? "unmarked"}`];
  const duration = entry.durationSec ?? "?";
  if (entry.executionStatus === "succeeded") {
    lines.push(`AI Bridge result: Done in ${duration}s, executor=${entry.executor ?? "?"}, workdir=${entry.workdir ?? "?"}.`);
    lines.push(`Tokens: ${entry.tokensText ?? "unknown"}.`);
    lines.push(`Changed files (git status): ${String(entry.changedFiles ?? "").slice(0, 1500)}`);
    lines.push(`Local logs (on the Windows machine, not in Notion): ${entry.logPath ?? ""}`);
    lines.push(`Output (tail): ${String(entry.resultSummary ?? "").slice(0, 1500)}`);
    if (entry.promptIgnoredBlocks) {
      lines.push(`Prompt note: ${entry.promptIgnoredBlocks} block(s) after the divider were NOT part of this run's instructions.`);
    }
  } else if (entry.executionStatus === "cancelled") {
    lines.push(`AI Bridge result: Cancelled after ${duration}s.`);
    lines.push(`Local logs (on the Windows machine, not in Notion): ${entry.logPath ?? ""}`);
  } else {
    lines.push(`AI Bridge result: Failed${entry.durationSec ? ` after ${duration}s` : ""}.`);
    lines.push(`Error (original, truncated): ${String(entry.error ?? "").slice(0, 1500)}`);
    if (entry.logPath) lines.push(`Local logs (on the Windows machine, not in Notion): ${entry.logPath}`);
  }
  return lines;
}
