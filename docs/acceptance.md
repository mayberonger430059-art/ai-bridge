# AI Bridge — 验收清单（2026-10-25，诚实版）

## 已完成

- [x] 三候选 GitHub 项目实查：coding-agent-runner / cezar / Agent_MCP-Bridge
      （结论见 RESEARCH.md；第一候选只做 Phase 2 执行适配器）
- [x] 助手侧连接核对：Notion connected、GitHub connected（2026-10-25 实测输出）
- [x] v1 完整源码：零 npm 依赖，Node >= 20 即可跑
      （bridge / notion / executors / config / ledger / doctor）
- [x] Windows 一键脚本：doctor.bat / test-dryrun.bat / run-once.bat / poll.bat
- [x] Notion 数据库配置方法：notion/schema.md（属性名、状态机、发任务写法）
- [x] 单元测试：白名单、token 解析、密钥掩码、ledger 持久化（node --test）
- [x] Linux 侧 dry-run 验证：见下方“已验证的执行记录”
- [x] 不碰现有系统：代码里写死了 protectedPaths 挡板，且测试目录独立；
      本次工作未修改任何足球分析文件、已有 Agent 配置

## 未完成（必须在本机做，云主机上无法冒充）

- [ ] Windows 上 `.\scripts\doctor.bat` 全绿（含 codex / opencode 版本行）
- [ ] Windows 上 `.\scripts\test-dryrun.bat` 通过
- [ ] 真实闭环 1：Notion → OpenCode → Notion（hello-from-opencode.txt + Notion Done 行）
- [ ] 真实闭环 2：Notion → Codex → Notion（hello-from-codex.txt + Notion Done 行）
- [ ] Muse 网页版验证：它自己确认 Notion/GitHub 连接后，在 Notion 发一个任务并读到结果
- [ ] ChatGPT 验证：它通过已连的 Notion 发一个任务并读到结果
- [ ] 失败/取消/超时/重启恢复四项中至少各做一次真实演练并留记录
- [ ] GitHub 独立仓库创建与推送（见 docs/local-handoff-codex.md 第 5 步；
      本机助手侧 GitHub 连接已通，但建仓、选公开/私有、推代码需要用户在本机或
      在助手侧确认仓库名与可见性后才能做，不擅自建仓）

## 已验证的执行记录（Linux 侧，dry-run，非真实模型调用）

- 单元测试：`node --test test/*.test.mjs` —— **4 pass / 0 fail**
  （白名单、token 解析、密钥掩码、ledger 持久化各 1 项）。
- Dry-run：`BRIDGE_ALLOW_DRYRUN=1 node src/bridge.js --once --local-task /tmp/ai-bridge-local-task.json`
  —— **exit=0，outcome=done**，`/tmp/ai-bridge-test-workdir/AI_BRIDGE_DRYRUN_OK.txt`
  已生成，`data/runs/2026-10-25_BR-DRYRUN-001/result.json` 的 status=Done、
  tokens=null（dry-run 本来就没有模型调用，tokens 记 null 是如实的）。
  Linux 侧 workdir 换成了 /tmp 临时目录（Windows 版是 D:\AI-Bridge\test-workdir，
  属预期差异，不是 bug）。
- CLI 形态核验（本机云主机，不含模型调用）：
  - `codex --version` = codex-cli 0.164.0-alpha.9；`codex exec --help` 确认有
    `--json`、`--sandbox read-only|workspace-write|danger-full-access`、
    `--skip-git-repo-check`、`-C/--cd`，与 executors.js 的调用形态一致；
    但 `codex login status` = Not logged in，所以本机**没有**冒充跑真实 Codex 任务。
  - `opencode --version` = 1.19.4（在 `~/workspace/.npm-global/bin`，需进 PATH）；
    `opencode run --help` 确认 `run [message..] --format json --dir <dir>` 形态，
    与 executors.js 的 `run` 档一致。Windows 上的 OpenCode 版本可能不同，
    仍需本机以 `opencode run --help` 为准再确认一次。

## 已知风险

1. **Codex Windows 原生尚属 Experimental**：第三方资料标注 WSL 更稳。
   缓解：先在用户本机跑 `codex exec` 单条测试；若原生不稳，改走 WSL 路径
   （workdir 改成 WSL 路径、桥接服务仍在 Windows 上调 `wsl codex exec ...`，
   此分支 v1 代码未写，需实测后补一个 executor 分支）。
2. **OpenCode 版本形态多**：`run --format json` / `--standalone` / `-p -f json`
   三种形态随版本而变。缓解：opencodeMode 可配置；报错不自动换档重试。
3. **Token 解析不保证**：Codex/OpenCode 各版本 JSON 字段名可能变化。
   缓解：解析不到写 unknown，绝不估算；实测后按真实输出字段补解析规则。
4. **Notion API 版本**：v1 默认 2022-06-28；若用户 Notion 工作区已全面切到
   data-source 模型（2025-09-03），query 可能需要改走 data source。
   缓解：doctor --check-notion 会先暴露这个问题；届时按 Notion 返回的错误信息改。
5. **单实例假设**：v1 防重跑依赖单实例 + 本地 ledger；双实例同跑一个库会破坏假设。
   缓解：文档已明令禁止；将来如需多实例，要加分布式锁（不在 v1 范围）。
6. **Muse 网页版连接未验证**：助手侧 Notion/GitHub 通 ≠ Muse 网页版侧通。
   缓解：第五步必须由 Muse 网页版自己先确认连接，再发任务。
7. **审批是“人治” gate**：Approval 由人在 Notion 里改，桥接服务只认字段值，
   不验证改字段的人是谁。缓解：Notion 库只分享给可信成员；这是 v1 可接受的范围，
   更严的审批（如双人确认）不在本轮目标内。
