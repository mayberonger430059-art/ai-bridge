import fs from "node:fs";
import path from "node:path";
import { assertExecutor, assertWorkdir, loadConfig, redact } from "./config.js";
import { executeTask, formatTokens } from "./executors.js";
import { killTreeByPid } from "./killtree.js";
import { AttemptTracker } from "./attempts.js";
import { acquireSingleInstanceLock } from "./lock.js";
import { evaluateApprovalGate } from "./gate.js";
import { isPidAlive, loadLedger, saveLedger } from "./ledger.js";
import { NotionClient, numberValue, richText, select } from "./notion.js";
import {
  decideQueuedAction,
  finishAndSync,
  isTerminalExecution,
  newRunId,
  propertiesForEntry,
  reconcilePendingWritebacks,
  reportLinesForEntry,
  syncEntry,
} from "./tasksync.js";

const log = (...args) => console.log(new Date().toISOString(), ...args.map((a) => redact(String(a))));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Side effects for the writeback state machine, injected so src/tasksync.js stays
// testable and so every retry path (live run, startup reconcile, poll reconcile)
// goes through exactly one implementation.
function syncDepsFor({ config, entry, ledger, notion, pageId }) {
  return {
    appendReport: async (target) => {
      const res = await notion.appendReport(pageId, reportLinesForEntry(target), { runMarker: target.runId });
      if (res?.skipped) log(`writeback: ${target.taskId || pageId}: report for this run already present, not appended again`);
    },
    log,
    save: () => saveLedger(config.dataDir, ledger),
    writeProperties: (target) => notion.updatePage(pageId, propertiesForEntry(target, { numberValue, richText, select })),
  };
}

// Startup and pre-poll pass: finish the projections that a crash or a Notion outage
// left behind. This never invokes an executor - that is the whole point. The loop
// itself lives in tasksync.js so it has an automated regression.
async function reconcileWritebacks({ config, ledger, notion }) {
  return reconcilePendingWritebacks(ledger, {
    depsFor: (entry, pageId) => syncDepsFor({ config, entry, ledger, notion, pageId }),
    log,
  });
}

// A report is commentary on the outcome, not the outcome. appendReport goes through
// Notion's paginated block API, so it can throw for reasons that say nothing about
// the task; letting that bubble turned a task that really finished into Status=Failed
// (the status was already written) and left the ledger on "running", so the next
// start re-marked it Failed again. Every call site goes through here.
async function appendReportSafe(notion, pageId, lines, label) {
  if (!notion || !pageId) return;
  try {
    await notion.appendReport(pageId, lines);
  } catch (err) {
    log(`report append failed for ${label || pageId}: ${err.message}; task outcome unchanged`);
  }
}

function runDirFor(config, taskId) {
  const safe = String(taskId || "unknown").replace(/[^A-Za-z0-9_-]/g, "_");
  return path.join(config.dataDir, "runs", `${new Date().toISOString().slice(0, 10)}_${safe}`);
}

async function recoverRunning(config, notion) {
  const ledger = loadLedger(config.dataDir);
  let changed = false;
  for (const [pageId, entry] of Object.entries(ledger.tasks)) {
    if (entry.status !== "running") continue;
    if (entry.pid && isPidAlive(entry.pid)) {
      log(`recovery: task ${entry.taskId} still has live pid ${entry.pid}, leaving it alone (stop the old bridge first)`);
      continue;
    }
    // Outcome unknown after restart: never invent success, never silently re-run.
    // It becomes a terminal "unknown" that still goes through the normal writeback
    // queue, so a Notion outage here cannot leave the page Queued and re-executable.
    entry.executionStatus = "unknown";
    entry.status = "recovered-unknown";
    entry.error = "Bridge restarted while this task was running; previous outcome is unknown. Check the local log, then re-queue only if you want a fresh run.";
    entry.finishedAt = new Date().toISOString();
    entry.syncStatus = "properties_pending";
    changed = true;
    log(`recovery: task ${entry.taskId} was running at shutdown, outcome unknown, marking Failed in Notion`);
    if (notion) {
      try {
        await syncEntry(entry, syncDepsFor({ config, entry, ledger, notion, pageId }));
      } catch (err) {
        log(`recovery writeback failed for ${entry.taskId}: ${err.message}`);
      }
    }
  }
  if (changed) saveLedger(config.dataDir, ledger);
  return ledger;
}

async function runOneTask({ config, notion, task, ledger }) {
  // Approval gate (requirement 4): write tasks need an explicit Approved in Notion.
  if (evaluateApprovalGate(task) === "needs-approval") {
    log(`gate: ${task.taskId} needs approval (WriteMode=write, Approval=${task.approval || "empty"}), moving to NeedsApproval, NOT executing`);
    if (notion) {
      await notion.updatePage(task.notionPageId, { Status: select("NeedsApproval") });
      await appendReportSafe(notion, task.notionPageId, [
        "AI Bridge gate: this task requests file writes but Approval is not 'Approved'.",
        "To proceed, set Approval = Approved in Notion (the bridge will pick it up on the next poll). To abandon, set Status = Cancelled.",
        "NOTE: this divider separates instructions from execution history. Anything you add to the page body AFTER it is not read as part of the prompt -- edit the text above the divider instead.",
      ], task.taskId);
    }
    return { outcome: "needs-approval" };
  }

  const workdir = assertWorkdir(config, task.workdir);
  const executor = assertExecutor(config, task.executor);
  const fullTask = { ...task, executor, workdir };
  const runDir = runDirFor(config, task.taskId || task.notionPageId || "local");
  // Review item 5: Attempts now equals real executor invocations. The
  // tracker is created before the loop; next() is called immediately
  // before each real call, and the total is written back once at the end.
  // Hard cap 3 across runs: a task already at Attempts=3 will not run
  // until a human resets Attempts in Notion.
  const tracker = new AttemptTracker(task.attempts ?? 0, { maxRetries: config.maxRetries, hardCap: 3 });
  const startedAt = new Date().toISOString();
  const entry = {
    attempts: tracker.total,
    executionStatus: "running",
    pid: null,
    runDir,
    // Stable for this run only: the report marker and the "already appended?"
    // check both key off it, so a sync retry cannot double-append.
    runId: newRunId({ attempt: tracker.total, pageId: task.notionPageId, startedAt, taskId: task.taskId }),
    startedAt,
    status: "running",
    taskId: task.taskId,
  };
  if (task.notionPageId) {
    ledger.tasks[task.notionPageId] = entry;
    saveLedger(config.dataDir, ledger);
  }

  let lastError = "";
  if (!tracker.canAttempt()) {
    const budgetError = `attempt budget exhausted (Notion Attempts=${tracker.total}, hard cap=3). Reset Attempts in Notion to re-run this task.`;
    log(`budget: ${task.taskId}: ${budgetError}`);
    // No executor was invoked here, so this is a terminal outcome, not a crash.
    // Land it in the ledger BEFORE the Notion call: leaving status "running" made
    // recoverRunning() on the next start treat the task as interrupted and
    // overwrite this accurate budget error in Notion with the vague
    // "Bridge restarted while this task was running" message.
    if (task.notionPageId) {
      // No executor ran, so runDir (computed at the top of this function) was
      // never created -- mkdirSync happens inside executors.executeTask. Keep
      // the ledger honest: it is the idempotency anchor, so a pointer to a
      // directory that cannot exist is worse than no pointer. Drop it.
      entry.runDir = null;
      const res = await finishAndSync(
        entry,
        { error: budgetError, executionStatus: "failed", exitCode: null, finishedAt: new Date().toISOString() },
        syncDepsFor({ config, entry, ledger, notion, pageId: task.notionPageId }),
      );
      if (!res.ok) log(`budget: ${task.taskId}: Notion writeback pending (${res.error}); will retry sync only on the next poll`);
    }
    return { outcome: "failed", error: budgetError };
  }
  while (tracker.canAttempt()) {
    const attempt = tracker.next();
    entry.attempts = tracker.total;
    if (task.notionPageId) saveLedger(config.dataDir, ledger);
    let currentPid = null;
    let cancelRequested = false;
    let watcher = null;
    if (notion && task.notionPageId) {
      watcher = setInterval(async () => {
        try {
          const fresh = await notion.getPage(task.notionPageId);
          if (fresh.status === "Cancelled") {
            cancelRequested = true;
            killTreeByPid(currentPid);
          }
        } catch {}
      }, 15000);
      watcher.unref?.();
    }
    const result = await executeTask({
      config,
      onPid: (pid) => {
        currentPid = pid;
        entry.pid = pid;
        if (task.notionPageId) saveLedger(config.dataDir, ledger);
      },
      runDir,
      task: fullTask,
    });
    if (watcher) clearInterval(watcher);

    const durationSec = Math.round(result.durationMs / 1000);
    if (cancelRequested) {
      log(`cancelled: ${task.taskId}`);
      if (task.notionPageId) {
        await finishAndSync(
          entry,
          {
            durationSec,
            error: "Cancelled from Notion while running.",
            executionStatus: "cancelled",
            exitCode: result.code,
            logPath: `local: ${result.stdoutPath} | ${result.stderrPath}`,
            tokens: result.tokens,
            tokensText: formatTokens(result.tokens),
          },
          syncDepsFor({ config, entry, ledger, notion, pageId: task.notionPageId }),
        );
      }
      return { outcome: "cancelled", result };
    }

    if (result.code === 0) {
      const summary = result.output ? result.output.slice(0, 1500) : "(empty output)";
      log(`done: ${task.taskId} in ${durationSec}s, tokens=${formatTokens(result.tokens)}`);
      if (!task.notionPageId) {
        fs.writeFileSync(path.join(runDir, "result.json"), JSON.stringify({
          changedFiles: result.changedFiles,
          durationMs: result.durationMs,
          executor,
          output: result.output,
          status: "Done",
          taskId: task.taskId,
          tokens: result.tokens,
          workdir,
        }, null, 2));
      } else {
        // Ledger first, Notion second. recordTerminal + save happen inside
        // finishAndSync before the first network call, so a crash or an outage right
        // here leaves "succeeded, properties_pending" on disk - which the next poll
        // can only sync, never re-run.
        const res = await finishAndSync(
          entry,
          {
            changedFiles: result.changedFiles,
            durationSec,
            error: "",
            executionStatus: "succeeded",
            executor,
            exitCode: result.code,
            logPath: `local: ${result.stdoutPath} | ${result.stderrPath}`,
            promptIgnoredBlocks: task.promptIgnoredBlocks ?? 0,
            resultSummary: summary,
            tokens: result.tokens,
            tokensText: formatTokens(result.tokens),
            workdir,
          },
          syncDepsFor({ config, entry, ledger, notion, pageId: task.notionPageId }),
        );
        if (!res.ok) log(`done: ${task.taskId}: Notion writeback pending (${res.error}); the run will NOT be repeated, only the sync retried`);
      }
      return { outcome: "done", result };
    }

    lastError = result.error || `executor exited with code ${result.code}`;
    log(`attempt ${attempt} failed: ${task.taskId}: ${lastError.slice(0, 300)}`);
    if (tracker.canAttempt()) {
      await sleep(10000 * attempt);
      continue;
    }
    log(`failed: ${task.taskId} after ${tracker.total} attempt(s) (Notion Attempts=${tracker.total})`);
    if (task.notionPageId) {
      // Same rule as the success path: the accurate error is persisted before any
      // Notion call, so neither a failed write nor a failed report can replace it.
      const res = await finishAndSync(
        entry,
        {
          durationSec,
          error: lastError,
          executionStatus: "failed",
          executor,
          exitCode: result.code,
          logPath: `local: ${result.stdoutPath} | ${result.stderrPath}`,
          tokens: result.tokens,
          tokensText: formatTokens(result.tokens),
          workdir,
        },
        syncDepsFor({ config, entry, ledger, notion, pageId: task.notionPageId }),
      );
      if (!res.ok) log(`failed: ${task.taskId}: Notion writeback pending (${res.error}); will retry sync only, never re-run`);
    }
    return { outcome: "failed", result };
  }
  return { outcome: "failed", error: lastError };
}

async function main() {
  const args = process.argv.slice(2);
  const once = args.includes("--once");
  const poll = args.includes("--poll");
  const localTaskArg = args.includes("--local-task") ? args[args.indexOf("--local-task") + 1] : null;
  const { config, errors } = loadConfig();
  if (errors.length) {
    console.error("Config errors:");
    for (const e of errors) console.error(` - ${e}`);
    process.exit(1);
  }
  fs.mkdirSync(config.dataDir, { recursive: true });

  // Review item 6: single-instance PID lock. A second bridge (double-clicked
  // .bat, stray poller) exits instead of racing the same Notion queue.
  // Stale locks from dead owners are reclaimed by lock.js.
  const lock = acquireSingleInstanceLock(path.join(config.dataDir, "bridge.lock"));
  if (!lock.ok) {
    console.error(`[AI-Bridge] another bridge instance is already running (pid=${lock.pid}), exiting.`);
    process.exit(1);
  }

  if (localTaskArg) {
    const raw = JSON.parse(fs.readFileSync(localTaskArg, "utf8"));
    const task = {
      approval: raw.approval ?? "Approved",
      attempts: 0,
      executor: raw.executor,
      notionPageId: null,
      prompt: raw.prompt,
      taskId: raw.taskId,
      title: raw.title,
      workdir: raw.workdir,
      writeMode: raw.writeMode ?? "read-only",
    };
    const ledger = loadLedger(config.dataDir);
    const res = await runOneTask({ config, ledger, notion: null, task });
    console.log(JSON.stringify({ localTask: true, outcome: res.outcome }, null, 2));
    process.exit(res.outcome === "done" ? 0 : 1);
  }

  if (!config.notionApiKey || !config.notionDatabaseId) {
    console.error("Missing NOTION_API_KEY or NOTION_DATABASE_ID in .env. Copy .env.example to .env first.");
    process.exit(1);
  }
  if (config.useCodingAgentRunner) {
    console.error("useCodingAgentRunner=true is not wired into v1's direct-exec path (see src/runners/coding-agent-runner.mjs). Set it to false for the v1 real loop.");
    process.exit(1);
  }
  const notion = new NotionClient({ apiKey: config.notionApiKey, version: config.notionVersion });
  const ledger = await recoverRunning(config, notion);

  do {
    // Finish any projection a crash or a Notion outage left behind, BEFORE looking at
    // the queue. Without this pass a page that is still Queued but already executed
    // would be handed to the executor a second time.
    try {
      await reconcileWritebacks({ config, ledger, notion });
    } catch (err) {
      log(`reconcile failed: ${err.message}`);
    }
    let queued = [];
    try {
      queued = await notion.queryQueued(config.notionDatabaseId);
    } catch (err) {
      log(`Notion poll failed: ${err.message}`);
    }
    log(`poll: ${queued.length} queued task(s)`);
    for (const page of queued) {
      // Queued is not the same as "needs a run": the ledger decides. A page whose
      // result never reached Notion is stale state and only gets synced; a page that
      // was already projected and re-queued by a human is a deliberate fresh run.
      const existing = page.notionPageId ? ledger.tasks[page.notionPageId] : null;
      const decision = decideQueuedAction(existing);
      if (decision.action === "sync") {
        log(`sync-only: ${page.taskId || page.notionPageId}: ${decision.reason}; executor NOT called again`);
        try {
          await syncEntry(existing, syncDepsFor({ config, entry: existing, ledger, notion, pageId: page.notionPageId }));
        } catch (err) {
          log(`sync-only failed for ${page.taskId || page.notionPageId}: ${err.message}`);
        }
        continue;
      }
      if (decision.action === "skip") {
        log(`skip: ${page.taskId || page.notionPageId}: ${decision.reason}`);
        continue;
      }
      try {
        const { ignoredBlocks, moreBlocksAfterDivider, pageCapHit, pages, prompt } = await notion.getPrompt(page.notionPageId);
        const task = { ...page, prompt: prompt || page.prompt, promptIgnoredBlocks: ignoredBlocks };
        if (ignoredBlocks > 0) {
          // The common way to reach this: the gate inserted a divider, the human then
          // added a note to the page body and approved. Say it out loud instead of
          // running on the old instruction in silence.
          log(`prompt: ${page.taskId || page.notionPageId}: stopped at the divider, ignored ${ignoredBlocks}${moreBlocksAfterDivider ? "+" : ""} block(s) — instructions added below the divider are NOT part of this run`);
        }
        if (pageCapHit) {
          log(`prompt: ${page.taskId || page.notionPageId}: stopped after ${pages} pages without finding a divider; the body may be longer than the prompt read supports`);
        }
        if (!task.prompt.trim()) {
          log(`skip: ${task.taskId || page.notionPageId} has no prompt in body or Prompt property`);
          continue;
        }
        if (!task.taskId) task.taskId = `BR-${page.notionPageId.replace(/-/g, "").slice(0, 8)}`;
        await runOneTask({ config, ledger, notion, task });
      } catch (err) {
        log(`task error (${page.taskId || page.notionPageId}): ${err.message}`);
        // If the run already recorded a terminal result, this error came from the
        // writeback side, not from the execution. Writing Failed here is exactly how a
        // finished task used to get rewritten - leave it to the sync path instead.
        const recorded = page.notionPageId ? ledger.tasks[page.notionPageId] : null;
        if (recorded && isTerminalExecution(recorded)) {
          log(`task error after a recorded result (${recorded.executionStatus}); leaving Notion status alone, sync will retry`);
          continue;
        }
        try {
          await notion.updatePage(page.notionPageId, {
            Error: richText(err.message),
            Status: select("Failed"),
          });
        } catch {}
      }
    }
    if (!poll) break;
    await sleep(config.pollIntervalMs);
  } while (poll);
  void once;
}

main().catch((err) => {
  console.error(redact(err.stack || String(err)));
  process.exit(1);
});
