import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, resolveExecutorCommand } from "./config.js";

// One-click environment diagnosis. It never prints a secret, never runs a model,
// and never writes outside data/ (it only reads config/.env presence).
function runVersion(command, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = execFile(command, args, { timeout: 15000, windowsHide: true }, (err, stdout, stderr) => {
        const out = String(stdout || stderr || "").trim().split(/\r?\n/)[0] || "";
        resolve(err ? { found: false, detail: out || err.message } : { detail: out, found: true });
      });
      child.stdin?.end();
    } catch (err) {
      // execFile throws SYNCHRONOUSLY for some targets — e.g. a .bat/.cmd path on
      // Windows gives EINVAL, because execFile cannot exec a script directly and
      // does not go through the shell like exec/spawn with shell:true would.
      // A diagnostic tool must never die here: report this one check as failed
      // and let the remaining checks print.
      resolve({ detail: `${err.code ?? "ERROR"}: ${err.message}`, found: false });
    }
  });
}

async function main() {
  const args = process.argv.slice(2);
  const checkNotion = args.includes("--check-notion");
  const { config, errors } = loadConfig();
  const checks = [];
  const nodeOk = Number(process.versions.node.split(".")[0]) >= 20;
  checks.push({ check: "node>=20", ok: nodeOk, detail: process.version });
  checks.push({ check: "config.json valid", detail: errors.length ? errors.join("; ") : "ok", ok: errors.length === 0 });
  checks.push({ check: "NOTION_API_KEY set", detail: config.notionApiKey ? "set (value hidden)" : "missing in .env", ok: Boolean(config.notionApiKey) });
  checks.push({ check: "NOTION_DATABASE_ID set", detail: config.notionDatabaseId ? "set (value hidden)" : "missing in .env", ok: Boolean(config.notionDatabaseId) });
  for (const dir of config.allowedWorkdirs) {
    checks.push({ check: `workdir exists: ${dir}`, detail: fs.existsSync(dir) ? "exists" : "MISSING — create it or fix config.json", ok: fs.existsSync(dir) });
  }
  const codexCommand = resolveExecutorCommand(config, "codex");
  const codex = await runVersion(codexCommand, ["--version"]);
  checks.push({ check: "codex CLI available", detail: codex.detail, ok: codex.found });
  const opencodeCommand = resolveExecutorCommand(config, "opencode");
  const opencode = await runVersion(opencodeCommand, ["--version"]);
  checks.push({ check: "opencode CLI available", detail: opencode.detail, ok: opencode.found });
  const git = await runVersion("git", ["--version"]);
  checks.push({ check: "git on PATH (for changed-files diff)", detail: git.detail, ok: git.found });
  if (!codex.found && !opencode.found) {
    checks.push({ check: "at least one executor available", detail: "neither codex nor opencode was found", ok: false });
  } else {
    checks.push({ check: "at least one executor available", detail: "ok", ok: true });
  }
  if (checkNotion) {
    if (!config.notionApiKey || !config.notionDatabaseId) {
      checks.push({ check: "notion connectivity", detail: "skipped: key/database missing", ok: false });
    } else {
      try {
        const { NotionClient } = await import("./notion.js");
        const notion = new NotionClient({ apiKey: config.notionApiKey, version: config.notionVersion });
        const queued = await notion.queryQueued(config.notionDatabaseId);
        checks.push({ check: "notion connectivity (query Queued)", detail: `ok, ${queued.length} queued`, ok: true });
        // Review item 4: data-source probe using the existing client (no
        // second Notion client). A multi-source database cannot be queried
        // by database id on the pinned version; report it plainly, never
        // silently rewrite user data or bump the version.
        try {
          const db = await notion.request(`/databases/${config.notionDatabaseId}`, "GET");
          const sources = Array.isArray(db?.data_sources) ? db.data_sources : [];
          if (sources.length > 1) {
            checks.push({
              check: "notion data-source model",
              detail: `FAIL: ${sources.length} data sources (${sources.map((d) => `${d.name || "?"}=${d.id}`).join(", ")}). Point NOTION_DATABASE_ID at a single-source database.`,
              ok: false,
            });
          } else {
            checks.push({ check: "notion data-source model", detail: `ok, single source on Notion-Version ${config.notionVersion}`, ok: true });
          }
        } catch (probeErr) {
          checks.push({ check: "notion data-source model", detail: `probe failed (query above still decides): ${String(probeErr.message).slice(0, 200)}`, ok: false });
        }
      } catch (err) {
        checks.push({ check: "notion connectivity (query Queued)", detail: String(err.message).slice(0, 300), ok: false });
      }
    }
  }
  for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.check}  —  ${c.detail}`);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) {
    console.log(`\nDoctor result: ${failed.length} check(s) failed. Fix the FAIL lines above, then re-run.`);
    process.exit(1);
  }
  console.log("\nDoctor result: all checks passed. Next: run the dry-run test, then a real Notion task (see README).");
  void path;
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
