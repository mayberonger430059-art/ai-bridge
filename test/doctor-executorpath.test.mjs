import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// 这条用例补的是「接线层」缺口：前面 test/executorpaths.test.mjs 的 7 条只证明
// executorPaths 被 loadConfig 读进来并校验，没有任何一条证明它被真的用上。
// 一旦有人把 src/doctor.js 里的 `config.executorPaths?.codex || "codex"` 改回 `"codex"`，
// 那 7 条仍然全绿 —— 本条用例就是为了在那一刻变红。
//
// 为什么用真实进程 + BRIDGE_CONFIG（而不是 import 模块或变异副本）：
// 测的是现有黑盒行为，不碰 src/、不改导出；BRIDGE_CONFIG 是产品自带入口，
// 与 config.js 的 `process.env.BRIDGE_CONFIG || path.join(root,"config.json")` 一致。
//
// 为什么断言 EINVAL：fixture 是一个存在、绝对、isFile() 为真的 .bat，
// loadConfig 判定为合法（只校验 绝对/存在/是文件）→ doctor 走到 runVersion →
// execFile 无法直接执行 .bat（不经过 shell）→ 同步抛 EINVAL。
// 若 executorPaths 没被用上（退回硬编码 "codex"），命令会去 PATH 里找 → ENOENT，
// 于是 EINVAL 消失 —— 这就是"配置被接线"与"没被接线"的可判别差异。
//
// 本条用例自身的反向验证（这是它存在的理由，别删）：
//   把副本 src/doctor.js 的 `config.executorPaths?.codex || "codex"` 改回裸 `"codex"`，
//   本条用例精确红在第 4 条断言（错误码不是 EINVAL/EACCES）上，其余断言仍绿。
//   这证明它锁的是"接线有没有生效"，而不是"反正 doctor 退出码非零"。
//
// 平台：仅 win32 有意义，非 win32 直接 skip。EINVAL 来自 Node 对 .bat/.cmd 的
// 前置校验（同步抛，能被 try/catch 兜住）；POSIX 上 execFile 对不可执行文件报 EACCES，
// 且同属 uv_spawn 错误类（异步回调，try/catch 根本用不上）。因此不硬造 POSIX 等价
// fixture —— 那会写成一条"删掉 try/catch 也照样绿"的假绿测试。POSIX 侧本用例未实跑。

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const DOCTOR = path.join(REPO_ROOT, "src", "doctor.js");
const SPAWN_TIMEOUT_MS = 20000; // runVersion 内部自带 15s 上限，最坏叠加；默认超时会偶发假红

// 临时目录落在仓库根（不是 C 盘，也没有机器专属路径），前缀已被 .gitignore 的
// `test-workdir-*/` 覆盖，即使异常中断也不会把 `git status` 弄脏。
// 需要换位置时用 AIB_TEST_TMPDIR 覆盖。
function makeTmpDir(t, prefix) {
  const base = process.env.AIB_TEST_TMPDIR || REPO_ROOT;
  const dir = fs.mkdtempSync(path.join(base, prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// 写一份"其它字段全合法"的配置；extra 用来注入/省略 executorPaths。
function writeConfig(dir, extra) {
  const workdir = path.join(dir, "work");
  fs.mkdirSync(workdir, { recursive: true });
  const configPath = path.join(dir, "config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      allowedExecutors: ["opencode", "codex"],
      allowedWorkdirs: [workdir],
      opencodeMode: "run",
      protectedPaths: [],
      timeoutMs: 1800000,
      maxRetries: 1,
      ...extra,
    }, null, 2),
    "utf8",
  );
  return configPath;
}

function runDoctor(configPath) {
  const r = spawnSync(process.execPath, [DOCTOR], {
    cwd: REPO_ROOT, // .env 按 process.cwd() 读；固定 cwd 免得 NOTION_* 那几行随环境漂移
    encoding: "utf8",
    timeout: SPAWN_TIMEOUT_MS,
    env: { ...process.env, BRIDGE_CONFIG: configPath },
  });
  return { status: r.status, stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? ""), error: r.error };
}

test("接线层：doctor.js 真的把 executorPaths.codex 当作要执行的命令", (t) => {
  if (process.platform !== "win32") {
    // 不硬造 POSIX 等价 fixture：审查员实测「同步抛 vs 异步回调」取决于失败种类而非平台，
    // 0644 文件很可能走回调路径（本来就不会崩）→ 那条用例即使删掉 try/catch 也会绿，
    // 对"catch 生效"零约束，等于再造一条假绿测试。宁缺勿假绿。
    t.skip("EINVAL 是 Windows 上 execFile 直执行 .bat 的特有形态；POSIX 等价物未验证且可能产生假绿");
    return;
  }

  const dir = makeTmpDir(t, "test-workdir-doctor-");
  t.diagnostic(`fixture dir = ${dir}`);

  // fixture：存在、绝对、是文件，但 execFile 不能直接执行
  const target = path.join(dir, "fake-codex.bat");
  fs.writeFileSync(target, "@echo off\r\necho fake-codex 0.0.0\r\n", "utf8");
  assert.equal(fs.statSync(target).isFile(), true);

  const withPaths = writeConfig(dir, { executorPaths: { codex: target } });
  const r = runDoctor(withPaths);
  t.diagnostic(`[带 executorPaths] exit=${r.status} stdout=${r.stdout.length}B stderr=${r.stderr.length}B`);
  assert.equal(r.error, undefined, `doctor 未能在 ${SPAWN_TIMEOUT_MS}ms 内结束：${r.error?.message ?? ""}`);

  // 1) 证明 BRIDGE_CONFIG 真被采纳 + fixture 合法（否则读到的可能是环境里别的配置）
  assert.match(r.stdout, /^PASS {2}config\.json valid/m, "临时配置未被加载或校验未通过");
  // 2) 证明 doctor 确实走到了 codex 这一项（node>=20 在它之前，作为"没更早崩"的锚点）
  assert.match(r.stdout, /^PASS {2}node>=20/m, "doctor 未打印 node>=20 检查项");
  // 3) 靶向的那条失败
  assert.match(r.stdout, /^FAIL {2}codex CLI available/m, "codex CLI available 未报 FAIL");
  // 4) 核心守卫：错误码证明 execFile 尝试执行了我们给的绝对路径（退回硬编码会变 ENOENT）
  //    EINVAL = Windows 上 .bat 的前置校验同步抛出；EACCES 为 POSIX 语义保留余量。
  assert.match(r.stdout, /EINVAL|EACCES/, "错误码不是 EINVAL/EACCES：executorPaths 未被当作命令使用");
  // 5) 崩溃点之后仍然跑完（结尾汇总行在所有检查之后才打印）
  assert.match(r.stdout, /^Doctor result: /m, "未打印结尾汇总行：doctor 在 codex 检查处崩了");
  // 6) stderr 应为空：runVersion 的 try/catch 兜住了同步抛出，没有冒到进程顶部
  assert.equal(r.stderr.trim(), "", `stderr 不该有内容（说明异常冒出了 catch）：${r.stderr}`);
  // 不断言 exitCode：.bat 的 EINVAL 可能在子进程存在之前就发生，exitCode 可能是 null、
  // 也可能被信号结束 —— 断言它等于 1 会让用例不稳定。

  // 反向自检：同一套断言在"不带 executorPaths"的配置下不成立 —— 排除
  // "任何配置下 doctor 的 codex 项都会 EINVAL" 这种假绿。
  // 注意判别式只有 EINVAL 一个：不能断言这一行是 FAIL，因为装了 codex 的正常开发机上
  // 它是 PASS —— 那会让用例在别人的机器上假红（假红比假绿更糟：下一个人会去改对的代码）。
  const withoutPaths = writeConfig(dir, {});
  const r2 = runDoctor(withoutPaths);
  t.diagnostic(`[不带 executorPaths] exit=${r2.status} stdout=${r2.stdout.length}B stderr=${r2.stderr.length}B`);
  const codexLine2 = r2.stdout.split(/\r?\n/).find((l) => l.includes("codex CLI available")) || "";
  assert.ok(codexLine2.length > 0, "缺省配置下 doctor 未打印 codex 检查项");
  assert.doesNotMatch(codexLine2, /EINVAL|EACCES/, "不带 executorPaths 时仍出现 EINVAL/EACCES：该错误码与 executorPaths 无关，本用例无效");
});
