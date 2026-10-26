import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { AttemptTracker } from "../src/attempts.js";
import { evaluateApprovalGate } from "../src/gate.js";
import { killProcessTree } from "../src/killtree.js";
import { acquireSingleInstanceLock, readPid } from "../src/lock.js";
import { parseTaskPage } from "../src/notion.js";
import { extractResult } from "../src/parse-output.js";
import { assertWorkdirAllowed, firstSymlinkBetween, isInsideDir } from "../src/safepath.js";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aib-review-"));
}

test("review item 1: symlink escape is blocked by realpath", () => {
  const root = tmp();
  const allowed = path.join(root, "white");
  const outside = path.join(root, "outside");
  fs.mkdirSync(allowed, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.symlinkSync(outside, path.join(allowed, "link"), "dir");
  assert.equal(isInsideDir(path.join(allowed, "link", "secret.txt"), allowed), false);
  assert.equal(isInsideDir(path.join(allowed, "ok"), allowed), true);
  assert.equal(isInsideDir(path.join(root, "dir-evil"), path.join(root, "dir")), false);
  assert.ok(firstSymlinkBetween(path.join(allowed, "link", "work"), allowed));
  assert.throws(() => assertWorkdirAllowed(path.join(allowed, "link", "work"), { allowList: [allowed], rejectSymlinks: true }), /symlink|allow-list/);
  assert.doesNotThrow(() => assertWorkdirAllowed(path.join(allowed, "ok"), { allowList: [allowed], protectedPaths: [] }));
});

test("review item 1: not-yet-created leaf resolves via nearest existing ancestor", () => {
  const root = tmp();
  const allowed = path.join(root, "white");
  fs.mkdirSync(allowed, { recursive: true });
  assert.equal(isInsideDir(path.join(allowed, "will", "exist", "later"), allowed), true);
});

test("review item 3: structured output wins, garbage falls back to raw-tail + unknown", () => {
  const lines = [
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "intermediate" } }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "FINAL ANSWER" } }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } }),
  ].join("\n");
  const r = extractResult(lines);
  assert.equal(r.outputSource, "structured");
  assert.equal(r.output, "FINAL ANSWER");
  assert.equal(r.usage.inputTokens, 10);
  const noise = "x".repeat(9000) + "\nTRAILING TEXT ONLY";
  const g = extractResult(noise, { fallbackTailBytes: 8000 });
  assert.equal(g.outputSource, "raw-tail");
  assert.ok(g.output.endsWith("TRAILING TEXT ONLY"));
  assert.equal(g.usage.inputTokens, "unknown");
});

test("review item 5: AttemptTracker counts real calls and enforces hard cap 3", () => {
  const tr = new AttemptTracker(0, { maxRetries: 1, hardCap: 3 });
  assert.equal(tr.next(), 1);
  assert.equal(tr.next(), 2);
  assert.equal(tr.canAttempt(), false);
  assert.equal(tr.total, 2);
  const capped = new AttemptTracker(2, { maxRetries: 3, hardCap: 3 });
  assert.equal(capped.remainingThisRun(), 1);
  assert.equal(capped.next(), 3);
  assert.throws(() => capped.next(), /budget exhausted/);
});

test("review item 6: PID lock acquire / live owner / stale reclaim", () => {
  const dir = tmp();
  const lf = path.join(dir, "bridge.lock");
  const r = acquireSingleInstanceLock(lf);
  assert.equal(r.ok, true);
  assert.equal(readPid(lf), process.pid);
  r.release();
  assert.equal(fs.existsSync(lf), false);
  fs.writeFileSync(lf, String(process.ppid));
  const blocked = acquireSingleInstanceLock(lf);
  assert.equal(blocked.ok, false);
  fs.writeFileSync(lf, "2147480000");
  const reclaimed = acquireSingleInstanceLock(lf);
  assert.equal(reclaimed.ok, true);
  reclaimed.release();
});

test("review item 2: killProcessTree reaps a spawned child tree", async () => {
  const child = spawn(process.execPath, ["-e", "const {spawn}=require('child_process'); spawn(process.execPath, ['-e','setInterval(()=>{},1e9)'], {stdio:'ignore'}); setInterval(()=>{},1e9);"], {
    detached: process.platform !== "win32",
    stdio: "ignore",
  });
  const res = await killProcessTree(child, { graceMs: 200, hardMs: 5000 });
  assert.equal(res.ok, true);
  // Signal-killed processes report signalCode (exitCode stays null) — that
  // is the expected killed state, not a failure to reap.
  assert.ok(child.signalCode !== null || child.exitCode !== null);
});

test("review item 7: real parseTaskPage maps the real schema, gate uses write/Approved", () => {
  const page = {
    id: "page-1",
    properties: {
      Title: { type: "title", title: [{ plain_text: "demo" }] },
      TaskID: { type: "rich_text", rich_text: [{ plain_text: "BR-001" }] },
      Status: { select: { name: "Queued" } },
      Executor: { select: { name: "codex" } },
      Workdir: { type: "rich_text", rich_text: [{ plain_text: "D:\\AI-Bridge\\test-workdir" }] },
      WriteMode: { select: { name: "write" } },
      Approval: { select: { name: "Pending" } },
      Attempts: { number: 2 },
    },
  };
  const t = parseTaskPage(page);
  assert.equal(t.taskId, "BR-001");
  assert.equal(t.writeMode, "write");
  assert.equal(t.approval, "Pending");
  assert.equal(t.attempts, 2);
  assert.equal(evaluateApprovalGate(t), "needs-approval");
  assert.equal(evaluateApprovalGate({ ...t, approval: "Approved" }), "proceed");
  assert.equal(evaluateApprovalGate({ ...t, writeMode: "read-only" }), "proceed");
});
