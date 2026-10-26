import fs from "node:fs";
import path from "node:path";

// Single-instance PID lock, adapted from the Notion Claude review bundle
// (src/lock.js, CommonJS) to ESM. Logic unchanged.

export function isAlive(pid) {
  if (!pid || pid === process.pid) return pid === process.pid;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

export function readPid(lockFile) {
  try {
    const n = parseInt(fs.readFileSync(lockFile, "utf8").trim(), 10);
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

export function acquireSingleInstanceLock(lockFile) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockFile, "wx");
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      const release = registerCleanup(lockFile);
      return { ok: true, release };
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      const prev = readPid(lockFile);
      if (prev && prev !== process.pid && isAlive(prev)) {
        return { ok: false, pid: prev };
      }
      try {
        fs.unlinkSync(lockFile);
      } catch {}
    }
  }
  return { ok: false, pid: readPid(lockFile) };
}

function registerCleanup(lockFile) {
  let released = false;
  const remove = () => {
    if (released) return;
    released = true;
    try {
      if (readPid(lockFile) === process.pid) fs.unlinkSync(lockFile);
    } catch {}
  };
  process.once("exit", remove);
  const signals = process.platform === "win32" ? ["SIGINT", "SIGBREAK", "SIGHUP"] : ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const sig of signals) {
    try {
      process.once(sig, () => {
        remove();
        process.exit(130);
      });
    } catch {}
  }
  return remove;
}
