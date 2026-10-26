import fs from "node:fs";
import path from "node:path";

const SECRET_KEYS = ["NOTION_API_KEY", "API_KEY", "TOKEN", "SECRET"];

export function redact(text) {
  let out = String(text ?? "");
  for (const key of SECRET_KEYS) {
    const value = process.env[key];
    if (value && value.length >= 8) out = out.split(value).join("[REDACTED]");
  }
  // Notion tokens look like ntn_... / secret_... — mask anything that looks like one.
  out = out.replace(/\b(ntn|secret)_[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]");
  return out;
}

function loadEnvFile(root) {
  const file = path.join(root, ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

function normalizeDir(p) {
  const resolved = path.resolve(p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function isInsideDir(candidate, dir) {
  const c = normalizeDir(candidate);
  const d = normalizeDir(dir);
  return c === d || c.startsWith(d + path.sep);
}

export function loadConfig(root = process.cwd()) {
  loadEnvFile(root);
  const configPath = process.env.BRIDGE_CONFIG || path.join(root, "config.json");
  let fileConfig = {};
  if (fs.existsSync(configPath)) {
    fileConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  }
  const config = {
    allowedExecutors: fileConfig.allowedExecutors ?? ["opencode", "codex"],
    allowedWorkdirs: fileConfig.allowedWorkdirs ?? [],
    codexSandboxReadOnly: fileConfig.codexSandboxReadOnly ?? "read-only",
    codexSandboxWrite: fileConfig.codexSandboxWrite ?? "workspace-write",
    dataDir: path.resolve(root, fileConfig.dataDir ?? "data"),
    maxConcurrent: 1, // v1 is deliberately sequential: no parallel agents, no agent loops.
    maxRetries: Number(fileConfig.maxRetries ?? 1),
    notionApiKey: process.env.NOTION_API_KEY || "",
    notionDatabaseId: process.env.NOTION_DATABASE_ID || "",
    notionVersion: process.env.NOTION_VERSION || "2022-06-28",
    opencodeMode: fileConfig.opencodeMode ?? "run", // run | standalone | print
    pollIntervalMs: Number(fileConfig.pollIntervalMs ?? 30000),
    protectedPaths: fileConfig.protectedPaths ?? [],
    timeoutMs: Number(fileConfig.timeoutMs ?? 1800000),
    useCodingAgentRunner: Boolean(fileConfig.useCodingAgentRunner ?? false),
    allowDryRun: process.env.BRIDGE_ALLOW_DRYRUN === "1",
    root,
  };
  const errors = [];
  if (!Array.isArray(config.allowedWorkdirs) || config.allowedWorkdirs.length === 0) {
    errors.push("allowedWorkdirs is empty: register at least one test workdir in config.json before running.");
  }
  for (const dir of config.allowedWorkdirs) {
    if (!path.isAbsolute(dir)) errors.push(`allowedWorkdir is not absolute: ${dir}`);
    for (const prot of config.protectedPaths) {
      if (isInsideDir(dir, prot) || isInsideDir(prot, dir)) {
        errors.push(`allowedWorkdir overlaps protectedPath: ${dir} vs ${prot}`);
      }
    }
  }
  if (!["run", "standalone", "print"].includes(config.opencodeMode)) {
    errors.push(`opencodeMode must be run|standalone|print, got: ${config.opencodeMode}`);
  }
  if (!Number.isFinite(config.timeoutMs) || config.timeoutMs < 60000) {
    errors.push("timeoutMs must be >= 60000");
  }
  if (!Number.isFinite(config.maxRetries) || config.maxRetries < 0 || config.maxRetries > 3) {
    errors.push("maxRetries must be 0..3 (v1 cap: retries are bounded, never an open loop)");
  }
  return { config, errors, configPath };
}

export function assertWorkdir(config, workdir) {
  const resolved = path.resolve(workdir);
  if (config.protectedPaths.some((p) => isInsideDir(resolved, p))) {
    throw new Error(`workdir is inside a protected path: ${resolved}`);
  }
  if (!config.allowedWorkdirs.some((d) => isInsideDir(resolved, d))) {
    throw new Error(`workdir is not registered in allowedWorkdirs: ${resolved}`);
  }
  return resolved;
}

export function assertExecutor(config, executor) {
  if (executor === "dryrun") {
    if (!config.allowDryRun) throw new Error("dryrun executor is disabled (set BRIDGE_ALLOW_DRYRUN=1 for plumbing tests only)");
    return executor;
  }
  if (!config.allowedExecutors.includes(executor)) {
    throw new Error(`executor is not registered in allowedExecutors: ${executor}`);
  }
  return executor;
}
