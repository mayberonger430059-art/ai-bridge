import assert from "node:assert/strict";
import test from "node:test";
import { extractTokens } from "../src/executors.js";
import { isInsideDir, redact } from "../src/config.js";

test("allowlist: workdir inside allowed dir passes, sibling does not", () => {
  assert.equal(isInsideDir("/tmp/ai/test-workdir/sub", "/tmp/ai/test-workdir"), true);
  assert.equal(isInsideDir("/tmp/ai/test-workdir-evil", "/tmp/ai/test-workdir"), false);
  assert.equal(isInsideDir("/tmp/ai/test-workdir", "/tmp/ai/test-workdir"), true);
});

test("token parsing: codex-style JSONL usage is summed, unknown stays null", () => {
  const jsonl = [
    JSON.stringify({ type: "item", usage: { input_tokens: 100, output_tokens: 20 } }),
    JSON.stringify({ type: "item", usage: { input_tokens: 50, output_tokens: 10 } }),
  ].join("\n");
  assert.deepEqual(extractTokens(jsonl), { input: 150, output: 30, total: 180 });
  assert.equal(extractTokens("plain text, no usage at all"), null);
});

test("redaction: a secret value never survives the log path", () => {
  process.env.NOTION_API_KEY = "ntn_testsecret12345678";
  assert.equal(redact("key=ntn_testsecret12345678 end").includes("ntn_testsecret"), false);
  delete process.env.NOTION_API_KEY;
});
