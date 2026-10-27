# AI Bridge 第 2、3 项交付与验证记录

日期：2026-10-26（Asia/Shanghai）。结论：**常驻方案、完整 RUNBOOK、3 个真实业务候选及 ChatGPT/Muse 闭环试点计划已写入正式本地仓库；未部署、未执行真实业务。**

## 1. 范围、来源与代码基线

- 仓库：`mayberonger430059-art/ai-bridge`，正式本地 checkout：`D:\AI-Bridge`。
- 本地 HEAD：`96b959ae64d8c54a58c7f18b48ebf2705e00b398`，main，开始时工作区干净。
- 本轮通过 GitHub 连接器核实的远端 main：`ad74fd2e18ea74b5576423b41b813e06c5f2c2a8`。本地比远端多一条原有 RUNBOOK 提交，未重置、未推送。
- 从原会话“等待N2评审材料”（`6adf2930-3fa4-83e8-95e0-ae3099071760`）恢复第 2、3 项完整要求：只写方案/文档，3 个排序候选，两平台分别发起闭环，零容忍上线门。用户后续允许 2、3 先做；第 1 项仍等 N2 diff，第 4 项不启动。
- 本轮没有给 N2 做正式评审/签发 PASS；读取当前状态机是写出准确运维手册的必要核查，不替代指定 diff/base 的独立评审。

## 2. 实际文件改动

| 文件 | 改动 |
|---|---|
| `docs/SERVICE-PLAN.md` | 新增任务计划/Windows 服务决策表、选型、身份与单实例、断网/重启恢复边界、健康检查/通知目标、日志保留与放行步骤 |
| `docs/RUNBOOK.md` | 在保留原 CLI 版本/拓扑证据的基础上补全安装检查、队列语义、启停、状态、审批、pending、取消、监控、备份、恢复、升级、回退与归档 |
| `docs/PILOT-PLAN.md` | 新增 3 个候选、公开固定 commit 的首个发版证据任务、两平台独立闭环矩阵、验收答案、停止/回滚及上线门 |
| `README.md` | 增加上述文档与本记录的导航入口 |
| `docs/VERIFICATION-2026-10-26.md` | 本记录 |

最终改动只涉及以上文档；`src/`、`test/`、`scripts/`、package.json 和配置模板无 diff。没有新增常驻代码、调度任务、插件、服务或 coding-agent-runner 接线；正式 config/.env/data 没有作为编辑目标。没有 Git 提交、推送、Notion 新建/写回或足球生产修改。

## 3. 实际核对的源码与关键事实

以下为本地源码的 1 基行号，源码本轮未改，因此可以对照该 HEAD 复查。

| 文件及位置 | 实际读到的事实 |
|---|---|
| `src/config.js:22`、`:38`、`:48` | 环境优先，BRIDGE_CONFIG 只切 JSON；相对 dataDir 按 cwd 解析；凭证不得写入文档 |
| `src/config.js:49`、`:56`、`:58` | maxConcurrent 固定 1，默认轮询间隔 30000、任务 timeout 1800000 |
| `src/bridge.js:67`、`:72`、`:103` | 同日 TaskID 复用 run 目录；重启恢复检查 running PID；门禁先于 executor |
| `src/bridge.js:312`、`:346`、`:359`、`:420` | dataDir 单实例锁；启动恢复；整轮查询并顺序处理；整轮后 sleep。`--once` 不限制只执行一个任务 |
| `src/bridge.js:130` 附近、`:176` 附近 | running 写本地 ledger，取消 watcher 每 15000ms 读页；没有正常 Status=Running 的 Notion 更新 |
| `src/tasksync.js:70`、`:172`、`:191`、`:223` | pending 不执行模型；终态先存本地；属性失败待补写；正文失败仍 synced，不自动保证补报告 |
| `src/notion.js:79`、`:97`、`:123`、`:155` | fetch 无显式 deadline；队列分页；首个 divider 截断 prompt；报告使用 run marker 检测 |
| `src/executors.js:23`、`:56`、`:163` 附近、`:199` | 直接 spawn、CLI 原始输出直接 pipe；Codex sandbox；OpenCode 无 read-only 参数；ChangedFiles 是执行后 git status |
| `src/ledger.js:12`、`:27`；`src/lock.js:26` | ledger 解析失败回空记录，保存用临时文件/rename；锁只检测本机 PID |
| `src/killtree.js`、`src/attempts.js`、`src/gate.js` | Windows 进程树终止、真实调用计数硬上限 3、write 必须 Approved |
| `src/doctor.js`、`src/executor-identity.js`、`src/safepath.js` | 版本身份检查与真实路径白名单；doctor 的 Notion 分支只查询/读取 |

同时读过 package.json、README、现有 RUNBOOK、config.example.json、notion/schema.md、现有 bat 入口和相关测试。OpenCode 默认连接桌面 service、取消后后台可能继续的证据来自原 RUNBOOK 第 5 节，明确保留为历史现场记录；本轮未重做模型取消演练。

## 4. 实际执行证据

| 检查 | 环境/命令 | 实际结果 | 能证明的范围 |
|---|---|---|---|
| 原有全部测试 | Windows，Node v24.14.0；`node --test test/*.test.mjs`（执行时枚举 9 个文件传参） | exit=0；tests=63、pass=63、fail=0、skipped=0 | 现有离线回归，包括临时子进程/CLI --version，不是业务或 N2 全矩阵证明 |
| 本地 doctor | D:\AI-Bridge，`node src/doctor.js` | exit=0，9/9 PASS | Node/config/CLI 身份及路径/凭证存在性 |
| Notion 只读 doctor | 同目录，`node src/doctor.js --check-notion` | exit=0，11/11 PASS；0 Queued；单数据源，API 版本 2022-06-28 | 本机 REST integration 可读；没有认领/回写，不证明 ChatGPT/Muse 权限 |
| 隔离 dry-run | 本会话 work/offline-dryrun，复制 src/package，仅本地 config + task，`BRIDGE_ALLOW_DRYRUN=1 ... --once --local-task ...` | exit=0，outcome=done；marker 存在；result.json.status=Done、tokens=null；退出后无 bridge.lock | 无模型、无网络的 plumbing；未创建 Notion ledger，不能证明恢复/防重跑/Notion 写回 |
| JS 语法 | bridge/config/executors/notion/tasksync，`node --check` | 5/5 exit=0 | 主要源码语法，非运行业务 |
| 源码未改 | `git diff HEAD -- src test scripts package.json config.example.json .env.example .gitignore` | 空 diff；记录 33 个核心/测试/脚本文件的 SHA-256 | 本轮没有修改运行代码、测试或模板 |
| 文档差异 | `git diff --check` | exit=0 | 无 diff 空白错误 |

原始证据随交付目录的 `evidence/` 提供：`unit-tests.log`、`doctor-local.log`、`doctor-notion-readonly.log`、`offline-dryrun.log`、`offline-dryrun.json`、`syntax-checks.json`、`source-integrity.json`，以及最终文档链接/差异/交付哈希检查。日志不包含 `.env` 或 config.json 全文。

测试主日志发生在 UTC 13:10（北京时间 21:10）左右；隔离 dry-run 为 UTC 13:23（北京时间 21:23）左右。现有 CLI 版本本轮 doctor 重查为 Codex `0.164.0-alpha.11.1`、OpenCode `2.1.4`，git `2.53.0.windows.2`。

## 5. 未解决问题与明确未验证项

1. 第 1 项 N2 diff 独立评审未完成。当前代码已有相关提交，不能据此把等待项改成完成。
2. 常驻任务未注册、未启动；登录触发、Windows 更新后重启、有界重启、断网恢复、长期运行和通知均未现场验收。选择的是用户登录级常驻，不能保证无人登录时运行。
3. 现有 fetch 无 deadline；正常运行没有 Notion Running 投影；原始 CLI 日志及部分错误未完全脱敏；坏 ledger 可能静默回空；同日重复 TaskID 的运行目录会覆盖。已在手册给操作边界，未改源代码。
4. OpenCode 共享 service 的取消保证不足；standalone 尚未真实验收，不能仅换参数宣称修好。
5. 第 3 项是可执行的真实业务计划，尚未准备两端输入副本/独立参考、发单权限验证、模型执行、读回、负向现场演练和业务签收。当前无两端业务成功率、Token 成本或效率改善结论。
6. API 查询通过不证明写属性/追加正文权限，也不证明 ChatGPT/Muse 各自账号具有相同访问权。
7. 第 4 项 runner 比较未启动。没有修改足球生产系统，没有部署公网接口或公开仓库 self-hosted runner。

## 6. 交付与后续入口

权威文档在 D:\AI-Bridge\docs，README 可发现。本会话 outputs 保存同字节交付副本、基于本地 HEAD 的补丁和证据/哈希清单。补丁对应 96b959a；远端 ad74fd2 尚无原有 RUNBOOK 提交，不应把本地 patch 不加核对地当作远端补丁直接应用。

下一步只需按本计划审阅文档，继续等待 N2 diff；得到后续真实试点/部署授权后再执行。当前不继续扩大审计或提前做第 4 项。
