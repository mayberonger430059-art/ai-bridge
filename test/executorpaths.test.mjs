import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// 被测模块的解析方式（为了"反向验证"不污染工作树）：
//   默认：加载真实源码 ../src/config.js —— 日常跑测试、CI 都是这一条路径。
//   可选：设 AIB_TEST_CONFIG_MODULE=<某个副本路径> 时加载副本。
// 反向验证（变异测试）的做法就是：把 src/config.js + src/safepath.js 复制到临时目录，
// 只改副本，再让本文件去跑副本。这样"证明测试能抓到 bug"不需要让 src/ 进入半坏状态，
// 同工作树上的其他人不会被中间态打断。
// ---------------------------------------------------------------------------
function resolveConfigModule(spec) {
  if (!spec) return new URL("../src/config.js", import.meta.url).href;
  // file:/data:/node: 之类直接当 URL 用；Windows 盘符（C:\ / C:/）要按路径处理
  if (/^[a-z][a-z0-9+.-]*:/i.test(spec) && !/^[a-z]:[\\/]/i.test(spec)) return spec;
  return pathToFileURL(path.resolve(spec)).href;
}

const CONFIG_MODULE = resolveConfigModule(
  // 测试专用后门：仅用于变异测试（跑被改坏的副本），生产路径不得设置此变量；
  // 未设时行为与直接 import "../src/config.js" 完全一致。
  process.env.AIB_TEST_CONFIG_MODULE,
);
const { loadConfig } = await import(CONFIG_MODULE);

// executorPaths 是本批次唯一新增的校验逻辑，这里 7 条用例覆盖它的三类走向：
// 合法放行（1、7）、单个键不合法（2、3、4、5）、整体类型不合法（6）。
//
// 设计要点：
// - "真实存在的绝对文件" 用 process.execPath（当前 node 可执行文件），跨平台且永不失效，
//   不硬编码任何 Windows 路径。
// - 每条测试自己造临时目录 + 临时 config.json，loadConfig(tmpDir) 只读这份文件，
//   测完立刻删目录，用例之间互不干扰，也不碰仓库里真实的 config.json。
// - 其它字段一律显式写成合法值，保证 errors 里出现的只可能是 executorPaths 的问题
//   （否则 allowedWorkdirs / timeoutMs 之类的报错会污染断言）。

const REAL_FILE = process.execPath; // 真实存在的绝对文件（node.exe / node）

// 其它字段全部合法的基线配置：各用例唯一变化的就是注入的 executorPaths。
function baseConfig(workdir) {
  return {
    allowedExecutors: ["opencode", "codex"],
    allowedWorkdirs: [workdir],
    opencodeMode: "run",
    protectedPaths: [],
    timeoutMs: 1800000,
    maxRetries: 1,
  };
}

// loadConfig 内部是 `process.env.BRIDGE_CONFIG || path.join(root, "config.json")`：
// 只要环境里带了这个变量，这里自造的临时 config 会被**整体绕过**，7 条用例全红
// （Vic 实测：`BRIDGE_CONFIG=/d/AI-Bridge/config.json node --test test/executorpaths.test.mjs`
// → 0 pass / 7 fail）。那不是校验坏了，是读错了文件，极易误导下一个人去改本来正确的代码。
// 所以加载期间临时摘掉它，结束后按原样恢复（包括"原本不存在"的情况）。
function withoutBridgeConfig(fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, "BRIDGE_CONFIG");
  const saved = process.env.BRIDGE_CONFIG;
  delete process.env.BRIDGE_CONFIG;
  try {
    return fn();
  } finally {
    if (had) process.env.BRIDGE_CONFIG = saved;
    else delete process.env.BRIDGE_CONFIG;
  }
}

// 造临时根目录 -> 写入 config.json -> loadConfig(dir) -> 交给断言。
// patch 可以是对象，也可以是 (dir) => patch 的函数（需要引用目录本身时用）。
// t.after 保证无论断言成败都会清掉临时目录。
function loadFromTmpConfig(t, patch) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aib-cfg-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fileConfig = { ...baseConfig(dir), ...(typeof patch === "function" ? patch(dir) : patch) };
  if (fileConfig.executorPaths === undefined) delete fileConfig.executorPaths;
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(fileConfig, null, 2), "utf8");
  return { dir, ...withoutBridgeConfig(() => loadConfig(dir)) };
}

test("executorPaths 1/7 合法配置：真实存在的绝对文件不产生任何 error", (t) => {
  const { errors, config } = loadFromTmpConfig(t, { executorPaths: { codex: REAL_FILE } });
  assert.deepEqual(errors, []);
  assert.equal(config.executorPaths.codex, REAL_FILE);
});

test("executorPaths 2/7 相对路径：报 1 条错并点明 executorPaths.codex", (t) => {
  const { errors } = loadFromTmpConfig(t, { executorPaths: { codex: "codex.exe" } });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /executorPaths\.codex/);
});

test("executorPaths 3/7 文件不存在：绝对但路径不存在的文件报 1 条错", (t) => {
  // 绝对、且先断言确实不存在，避免撞上真实文件导致假绿
  const missing = path.join(os.tmpdir(), `aib-cfg-missing-${process.pid}-${Date.now()}`, "codex.exe");
  assert.equal(fs.existsSync(missing), false);
  const { errors } = loadFromTmpConfig(t, { executorPaths: { codex: missing } });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /executorPaths\.codex must point to an existing absolute executable file/);
});

test("executorPaths 4/7 未知键：只允许 codex/opencode，其它键名报 1 条错", (t) => {
  const { errors } = loadFromTmpConfig(t, { executorPaths: { codexx: REAL_FILE } });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /executorPaths\.codexx/);
});

test("executorPaths 5/7 指向目录而非文件：绝对且存在但非文件时报 1 条错", (t) => {
  const { errors } = loadFromTmpConfig(t, (dir) => {
    assert.equal(fs.statSync(dir).isFile(), false); // 前提：确实是目录
    return { executorPaths: { codex: dir } };
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /executorPaths\.codex/);
});

test("executorPaths 6/7 类型错误：数组不是 object，报 1 条 must be an object", (t) => {
  const { errors } = loadFromTmpConfig(t, { executorPaths: [] });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /executorPaths must be an object/);
});

test("executorPaths 7/7 缺省不配：默认空对象，不应该报错", (t) => {
  const { errors, config } = loadFromTmpConfig(t, {});
  assert.deepEqual(errors, []);
  assert.deepEqual(config.executorPaths, {});
});
