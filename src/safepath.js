import fs from "node:fs";
import path from "node:path";

// Hardened whitelist / path-escape guard, adapted from the Notion Claude
// review bundle (src/safepath.js, CommonJS) to this repo's ESM layout.
// Zero dependencies. Logic is unchanged from the reviewed module except
// for the import/export shape; see docs/claude-review-landing.md for the
// deviations from the bundle that were required to fit v0.1.

const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";

export function realpathBestEffort(p) {
  let abs = path.resolve(p);
  const tail = [];
  for (let i = 0; i < 8192; i++) {
    try {
      const real = fs.realpathSync.native(abs);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch (err) {
      if (err.code !== "ENOENT" && err.code !== "ENOTDIR") throw err;
      const parent = path.dirname(abs);
      if (parent === abs) {
        return tail.length ? path.join(abs, ...tail.reverse()) : abs;
      }
      tail.push(path.basename(abs));
      abs = parent;
    }
  }
  throw new Error(`realpathBestEffort: path too deep: ${p}`);
}

function normForCompare(p) {
  return CASE_INSENSITIVE ? p.toLowerCase() : p;
}

function withTrailingSep(p) {
  return p.endsWith(path.sep) ? p : p + path.sep;
}

export function isInsideDir(child, parent) {
  const rp = normForCompare(realpathBestEffort(parent));
  const rc = normForCompare(realpathBestEffort(child));
  if (rp === rc) return true;
  return rc.startsWith(withTrailingSep(rp));
}

export function firstSymlinkBetween(child, parent) {
  const base = path.resolve(parent);
  const target = path.resolve(child);
  const rel = path.relative(base, target);
  if (rel === "" || rel.startsWith("..")) return null;
  let cur = base;
  for (const seg of rel.split(path.sep)) {
    if (!seg) continue;
    cur = path.join(cur, seg);
    try {
      if (fs.lstatSync(cur).isSymbolicLink()) return cur;
    } catch (err) {
      if (err.code === "ENOENT") break;
      throw err;
    }
  }
  return null;
}

export function assertWorkdirAllowed(workdir, opts = {}) {
  const { allowList = [], protectedPaths = [], rejectSymlinks = true } = opts;
  if (!workdir || typeof workdir !== "string") {
    throw new Error("workdir is required");
  }
  const real = realpathBestEffort(workdir);
  const allowed = allowList.some((root) => isInsideDir(workdir, root));
  if (!allowed) {
    throw new Error(`workdir not in allow-list: ${workdir} (resolves to ${real})`);
  }
  for (const p of protectedPaths) {
    if (isInsideDir(workdir, p) || isInsideDir(p, workdir)) {
      throw new Error(`workdir overlaps protected path: ${workdir} vs ${p}`);
    }
  }
  if (rejectSymlinks) {
    const matchedRoot = allowList.find((root) => isInsideDir(workdir, root));
    const link = firstSymlinkBetween(workdir, matchedRoot);
    if (link) {
      throw new Error(`symlink not allowed inside workdir sandbox: ${link}`);
    }
  }
  return real;
}
