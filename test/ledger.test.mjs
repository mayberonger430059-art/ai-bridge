import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadLedger, saveLedger } from "../src/ledger.js";

test("ledger: a completed entry survives reload (idempotency anchor)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-bridge-ledger-"));
  const ledger = loadLedger(dir);
  ledger.tasks["page-1"] = { status: "done", taskId: "BR-TEST-001" };
  saveLedger(dir, ledger);
  assert.equal(loadLedger(dir).tasks["page-1"].status, "done");
});
