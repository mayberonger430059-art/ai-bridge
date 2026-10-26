import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveExecutorCommand } from "../src/config.js";
import { executeTask } from "../src/executors.js";

// executorPaths had seven tests proving the field is *read and validated*, and none
// proving it is *used*: setting executors.js back to a hard-coded "codex" left every
// test green, because the only thing that observed the resolved command was a real
// CLI run. These tests close that by checking the resolution rule directly and by
// making the spawned command name observable in a spawn error.

test("resolveExecutorCommand: a pinned path wins over the bare name", () => {
  const config = { executorPaths: { codex: "C:\\tools\\codex.exe", opencode: "/usr/local/bin/opencode" } };
  assert.equal(resolveExecutorCommand(config, "codex"), "C:\\tools\\codex.exe");
  assert.equal(resolveExecutorCommand(config, "opencode"), "/usr/local/bin/opencode");
});

test("resolveExecutorCommand: anything unusable falls back to the bare name", () => {
  assert.equal(resolveExecutorCommand({}, "codex"), "codex");
  assert.equal(resolveExecutorCommand({ executorPaths: {} }, "opencode"), "opencode");
  assert.equal(resolveExecutorCommand({ executorPaths: { codex: "" } }, "codex"), "codex");
  assert.equal(resolveExecutorCommand({ executorPaths: { codex: "   " } }, "codex"), "codex");
  assert.equal(resolveExecutorCommand({ executorPaths: { codex: null } }, "codex"), "codex");
  assert.equal(resolveExecutorCommand({ executorPaths: { codex: 42 } }, "codex"), "codex");
  assert.equal(resolveExecutorCommand(undefined, "codex"), "codex");
});

test("resolveExecutorCommand: a name with no override is passed through untouched", () => {
  assert.equal(resolveExecutorCommand({ executorPaths: { codex: "C:\\tools\\codex.exe" } }, "dryrun"), "dryrun");
});

// Behavioural wire-in check for executors.js. The override points at a path that
// cannot exist, so the spawn fails; the error names the command it tried to run.
// A hard-coded "codex" would report "codex" instead (and is on no PATH here).
test("executors.js spawns the resolved executorPaths binary, not the bare name", async () => {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "aib-exec-cmd-"));
  const fakeBinary = path.join(workdir, process.platform === "win32" ? "absent-codex.exe" : "absent-codex");
  const result = await executeTask({
    config: {
      codexSandboxReadOnly: "read-only",
      codexSandboxWrite: "workspace-write",
      executorPaths: { codex: fakeBinary },
      opencodeMode: "standalone",
      timeoutMs: 15000,
    },
    runDir: path.join(workdir, "run"),
    task: { executor: "codex", prompt: "hi", taskId: "BR-EXEC-CMD-1", workdir, writeMode: "read-only" },
  });
  assert.notEqual(result.code, 0, "spawning a non-existent binary must not look like success");
  assert.match(result.error, /ENOENT/);
  assert.ok(
    result.error.includes(fakeBinary),
    `spawn error should name the resolved path ${fakeBinary}, got: ${result.error}`,
  );
});
