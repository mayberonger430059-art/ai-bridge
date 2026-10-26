import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkExecutorIdentity, verifyExecutorVersion } from "../src/executor-identity.js";

// What this locks
// ---------------
// Round N2's follow-up list included: "doctor 校验 provider 身份（而非可执行文件能跑）".
// Before this, `executorPaths.opencode` pointed at C:\Windows\System32\cmd.exe produced
// PASS, because doctor only asked "did the command exit 0 and print something".
//
// The negative control is the point of the whole file: the same cmd.exe config must
// now be FAIL. Without it, a rule that accepts everything would still pass the positive
// cases (and the real doctor run would still look green).

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const DOCTOR = path.join(REPO_ROOT, "src", "doctor.js");
const SPAWN_TIMEOUT_MS = 30000;

test("identity: real executor version lines pass", () => {
  assert.equal(checkExecutorIdentity("opencode", "opencode v2.1.4").ok, true);
  assert.equal(checkExecutorIdentity("opencode", "OpenCode 3.0.0").ok, true, "case must not matter");
  assert.equal(checkExecutorIdentity("codex", "codex-cli 0.164.0-alpha.11.1").ok, true, "prerelease suffix is a version");
  assert.equal(checkExecutorIdentity("opencode", "  opencode v1.19.4  ").ok, true, "surrounding whitespace must not matter");
});

test("identity: an unrelated binary's banner fails, and says why", () => {
  const win = checkExecutorIdentity("opencode", "Microsoft Windows [版本 10.0.19045.6456]");
  assert.equal(win.ok, false);
  assert.match(win.reason, /does not name opencode/);

  const pwsh = checkExecutorIdentity("codex", "Windows PowerShell 5.1.19041.1");
  assert.equal(pwsh.ok, false, "a version number alone is not identity");

  const nearMiss = checkExecutorIdentity("opencode", "opencodex v1.2.3");
  assert.equal(nearMiss.ok, false, "word boundary must reject a lookalike name");
});

test("identity: a name with no version, or no output, fails", () => {
  const noVersion = checkExecutorIdentity("opencode", "opencode");
  assert.equal(noVersion.ok, false);
  assert.match(noVersion.reason, /no version number/);

  assert.equal(checkExecutorIdentity("opencode", "").ok, false);
  assert.equal(checkExecutorIdentity("opencode", undefined).ok, false);
  assert.equal(checkExecutorIdentity("nope", "nope v1.2.3").ok, false, "unknown executor must not silently pass");
});

test("verifyExecutorVersion: keeps spawn errors verbatim, rejects a wrong-but-runnable binary", () => {
  const spawnFail = verifyExecutorVersion("opencode", { found: false, detail: "spawn C:\\x\\opencode.exe ENOENT" }, "C:\\x\\opencode.exe");
  assert.equal(spawnFail.ok, false);
  assert.match(spawnFail.detail, /ENOENT/, "the spawn reason must survive: it is the actionable part");

  const wrong = verifyExecutorVersion("opencode", { found: true, detail: "Microsoft Windows [版本 10.0" }, "C:\\Windows\\System32\\cmd.exe");
  assert.equal(wrong.ok, false);
  assert.match(wrong.detail, /cmd\.exe/, "detail should name the probed binary");
  assert.match(wrong.detail, /executorPaths\.opencode/, "detail should name the config field to fix");

  const good = verifyExecutorVersion("opencode", { found: true, detail: "opencode v2.1.4" }, "C:\\opencode-cli.exe");
  assert.equal(good.ok, true);
  assert.match(good.detail, /v2\.1\.4/);
});

// --- end-to-end through the real doctor entry point -------------------------

function makeTmpDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(process.env.AIB_TEST_TMPDIR || REPO_ROOT, prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeConfig(dir, executorPaths) {
  const workdir = path.join(dir, "work");
  fs.mkdirSync(workdir, { recursive: true });
  const configPath = path.join(dir, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    allowedExecutors: ["opencode", "codex"],
    allowedWorkdirs: [workdir],
    maxRetries: 1,
    opencodeMode: "run",
    protectedPaths: [],
    timeoutMs: 1800000,
    executorPaths,
  }, null, 2), "utf8");
  return configPath;
}

function runDoctor(configPath) {
  const r = spawnSync(process.execPath, [DOCTOR], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: SPAWN_TIMEOUT_MS,
    env: { ...process.env, BRIDGE_CONFIG: configPath },
  });
  return { status: r.status, stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? ""), error: r.error };
}

function opencodeLine(stdout) {
  return stdout.split(/\r?\n/).find((l) => l.includes("opencode CLI available")) || "";
}

test("doctor reverse control: executorPaths.opencode -> cmd.exe is FAIL, not PASS", (t) => {
  if (process.platform !== "win32") {
    t.skip("the reported defect and this control are Windows-specific (cmd.exe --version exits 0 and prints a banner)");
    return;
  }
  const comspec = process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe";
  assert.equal(fs.existsSync(comspec), true, `ComSpec not found: ${comspec}`);

  const dir = makeTmpDir(t, "test-workdir-doctor-identity-");
  const r = runDoctor(writeConfig(dir, { opencode: comspec }));
  t.diagnostic(`[cmd.exe as opencode] exit=${r.status}`);
  assert.equal(r.error, undefined, `doctor did not finish in ${SPAWN_TIMEOUT_MS}ms`);
  const line = opencodeLine(r.stdout);
  assert.match(line, /^FAIL {2}opencode CLI available/, `cmd.exe must not satisfy the opencode check, got: ${line}`);
  assert.match(line, /does not name opencode/, `failure should name the identity reason, got: ${line}`);
  assert.doesNotMatch(line, /^PASS/, "regression: an unrelated executable is back to passing");
  assert.equal(r.stderr.trim(), "", `stderr should stay empty: ${r.stderr}`);
});

test("doctor positive control: the real opencode install still passes", (t) => {
  // Machine-dependent by nature: this asserts the identity rule did not turn a
  // working install red. Skips cleanly where the binary is absent, and the unit
  // tests above still cover the rule itself.
  const configPath = path.join(REPO_ROOT, "config.json");
  if (!fs.existsSync(configPath)) return t.skip("no local config.json");
  let configured = "";
  try {
    configured = JSON.parse(fs.readFileSync(configPath, "utf8"))?.executorPaths?.opencode || "";
  } catch {
    return t.skip("config.json is not parseable");
  }
  if (!configured || !fs.existsSync(configured)) return t.skip(`opencode not installed at ${configured || "(unset)"}`);

  const r = runDoctor(configPath);
  t.diagnostic(`[real opencode] exit=${r.status}`);
  const line = opencodeLine(r.stdout);
  assert.match(line, /^PASS {2}opencode CLI available/, `real opencode must still pass, got: ${line}`);
  assert.match(line, /opencode v\d+\.\d+\.\d+/, `PASS line should carry the measured version, got: ${line}`);
  // The aggregate check reads the per-executor verdict. It used to read the raw
  // "found" flag, so switching the per-executor result shape silently turned a
  // green doctor into "neither codex nor opencode was found". Assert it here too.
  assert.match(r.stdout, /^PASS {2}at least one executor available/m, "aggregate check must read the identity verdict, not the raw spawn result");
});
