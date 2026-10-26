import fs from "node:fs";
import path from "node:path";
import { assertExecutor, assertWorkdir, loadConfig, redact } from "./config.js";
import { executeTask, formatTokens, killProcessTree } from "./executors.js";
import { isPidAlive, loadLedger, saveLedger } from "./ledger.js";
import { NotionClient, numberValue, richText, select } from "./notion.js";

const log = (...args) => console.log(new Date().toISOString(), ...args.map((a) => redact(String(a))));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    entry.status = "recovered-unknown";
    changed = true;
    log(`recovery: task ${entry.taskId} was running at shutdown, outcome unknown, marking Failed in Notion`);
    if (notion) {
      try {
        await notion.updatePage(pageId, {
          Error: richText("Bridge restarted while this task was running; previous outcome is unknown. Check the local log, then re-queue only if you want a fresh run."),
          Status: select("Failed"),
        });
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
  if (task.writeMode === "write" && task.approval !== "Approved") {
    log(`gate: ${task.taskId} needs approval (WriteMode=write, Approval=${task.approval || "empty"}), moving to NeedsApproval, NOT executing`);
    if (notion) {
      await notion.updatePage(task.notionPageId, { Status: select("NeedsApproval") });
      await notion.appendReport(task.notionPageId, [
        "AI Bridge gate: this task requests file writes but Approval is not 'Approved'.",
        "To proceed, set Approval = Approved in Notion (the bridge will pick it up on the next poll). To abandon, set Status = Cancelled.",
      ]);
    }
    return { outcome: "needs-approval" };
  }

  const workdir = assertWorkdir(config, task.workdir);
  const executor = assertExecutor(config, task.executor);
  const fullTask = { ...task, executor, workdir };
  const runDir = runDirFor(config, task.taskId || task.notionPageId || "local");
  const entry = {
    attempts: (task.attempts ?? 0) + 1,
    pid: null,
    runDir,
    startedAt: new Date().toISOString(),
    status: "running",
    taskId: task.taskId,
  };
  if (task.notionPageId) {
    ledger.tasks[task.notionPageId] = entry;
    saveLedger(config.dataDir, ledger);
  }

  let lastError = "";
  for (let attempt = 1; attempt <= config.maxRetries + 1; attempt++) {
    let currentPid = null;
    let cancelRequested = false;
    let watcher = null;
    if (notion && task.notionPageId) {
      watcher = setInterval(async () => {
        try {
          const fresh = await notion.getPage(task.notionPageId);
          if (fresh.status === "Cancelled") {
            cancelRequested = true;
            killProcessTree(currentPid);
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
      if (notion) {
        await notion.updatePage(task.notionPageId, {
          Error: richText("Cancelled from Notion while running."),
          Status: select("Cancelled"),
        });
      }
      if (task.notionPageId) {
        entry.status = "cancelled";
        saveLedger(config.dataDir, ledger);
      }
      return { outcome: "cancelled", result };
    }

    if (result.code === 0) {
      const summary = result.output ? result.output.slice(0, 1500) : "(empty output)";
      log(`done: ${task.taskId} in ${durationSec}s, tokens=${formatTokens(result.tokens)}`);
      if (notion) {
        await notion.updatePage(task.notionPageId, {
          Attempts: numberValue(entry.attempts),
          ChangedFiles: richText(result.changedFiles),
          Error: richText(""),
          LogPath: richText(`local: ${result.stdoutPath} | ${result.stderrPath}`),
          ResultSummary: richText(summary),
          Status: select("Done"),
          Tokens: richText(formatTokens(result.tokens)),
        });
        await notion.appendReport(task.notionPageId, [
          `AI Bridge result: Done in ${durationSec}s, executor=${executor}, workdir=${workdir}.`,
          `Tokens: ${formatTokens(result.tokens)}.`,
          `Changed files (git status): ${result.changedFiles.slice(0, 1500)}`,
          `Local logs (on the Windows machine, not in Notion): ${result.stdoutPath} ; ${result.stderrPath}`,
          `Output (tail): ${summary}`,
        ]);
      } else {
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
      }
      if (task.notionPageId) {
        entry.status = "done";
        entry.tokens = result.tokens;
        saveLedger(config.dataDir, ledger);
      }
      return { outcome: "done", result };
    }

    lastError = result.error || `executor exited with code ${result.code}`;
    log(`attempt ${attempt} failed: ${task.taskId}: ${lastError.slice(0, 300)}`);
    if (attempt <= config.maxRetries) {
      await sleep(10000 * attempt);
      continue;
    }
    log(`failed: ${task.taskId} after ${attempt} attempt(s)`);
    if (notion) {
      await notion.updatePage(task.notionPageId, {
        Attempts: numberValue(entry.attempts),
        Error: richText(lastError),
        LogPath: richText(`local: ${result.stdoutPath} | ${result.stderrPath}`),
        Status: select("Failed"),
        Tokens: richText(formatTokens(result.tokens)),
      });
      await notion.appendReport(task.notionPageId, [
        `AI Bridge result: Failed after ${attempt} attempt(s), duration=${durationSec}s.`,
        `Error (original, truncated): ${lastError.slice(0, 1500)}`,
        `Local logs (on the Windows machine, not in Notion): ${result.stdoutPath} ; ${result.stderrPath}`,
      ]);
    }
    if (task.notionPageId) {
      entry.status = "failed";
      entry.error = lastError;
      saveLedger(config.dataDir, ledger);
    }
    return { outcome: "failed", result };
  }
  return { outcome: "failed", error: lastError };
}

async function main() {
  const args = process.argv.slice(2);
  const once = args.includes("--once");
  const poll = args.includes("--poll");
  const localTaskArg = args[args.indexOf("--local-task") + 1];
  const { config, errors } = loadConfig();
  if (errors.length) {
    console.error("Config errors:");
    for (const e of errors) console.error(` - ${e}`);
    process.exit(1);
  }
  fs.mkdirSync(config.dataDir, { recursive: true });

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
    let queued = [];
    try {
      queued = await notion.queryQueued(config.notionDatabaseId);
    } catch (err) {
      log(`Notion poll failed: ${err.message}`);
    }
    log(`poll: ${queued.length} queued task(s)`);
    for (const page of queued) {
      try {
        const prompt = await notion.getPrompt(page.notionPageId);
        const task = { ...page, prompt: prompt || page.prompt };
        if (!task.prompt.trim()) {
          log(`skip: ${task.taskId || page.notionPageId} has no prompt in body or Prompt property`);
          continue;
        }
        if (!task.taskId) task.taskId = `BR-${page.notionPageId.replace(/-/g, "").slice(0, 8)}`;
        await runOneTask({ config, ledger, notion, task });
      } catch (err) {
        log(`task error (${page.taskId || page.notionPageId}): ${err.message}`);
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
