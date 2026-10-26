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

  async getPrompt(pageId) {
    // Body blocks first; fall back to a Prompt rich_text property if a creator used one.
    const blocks = await this.request(`/blocks/${pageId}/children?page_size=100`, "GET");
    const lines = [];
    for (const block of blocks.results ?? []) {
      const rich = block[block.type]?.rich_text;
      const text = plainText(rich);
      if (text.trim()) lines.push(text);
    }
    if (lines.length) return lines.join("\n");
    const page = await this.getPage(pageId);
    return page.prompt || "";
  }

  async updatePage(pageId, properties) {
    return this.request(`/pages/${pageId}`, "PATCH", { properties });
  }

  async appendReport(pageId, lines) {
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
