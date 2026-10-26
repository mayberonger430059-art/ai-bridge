import { spawn, execFile } from "node:child_process";

// Kill-the-whole-process-tree, adapted from the Notion Claude review bundle
// (src/killtree.js, CommonJS) to ESM, plus a PID-based entry point for the
// bridge's Notion cancel watcher, which only ever holds a PID, not a ChildProcess.
// Zero dependencies.

export function hasExited(child) {
  return !child || child.exitCode !== null || child.signalCode !== null;
}

function runTaskkill(pid, force) {
  const args = ["/pid", String(pid), "/t"];
  if (force) args.push("/f");
  try {
    const tk = spawn("taskkill", args, { windowsHide: true, stdio: "ignore" });
    tk.on("error", () => {});
  } catch {}
}

function gracefulStop(child, pid) {
  if (process.platform === "win32") {
    runTaskkill(pid, false);
  } else {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        child.kill("SIGTERM");
      } catch {}
    }
  }
}

function forceKill(child, pid) {
  if (process.platform === "win32") {
    runTaskkill(pid, true);
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {}
    }
  }
}

export function killProcessTree(child, { graceMs = 5000, hardMs = 15000 } = {}) {
  return new Promise((resolve) => {
    if (hasExited(child)) return resolve({ ok: true, already: true });
    const pid = child.pid;
    if (!pid) return resolve({ ok: true, already: true });
    let done = false;
    let graceT;
    let hardT;
    const finish = (info) => {
      if (done) return;
      done = true;
      clearTimeout(graceT);
      clearTimeout(hardT);
      resolve(info);
    };
    child.once("exit", () => finish({ ok: true }));
    gracefulStop(child, pid);
    graceT = setTimeout(() => forceKill(child, pid), graceMs);
    hardT = setTimeout(() => finish({ ok: false, timedOut: true }), hardMs);
  });
}

// PID-only variant for the bridge cancel watcher. On POSIX this only kills
// the whole tree when the child was spawned detached (its PID is the group
// leader); executors.js now spawns that way, so this holds for bridge runs.
export function killTreeByPid(pid, { force = true } = {}) {
  if (!pid) return;
  if (process.platform === "win32") {
    execFile("taskkill", ["/PID", String(pid), "/T", force ? "/F" : ""].filter(Boolean), () => {});
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  if (force) {
    setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    }, 5000);
  }
}
