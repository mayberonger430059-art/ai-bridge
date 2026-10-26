import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { redact } from "./config.js";
import { killProcessTree } from "./killtree.js";
import { extractResult } from "./parse-output.js";

export { killProcessTree };
export { killTreeByPid } from "./killtree.js";

// Direct official CLI execution (v1 default). No coding-agent-runner, no ACP, no server:
//   Codex:   codex exec --json --sandbox <read-only|workspace-write> -   (prompt on stdin, avoids Windows 32k cmdline limit)
//   OpenCode: opencode run --format json <prompt>   (mode configurable: run|standalone|print, see README)
// Token usage is BEST-EFFORT parsed from the CLI's own JSON output. If the CLI does
// not report it, tokens are recorded as "unknown" — never estimated, never invented.

function runProcess(command, args, { cwd, timeoutMs, stdinText, stdoutPath, stderrPath, onPid }) {
  return new Promise((resolve) => {
    const stdoutStream = fs.createWriteStream(stdoutPath);
    const stderrStream = fs.createWriteStream(stderrPath);
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        // Review item 2: POSIX detached so the process-group kill in
        // killtree.js can reap grandchildren. Windows ignores detached
        // for grouping; taskkill /T handles the tree there.
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      resolve({ code: 1, error: String(err), killed: false, pid: null, timedOut: false });
      return;
    }
    const pid = child.pid ?? null;
    if (onPid) {
      try {
        onPid(pid);
      } catch {}
    }
    let timedOut = false;
    let killed = false;
    let hardTimer = null;
    const timer = setTimeout(() => {
      timedOut = true;
      killed = true;
      // Review item 2: graceful stop, then forced tree kill, then a hard
      // deadline so a stuck/zombie child can never hang the bridge forever.
      void killProcessTree(child, { graceMs: 5000, hardMs: 15000 });
      hardTimer = setTimeout(() => {
        resolve({ code: 124, error: "executor did not exit after hard kill deadline", killed, pid, timedOut });
      }, 20000);
      hardTimer.unref?.();
    }, timeoutMs);
    child.stdout.pipe(stdoutStream);
    child.stderr.pipe(stderrStream);
    child.on("error", (err) => {
      clearTimeout(timer);
      if (hardTimer) clearTimeout(hardTimer);
      resolve({ code: 1, error: redact(String(err)), killed, pid, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (hardTimer) clearTimeout(hardTimer);
      resolve({ code: code ?? 1, error: "", killed, pid, timedOut });
    });
    if (stdinText !== undefined) {
      child.stdin.end(stdinText);
    } else {
      child.stdin.end();
    }
  });
}

// killProcessTree (child version) and killTreeByPid (PID version, for the
// bridge cancel watcher) now live in killtree.js and are re-exported above.

function gitStatus(cwd) {
  return new Promise((resolve) => {
    execFile("git", ["status", "--porcelain"], { cwd }, (err, stdout) => {
      resolve(err ? null : String(stdout).trim());
    });
  });
}

function extractTokens(text) {
  // Scan JSON / JSONL output for usage-shaped objects. Returns null when nothing is found.
  let input = 0;
  let output = 0;
  let found = false;
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const obj = JSON.parse(trimmed);
      const usage = obj.usage ?? obj.token_usage ?? obj.tokens ?? obj.result?.usage ?? null;
      if (usage && typeof usage === "object") {
        const i = usage.input_tokens ?? usage.prompt_tokens ?? usage.inputTokens ?? 0;
        const o = usage.output_tokens ?? usage.completion_tokens ?? usage.outputTokens ?? 0;
        if (Number(i) || Number(o)) {
          input += Number(i) || 0;
          output += Number(o) || 0;
          found = true;
        }
      }
    } catch {}
  }
  if (!found) {
    try {
      const obj = JSON.parse(text);
      const usage = obj?.usage ?? obj?.result?.usage ?? null;
      if (usage) {
        input = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0) || 0;
        output = Number(usage.output_tokens ?? usage.completion_tokens ?? 0) || 0;
        found = Boolean(input || output);
      }
    } catch {}
  }
  if (!found) return null;
  return { input, output, total: input + output };
}

export function formatTokens(tokens) {
  if (!tokens) return "unknown (CLI did not report token usage)";
  return `input=${tokens.input} output=${tokens.output} total=${tokens.total}`;
}

export async function executeTask({ config, task, runDir, onPid }) {
  fs.mkdirSync(runDir, { recursive: true });
  const stdoutPath = path.join(runDir, "stdout.log");
  const stderrPath = path.join(runDir, "stderr.log");
  const before = await gitStatus(task.workdir);
  const startedAt = Date.now();

  if (task.executor === "dryrun") {
    // Plumbing test only. Writes one marker file inside the allowed workdir and exits.
    // It must never be used to claim a real agent run.
    const marker = path.join(task.workdir, "AI_BRIDGE_DRYRUN_OK.txt");
    fs.writeFileSync(marker, `AI Bridge dry-run marker\ntaskId=${task.taskId}\ncreated=${new Date().toISOString()}\n`);
    fs.writeFileSync(stdoutPath, "[DRY-RUN] no model call was made. Marker written.\n");
    fs.writeFileSync(stderrPath, "");
    return {
      changedFiles: before === null ? "not a git repo (no diff available)" : "",
      code: 0,
      durationMs: Date.now() - startedAt,
      error: "",
      output: "[DRY-RUN] plumbing only, no model call.",
      pid: null,
      stderrPath,
      stdoutPath,
      timedOut: false,
      tokens: null,
    };
  }

  let command;
  let args;
  let stdinText;
  if (task.executor === "codex") {
    const sandbox = task.writeMode === "write" ? config.codexSandboxWrite : config.codexSandboxReadOnly;
    command = "codex";
    args = ["exec", "--json", "--sandbox", sandbox, "-C", task.workdir];
    if (before === null) args.push("--skip-git-repo-check");
    args.push("-"); // prompt from stdin
    stdinText = task.prompt;
  } else if (task.executor === "opencode") {
    command = "opencode";
    if (config.opencodeMode === "standalone") {
      args = ["run", "--standalone", "--format", "json", "--dir", task.workdir, task.prompt];
    } else if (config.opencodeMode === "print") {
      args = ["-p", task.prompt, "-f", "json", "-q"];
    } else {
      // Verified against opencode 1.19.4: run [message..] --format json --dir <dir>.
      // Newer opencode 2.x uses the same run shape with --standalone; if --format
      // is rejected on the local install, change opencodeMode, do not auto-retry.
      args = ["run", "--format", "json", "--dir", task.workdir, task.prompt];
    }
  } else {
    throw new Error(`unknown executor: ${task.executor}`);
  }

  const result = await runProcess(command, args, {
    cwd: task.workdir,
    onPid,
    stderrPath,
    stdoutPath,
    stdinText,
    timeoutMs: config.timeoutMs,
  });
  const durationMs = Date.now() - startedAt;
  const stdoutText = fs.existsSync(stdoutPath) ? fs.readFileSync(stdoutPath, "utf8") : "";
  const stderrText = fs.existsSync(stderrPath) ? fs.readFileSync(stderrPath, "utf8") : "";
  const after = await gitStatus(task.workdir);
  let changedFiles = "not a git repo (no diff available)";
  if (before !== null && after !== null) {
    const afterLines = after ? after.split(/\r?\n/) : [];
    changedFiles = afterLines.length ? afterLines.join("\n") : "(no changed files)";
  }
  // Review item 3: prefer the last structured agent message when the CLI
  // output parses as JSONL/JSON; fall back to the raw tail, marked by
  // extractResult's outputSource. Tokens still come from extractTokens
  // (summed across events), not from extractResult's last-only usage.
  const parsed = extractResult(stdoutText);
  const output =
    parsed.outputSource === "structured" ? redact(parsed.output).slice(0, 8000) : redact(parsed.output).slice(-8000);
  const error = result.timedOut
    ? `timeout after ${config.timeoutMs}ms (child killed)`
    : result.code !== 0
      ? redact(stderrText).slice(-2000) || `executor exited with code ${result.code}`
      : result.error;
  return {
    changedFiles,
    code: result.timedOut ? 124 : result.code,
    durationMs,
    error,
    output,
    pid: result.pid,
    stderrPath,
    stdoutPath,
    timedOut: result.timedOut,
    tokens: extractTokens(stdoutText),
  };
}

export { extractTokens };
