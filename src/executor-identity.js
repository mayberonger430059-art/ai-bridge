// Identity check for doctor's executor probes.
//
// doctor used to accept "the command ran and printed a line" as proof that an
// executor exists. Pointing executorPaths.opencode at C:\Windows\System32\cmd.exe
// passed: `cmd.exe --version` prints the Windows banner, exits 0, and doctor wrote
// PASS. That PASS only proved *some* executable answered -- the exact hole Ray
// reported after the previous round.
//
// The rule here is deliberately narrow: the first line of version output must name
// the executor AND carry a version number. It is not a hash or signature check --
// the failure mode being closed is a wrong/unrelated path in config.json, not a
// tampered binary. A wrapper that prints the right text is out of scope on purpose.
//
// Kept in its own module (not in doctor.js) because doctor.js runs main() on
// import, so a pure rule living there could not be tested without spawning.

const SIGNATURES = {
  codex: /\bcodex\b/i,
  // v1 output is `opencode v2.1.4`; keep the token case-insensitive so a future
  // `OpenCode 3.0.0` still passes, while `opencodex` (no word boundary) does not.
  opencode: /\bopencode\b/i,
};

// Accepts 2.1.4, v2.1.4, 0.164.0-alpha.11.1, 1.2.3+build.7.
const VERSION = /\bv?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/;

export function checkExecutorIdentity(name, versionLine) {
  const signature = SIGNATURES[name];
  if (!signature) return { ok: false, reason: `no identity rule for executor "${name}"` };
  const line = String(versionLine ?? "").trim();
  if (!line) return { ok: false, reason: "version output was empty" };
  if (!signature.test(line)) return { ok: false, reason: `version output does not name ${name}` };
  if (!VERSION.test(line)) return { ok: false, reason: `version output has no version number (expected e.g. "${name} v1.2.3")` };
  return { ok: true, reason: "" };
}

// Turns a runVersion() result into the check doctor prints. A spawn failure keeps
// its own words (EINVAL/ENOENT are the useful part); an unrelated-but-runnable
// binary gets a note saying why it was rejected, plus which config field to fix.
export function verifyExecutorVersion(name, result, command) {
  const { found, detail } = result ?? {};
  // Always name the binary that was probed: PATH lookup and executorPaths can point
  // at different installs, and "which one did doctor actually run" was unanswerable
  // from the output alone.
  const where = command ? ` [${command}]` : "";
  if (!found) return { ok: false, detail: `${detail}${where}` };
  const identity = checkExecutorIdentity(name, detail);
  if (identity.ok) return { ok: true, detail: `${detail}${where}` };
  return { ok: false, detail: `${detail}${where} -- rejected: ${identity.reason}; fix executorPaths.${name}` };
}
