# Claude 评审落地记录（2026-10-26）

## 来源与核验

- 来源：用户 2026-10-26 在 Notion App 内调用 Claude 得到的评审，bundle
  `ai-bridge-review.zip`（23 个文件，REVIEW.md + 9 个 src + 5 个 test +
  fixture + start-bridge.bat），已解包到助手侧隔离目录核查，未直接
  覆盖仓库。
- 复验（Linux，Node v24.22.1）：bundle 自带测试
  `node --test test/*.test.js` = **24/24 通过**，与 Claude 自述一致。
  但 bundle 是无真实源码的参考实现，不是逐行 diff，落地时做了下面
  的适配，**不是原样复制**。

## 落地内容（已接入真实 v0.1 代码）

1. **路径逃逸**：新增 `src/safepath.js`（ESM 版），`config.js` 的
   `isInsideDir` / `assertWorkdir` 改走 realpath 版本。白名单内软链
   指向白名单外现在被挡；未创建叶子按最近已存在祖先解析；
   `assertWorkdir` 增加 protected 双向重叠检查和软链组件拒绝
   （默认 `rejectSymlinks: true`，白名单根本身是真实目录时不受影响）。
2. **取消/杀进程**：新增 `src/killtree.js`（ESM 版 + PID 版
   `killTreeByPid` 供 Notion 取消监听用）。`executors.js` 的
   `runProcess` 在 POSIX 下改为 detached spawn（组杀前提），超时
   走 graceful → taskkill /T /F 或组 SIGKILL → 15 秒硬 deadline，
   另加 20 秒兜底解析避免僵尸子进程永久挂起桥接。
   未采用 bundle 的 `run.js`：它把 stdout/stderr 全量缓存在内存
   （2 MiB 截断），真实桥接把日志写文件，改用文件流更稳。
3. **输出解析**：新增 `src/parse-output.js`（ESM 版），
   `executors.js` 的输出改为结构化最后一条 agent 消息优先，
   解析不到时回落 raw tail 并可从 outputSource 看出降级。
   Token 仍用 v0.1 的 `extractTokens` 跨事件求和，未采用 bundle
   的 last-only usage（会低估多轮调用，且与现有求和测试冲突）。
4. **Notion 版本**：未引入 bundle 的第二套 Notion fetch 客户端。
   改为用现有 `NotionClient`：`notion.js` 对疑似 data-source 的
   400 报错加明确提示（不改版本、不静默改写）；`doctor.js`
   `--check-notion` 增加 data-source 探测（列出多源时 FAIL 并
   列出各源名字和 id）。
5. **Attempts 计数**：新增 `src/attempts.js`（ESM 版），
   `bridge.js` 改为每次真实调用前 `tracker.next()`、结束写回
   一次，`Attempts` 恒等于真实调用次数。新增硬上限 3（跨 run
   累计）：Notion Attempts 已是 3 的任务不再执行，须人工在
   Notion 里清零 Attempts 才能重跑。这是相对 v0.1 的收紧，
   原 v0.1 只在单 run 内限 maxRetries。
6. **单实例**：新增 `src/lock.js`（ESM 版），`bridge.js` 启动时
   在 `dataDir/bridge.lock` 上拿原子 PID 锁；第二个实例直接
   退出并报持有者 pid；死 owner 的陈旧锁自动回收。
7. **测试与审批 gate**：未采用 bundle 的 `task.js`，因为它与
   真实 schema 不符（它用 workspace-write / approved /
   rejected，而真实 schema 是 write / Pending / Approved，见
   `notion/schema.md`）。改为抽出 `src/gate.js`
   （read-only 直接放行，write 必须 Approved），`bridge.js`
   改调它；新增 `test/review.test.mjs` 覆盖 safepath、解析、
   Attempts、PID 锁、杀进程树、真实 parseTaskPage 与 gate。
8. **Windows 启动器**：新增 `scripts/start-bridge.bat`，按仓库
   布局改写（文件在 scripts/，根目录取 `%~dp0\..`，跑
   `--poll`），其余与 bundle 一致（无 BOM、Node>=20 校验、
   缺 .env 时 pause、非 0 退出 pause）。

## 本地验证（2026-10-26，Linux）

- 全部测试：`node --test test/*.test.mjs` = **11/11 通过**
  （原 4 项无回归 + 新增 7 项）。
- dry-run：用 `/tmp` 工作目录 + `BRIDGE_ALLOW_DRYRUN=1` 跑
  `bridge.js --once --local-task`，outcome=done，marker 文件
  已生成，PID 锁在退出后已清除。
- 第二实例：手动放一个活 pid 的 `bridge.lock` 后再跑，
  桥接直接退出并报“another bridge instance is already running”，
  未执行任务。
- 语法：全部 `src/*.js` / `src/runners/*.mjs` 经 `node --check` 通过。

## 仍未验证（须 Windows 本机实测，不得写成已验证）

与 bundle 文末清单一致：taskkill /T /F 对真实 codex/opencode
进程树的效果、两个 CLI 真实 `--json` 字段名与解析器字段表的
锁定、多源库上的 data-source 报错形态、`.bat` 在真实 cmd.exe
下的行为、长 prompt 经 stdin 的 Windows 端到端闭环、断电后
陈旧锁自愈。

## 已推送

本次落地已于 2026-10-26 推送到同一仓库
（mayberonger430059-art/ai-bridge，main），更新 commit
06fa1ceef23d50f4debb2118b6795b869f898cd3，不混进 v0.1 基线
commit 246a9fef。推送前已核对：分支头仍为基线 SHA、无其他
写入者分歧、新路径在远端不存在、全部文件 UTF-8 且无符号链接；
推送后已回读主分支头与 `src/safepath.js`、`docs/claude-review-landing.md`
与本地一致。
