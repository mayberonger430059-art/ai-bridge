// Robust extraction of the final agent message from Codex / OpenCode CLI
// output, adapted from the Notion Claude review bundle (src/parse-output.js,
// CommonJS) to ESM. Token usage is deliberately NOT taken from here: v0.1
// sums usage across JSONL events (see extractTokens in executors.js, with a
// passing test for summing), while the bundle's extractResult keeps only the
// last usage, which would undercount multi-turn runs. This module is used
// for the output text only; tokens keep the v0.1 summing behaviour.

export const UNKNOWN_USAGE = Object.freeze({
  inputTokens: "unknown",
  outputTokens: "unknown",
  totalTokens: "unknown",
});

function* iterJsonLines(text) {
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || (line[0] !== "{" && line[0] !== "[")) continue;
    try {
      yield JSON.parse(line);
    } catch {}
  }
}

function firstNonEmptyString(...vals) {
  for (const v of vals) if (typeof v === "string" && v.trim() !== "") return v;
  return null;
}

function pickNum(...vals) {
  for (const v of vals) if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}

export function readUsage(obj) {
  if (!obj || typeof obj !== "object") return null;
  const u =
    obj.usage ||
    obj.token_usage ||
    obj.tokenUsage ||
    (obj.msg && obj.msg.usage) ||
    (obj.info && obj.info.tokens) ||
    (obj.tokens && typeof obj.tokens === "object" ? obj.tokens : null);
  if (!u || typeof u !== "object") return null;
  const input = pickNum(u.input_tokens, u.inputTokens, u.prompt_tokens, u.input, u.prompt);
  const output = pickNum(u.output_tokens, u.outputTokens, u.completion_tokens, u.output, u.completion);
  const total = pickNum(u.total_tokens, u.totalTokens, u.total);
  if (input == null && output == null && total == null) return null;
  return {
    inputTokens: input == null ? "unknown" : input,
    outputTokens: output == null ? "unknown" : output,
    totalTokens:
      total != null ? total : typeof input === "number" && typeof output === "number" ? input + output : "unknown",
  };
}

function flattenContent(content) {
  if (content == null) return null;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content.map((c) => (typeof c === "string" ? c : firstNonEmptyString(c && c.text))).filter(Boolean);
    return parts.length ? parts.join("") : null;
  }
  return firstNonEmptyString(content.text);
}

export function readEventText(ev) {
  if (!ev || typeof ev !== "object") return null;
  if (ev.type === "item.completed" && ev.item) {
    const it = ev.item;
    if (it.type === "agent_message" || it.type === "message" || it.role === "assistant") {
      return firstNonEmptyString(it.text, flattenContent(it.content));
    }
  }
  if (ev.msg && typeof ev.msg === "object") {
    const m = ev.msg;
    if (m.type === "agent_message" || m.type === "assistant_message") {
      return firstNonEmptyString(m.message, m.text, flattenContent(m.content));
    }
  }
  if (ev.type === "message" && (ev.role === "assistant" || !ev.role)) {
    return firstNonEmptyString(ev.text, flattenContent(ev.parts), flattenContent(ev.content));
  }
  if (ev.part && ev.part.type === "text") {
    return firstNonEmptyString(ev.part.text);
  }
  return firstNonEmptyString(ev.final_message, ev.finalText, ev.text, ev.message);
}

function deepFindText(node, depth = 0) {
  if (depth > 6 || node == null) return null;
  const direct = readEventText(node);
  if (direct) return direct;
  if (Array.isArray(node)) {
    for (let i = node.length - 1; i >= 0; i--) {
      const r = deepFindText(node[i], depth + 1);
      if (r) return r;
    }
  } else if (typeof node === "object") {
    for (const k of ["messages", "parts", "items", "output", "result", "data"]) {
      if (node[k] != null) {
        const r = deepFindText(node[k], depth + 1);
        if (r) return r;
      }
    }
  }
  return null;
}

function deepFindUsage(node, depth = 0) {
  if (depth > 6 || node == null || typeof node !== "object") return null;
  const u = readUsage(node);
  if (u) return u;
  for (const v of Object.values(node)) {
    if (v && typeof v === "object") {
      const r = deepFindUsage(v, depth + 1);
      if (r) return r;
    }
  }
  return null;
}

export function extractResult(stdout, opts = {}) {
  const { fallbackTailBytes = 8000 } = opts;
  let lastText = null;
  let lastUsage = null;
  for (const ev of iterJsonLines(stdout)) {
    const t = readEventText(ev);
    if (t) lastText = t;
    const u = readUsage(ev);
    if (u) lastUsage = u;
  }
  if (!lastText || !lastUsage) {
    try {
      const doc = JSON.parse(String(stdout).trim());
      if (!lastUsage) lastUsage = readUsage(doc) || deepFindUsage(doc);
      if (!lastText) lastText = deepFindText(doc);
    } catch {}
  }
  if (lastText && lastText.trim() !== "") {
    return { output: lastText, outputSource: "structured", usage: lastUsage || UNKNOWN_USAGE };
  }
  const s = String(stdout);
  const tail = s.length > fallbackTailBytes ? s.slice(-fallbackTailBytes) : s;
  return { output: tail, outputSource: "raw-tail", usage: lastUsage || UNKNOWN_USAGE };
}
