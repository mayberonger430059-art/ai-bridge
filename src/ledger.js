import fs from "node:fs";
import path from "node:path";

// Local ledger: the single source for idempotency and restart recovery.
// Notion is the queue and the report board; the ledger is the proof that a page
// was already claimed/executed by THIS bridge, so a restart or a re-poll can
// never silently re-run the same task and double-spend tokens.
export function ledgerPath(dataDir) {
  return path.join(dataDir, "ledger.json");
}

export function loadLedger(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = ledgerPath(dataDir);
  if (!fs.existsSync(file)) return { tasks: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return { tasks: parsed.tasks ?? {} };
  } catch {
    return { tasks: {} };
  }
}

export function saveLedger(dataDir, ledger) {
  const file = ledgerPath(dataDir);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2));
  fs.renameSync(tmp, file);
}

export function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
