import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { redact } from "./config.js";

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
      child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
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
    const timer = setTimeout(() => {
      timedOut = true;
      killed = true;
      try {
        child.kill("SIGTERM");
      } catch {}
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
      }, 5000);
    }, timeoutMs);
    child.stdout.pipe(stdoutStream);
    child.stderr.pipe(stderrStream);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 1, error: redact(String(err)), killed, pid, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, error: "", killed, pid, timedOut });
    });
    if (stdinText !== undefined) {
      child.stdin.end(stdinText);
    } else {
      child.stdin.end();
    }
  });
}

export function killProcessTree(pid) {
  // Best effort only. On Windows, taskkill /T kills the tree; elsewhere SIGTERM first.
  if (!pid) return;
  if (process.platform === "win32") {
    execFile("taskkill", ["/PID", String(pid), "/T", "/F"], () => {});
  } else {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
}

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
  // Final agent message: for Codex --json the last JSONL line's text/message is the
  // result; for OpenCode JSON it is the wrapped response. Keep it simple and honest:
  // store the raw tail as the output and let the Notion report quote it, truncated.
  const output = redact(stdoutText).slice(-8000);
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
