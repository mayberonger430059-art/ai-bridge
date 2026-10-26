import assert from "node:assert/strict";
import test from "node:test";
import { NotionClient, promptFromBlocks } from "../src/notion.js";

// The divider rule had no tests at all before this file, and it is the rule that
// decides what a task actually gets told to do. Everything here runs offline: the
// client is real, only its `request` method is replaced, so pagination is exercised
// for real instead of being asserted from the source text.

const para = (text) => ({ object: "block", paragraph: { rich_text: [{ plain_text: text }] }, type: "paragraph" });
const divider = () => ({ divider: {}, object: "block", type: "divider" });

// Pages are served by index; a `start_cursor=N` request gets pages[N].
function stubClient(pages) {
  const calls = [];
  const client = new NotionClient({ apiKey: "test-key", version: "2022-06-28" });
  client.request = async (pathname) => {
    calls.push(pathname);
    if (pathname.startsWith("/pages/")) return { id: "page", properties: {} };
    const cursor = /start_cursor=(\d+)/.exec(pathname);
    return pages[cursor ? Number(cursor[1]) : 0];
  };
  return { calls, client };
}

test("promptFromBlocks: everything after the divider is execution history, not prompt", () => {
  const r = promptFromBlocks([para("line 1"), para("line 2"), divider(), para("AI Bridge result"), para("Tokens: x")]);
  assert.deepEqual(r.lines, ["line 1", "line 2"]);
  assert.equal(r.dividerSeen, true);
  assert.equal(r.ignoredBlocks, 2);
});

test("promptFromBlocks: a page without a divider keeps the read-everything behaviour", () => {
  const r = promptFromBlocks([para("a"), para("b")]);
  assert.deepEqual(r.lines, ["a", "b"]);
  assert.equal(r.dividerSeen, false);
  assert.equal(r.ignoredBlocks, 0);
});

test("promptFromBlocks: empty paragraphs are dropped but blank blocks after the divider still count", () => {
  const r = promptFromBlocks([para("keep"), para("   "), divider(), para(""), para("")]);
  assert.deepEqual(r.lines, ["keep"]);
  assert.equal(r.ignoredBlocks, 2);
});

test("getPrompt: reports how many blocks after the divider were ignored", async () => {
  const { client } = stubClient([{ has_more: false, results: [para("do the thing"), divider(), para("AI Bridge result: Done")] }]);
  const r = await client.getPrompt("page-1");
  assert.equal(r.prompt, "do the thing");
  assert.equal(r.ignoredBlocks, 1);
  assert.equal(r.moreBlocksAfterDivider, false);
  assert.equal(r.pageCapHit, false);
  assert.equal(r.pages, 1);
});

// This is the regression the divider fix left behind: getPrompt read exactly one
// page (page_size=100, no cursor), while appendReport's divider probe walked pages.
// On any page whose divider sits past block 100 the boundary is invisible, so the
// report tail is fed back as the instruction again.
test("getPrompt: finds a divider that lives beyond the first page of blocks", async () => {
  const pages = [
    { has_more: true, next_cursor: "1", results: [para("instruction A")] },
    { has_more: false, results: [para("instruction B"), divider(), para("report")] },
  ];
  const { calls, client } = stubClient(pages);
  const r = await client.getPrompt("page-2");
  assert.equal(r.prompt, "instruction A\ninstruction B");
  assert.equal(r.ignoredBlocks, 1);
  assert.equal(r.pages, 2);
  assert.ok(calls.some((c) => c.includes("start_cursor=1")), "expected getPrompt to request the second page");
});

test("getPrompt: stops paging as soon as the divider is on the page", async () => {
  const { calls, client } = stubClient([
    { has_more: true, next_cursor: "1", results: [para("instruction"), divider(), para("report")] },
    { has_more: false, results: [para("never fetched")] },
  ]);
  const r = await client.getPrompt("page-3");
  assert.equal(calls.length, 1, "must not spend a second request once the boundary is known");
  assert.equal(r.moreBlocksAfterDivider, true);
  assert.equal(r.prompt, "instruction");
});

test("getPrompt: caps the walk and says so rather than truncating silently", async () => {
  const pages = Array.from({ length: 25 }, (_, i) => ({
    has_more: true,
    next_cursor: String(i + 1),
    results: [para(`block ${i}`)],
  }));
  const { calls, client } = stubClient(pages);
  const r = await client.getPrompt("page-4");
  assert.equal(r.pageCapHit, true);
  assert.equal(r.pages, 20);
  assert.equal(calls.length, 20);
});

test("getPrompt: falls back to the Prompt property when the body has no text", async () => {
  const client = new NotionClient({ apiKey: "test-key", version: "2022-06-28" });
  client.request = async (pathname) => {
    if (pathname.startsWith("/pages/")) {
      return {
        id: "page",
        properties: { Prompt: { type: "rich_text", rich_text: [{ plain_text: "from the property" }] } },
      };
    }
    return { has_more: false, results: [] };
  };
  const r = await client.getPrompt("page-5");
  assert.equal(r.prompt, "from the property");
  assert.equal(r.ignoredBlocks, 0);
  assert.equal(r.pageCapHit, false);
});
