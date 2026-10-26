import { redact } from "./config.js";

// Minimal Notion REST client on Node's built-in fetch. No SDK dependency on purpose:
// one less package to audit, and the exact request/response stays visible in logs.
// Schema (see notion/schema.md) — property names are fixed, not free text:
//   Title (title), TaskID (rich_text), Status (select), Executor (select),
//   Workdir (rich_text), WriteMode (select: read-only|write), Approval (select: Pending|Approved),
//   Attempts (number), ResultSummary (rich_text), Tokens (rich_text),
//   Error (rich_text), LogPath (rich_text), ChangedFiles (rich_text).
// The full instruction lives in the page body (blocks), not in a property, so long
// prompts are not truncated by a rich_text property.

export function richText(text) {
  return { rich_text: [{ type: "text", text: { content: String(text ?? "").slice(0, 1900) } }] };
}
export function select(name) {
  return { select: name ? { name } : null };
}
export function numberValue(n) {
  return { number: n };
}
export function titleProp(text) {
  return { title: [{ type: "text", text: { content: String(text ?? "").slice(0, 500) } }] };
}

function plainText(rich) {
  if (!Array.isArray(rich)) return "";
  return rich.map((item) => item?.plain_text ?? item?.text?.content ?? "").join("");
}

// Text of any block regardless of its type, used to look for a run marker without
// assuming which block type carried it.
function blockText(block) {
  if (!block || block.type === "divider") return "";
  return plainText(block[block.type]?.rich_text);
}

// A page body is instruction first, then everything the bridge appends. appendReport
// puts a divider on that boundary, so the prompt is "blocks before the first divider".
// Feeding the tail back as the prompt made a re-queued task read its own past report
// (e.g. "Approval is not 'Approved'") and refuse to do the work -- see the T3.5 drill.
// Pure on purpose: the boundary rule is the part worth testing without a network.
export function promptFromBlocks(blocks) {
  const lines = [];
  let ignoredBlocks = 0;
  let dividerSeen = false;
  for (const block of blocks ?? []) {
    if (dividerSeen) {
      ignoredBlocks += 1;
      continue;
    }
    if (block.type === "divider") {
      dividerSeen = true;
      continue;
    }
    const text = plainText(block[block.type]?.rich_text);
    if (text.trim()) lines.push(text);
  }
  return { dividerSeen, ignoredBlocks, lines };
}

// Bound on how many 100-block pages getPrompt will walk. A page longer than this
// without a divider is pathological; stopping silently would truncate the
// instruction, so the caller gets pageCapHit and can complain instead.
const MAX_PROMPT_BLOCK_PAGES = 20;

export class NotionClient {
  constructor({ apiKey, version }) {
    this.apiKey = apiKey;
    this.version = version;
  }

  async request(pathname, method, body) {
    const res = await fetch(`https://api.notion.com/v1${pathname}`, {
      body: body ? JSON.stringify(body) : undefined,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "Notion-Version": this.version,
      },
      method,
    });
    const text = await res.text();
    if (!res.ok) {
      // Review item 4: fail loudly on a suspected data-source model error
      // instead of silently changing version or data. The doctor
      // --check-notion probe lists the actual data sources.
      const dataSourceHint =
        res.status === 400 && /data.?source|2025-09-03/i.test(text)
          ? " Suspected data-source model mismatch (pinned Notion-Version is 2022-06-28; a multi-source database cannot be queried by database id). Run doctor --check-notion to list its data sources; do not silently rewrite data."
          : "";
      throw new Error(`Notion ${method} ${pathname} -> ${res.status}: ${redact(text).slice(0, 500)}${dataSourceHint}`);
    }
    return text ? JSON.parse(text) : {};
  }

  async queryQueued(databaseId) {
    const out = [];
    let cursor;
    do {
      const body = {
        filter: { property: "Status", select: { equals: "Queued" } },
        page_size: 20,
        sorts: [{ direction: "ascending", timestamp: "created_time" }],
      };
      if (cursor) body.start_cursor = cursor;
      const page = await this.request(`/databases/${databaseId}/query`, "POST", body);
      out.push(...(page.results ?? []));
      cursor = page.has_more ? page.next_cursor : undefined;
    } while (cursor);
    return out.map(parseTaskPage);
  }

  async getPage(pageId) {
    return parseTaskPage(await this.request(`/pages/${pageId}`, "GET"));
  }

  // Returns { prompt, ignoredBlocks, moreBlocksAfterDivider, pages, pageCapHit }.
  // It used to return a bare string, which made the divider boundary silent: a task
  // whose human instructions were added *after* the divider (the gate path below
  // inserts one before anyone approves) ran on the old instruction with no signal
  // at all. The caller now gets the count so it can say so out loud.
  async getPrompt(pageId) {
    // Body blocks first; fall back to a Prompt rich_text property if a creator used one.
    const blocks = [];
    let cursor;
    let pages = 0;
    let moreBlocksAfterDivider = false;
    let pageCapHit = false;
    do {
      const query = cursor ? `?page_size=100&start_cursor=${cursor}` : "?page_size=100";
      const page = await this.request(`/blocks/${pageId}/children${query}`, "GET");
      pages += 1;
      blocks.push(...(page.results ?? []));
      // Stop as soon as the boundary is on this page: nothing past it is prompt.
      if (blocks.some((block) => block.type === "divider")) {
        moreBlocksAfterDivider = Boolean(page.has_more);
        break;
      }
      cursor = page.has_more ? page.next_cursor : undefined;
      if (cursor && pages >= MAX_PROMPT_BLOCK_PAGES) {
        pageCapHit = true;
        cursor = undefined;
      }
    } while (cursor);
    const { ignoredBlocks, lines } = promptFromBlocks(blocks);
    const prompt = lines.length ? lines.join("\n") : (await this.getPage(pageId)).prompt || "";
    return { ignoredBlocks, moreBlocksAfterDivider, pageCapHit, pages, prompt };
  }

  async updatePage(pageId, properties) {
    return this.request(`/pages/${pageId}`, "PATCH", { properties });
  }

  async appendReport(pageId, lines, options = {}) {
    // Mark the boundary between the task instruction and the report before
    // appending anything, so getPrompt can stop at it. Idempotent: an existing
    // divider means the boundary is already there. The scan follows
    // pagination because a long-lived page returns at most 100 blocks per page.
    //
    // `runMarker` makes the append idempotent per run: a re-poll after a partial
    // write (properties landed, report did not) must not append the same report
    // twice. Its presence means this run's report is already on the page, so the
    // scan cannot stop at the divider - the report always lives after it.
    const runMarker = options.runMarker ?? null;
    let dividerSeen = false;
    let markerSeen = false;
    let cursor;
    do {
      const query = cursor ? `?page_size=100&start_cursor=${cursor}` : "?page_size=100";
      const page = await this.request(`/blocks/${pageId}/children${query}`, "GET");
      const results = page.results ?? [];
      if (!dividerSeen && results.some((block) => block.type === "divider")) {
        dividerSeen = true;
      }
      if (runMarker && !markerSeen) {
        markerSeen = results.some((block) => blockText(block).includes(runMarker));
      }
      if (dividerSeen && (!runMarker || markerSeen)) break;
      cursor = page.has_more ? page.next_cursor : undefined;
    } while (cursor);
    if (runMarker && markerSeen) {
      return { skipped: true, reason: "report-for-this-run-already-present" };
    }
    if (!dividerSeen) {
      await this.request(`/blocks/${pageId}/children`, "PATCH", {
        children: [{ divider: {}, object: "block", type: "divider" }],
      });
    }
    // Notion caps a block append at 100 children; chunk defensively.
    const children = lines.filter(Boolean).map((line) => ({
      object: "block",
      paragraph: { rich_text: [{ type: "text", text: { content: String(line).slice(0, 1900) } }] },
      type: "paragraph",
    }));
    for (let i = 0; i < children.length; i += 90) {
      await this.request(`/blocks/${pageId}/children`, "PATCH", {
        children: children.slice(i, i + 90),
      });
    }
  }
}

export function parseTaskPage(page) {
  const props = page.properties ?? {};
  const getSelect = (name) => props[name]?.select?.name ?? "";
  const getText = (name) => {
    const prop = props[name];
    if (!prop) return "";
    if (prop.type === "title") return plainText(prop.title);
    if (prop.type === "rich_text") return plainText(prop.rich_text);
    return "";
  };
  return {
    approval: getSelect("Approval"),
    attempts: props.Attempts?.number ?? 0,
    executor: getSelect("Executor"),
    lastEdited: page.last_edited_time ?? "",
    notionPageId: page.id,
    prompt: getText("Prompt"),
    status: getSelect("Status"),
    taskId: getText("TaskID"),
    title: getText("Title"),
    workdir: getText("Workdir"),
    writeMode: getSelect("WriteMode") || "read-only",
  };
}
