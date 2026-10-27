# AI Bridge 常驻运行方案（第 2 项）

状态：方案及操作文档已准备；**未注册任务、未启动轮询、未部署 Windows 服务**。日期：2026-10-26（北京时间）。本轮按原会话要求只交付方案和文档，不新增运行代码。

## 1. 决定与适用范围

| 选项 | 代价 | 风险/局限 | 决定 |
|---|---|---|---|
| 同用户任务计划程序，登录触发 | 使用系统组件，无新增 npm 依赖；需维护日志与值守检查 | 用户注销/未登录不运行；只检测退出，不能发现活进程卡住 | 选择，先值守试点 |
| SCM Windows 服务（含 NSSM/WinSW 包装） | 新服务账户/配置、安装和卸载流程、CLI 登录态重新验收 | Session 0 与 OpenCode 用户 service 的交互未证实；扩大运维范围 | 当前不采用 |

采用 Windows 任务计划程序，在当前已登录用户的会话中运行现有 `node src/bridge.js --poll`。用同一用户已有的 Codex/OpenCode 登录态，固定 Node 和 CLI 的绝对路径。先在有人值守的试点窗口使用，后续再验收登录触发、异常恢复和长期稳定性。

这里的“常驻”是用户会话级轮询，不承诺注销后、未登录时或休眠中继续服务。当前代码及 CLI 登录链没有证明适合 LocalSystem / Session 0，因此本轮不选择 SCM Windows Service、NSSM、WinSW，也不新增第三方守护程序。没有入站端口、隧道或公网 API。

不改变 `src/`、正式配置、Notion 数据或足球生产系统。第 1 项仍等 N2 diff 的独立评审；代码里已存在相关提交不等于该项验收完成。第 4 项不启动。

## 2. 已核实的实现约束

| 代码位置 | 实际行为 | 对常驻的影响 |
|---|---|---|
| `src/config.js:loadConfig` | `.env` 从 cwd 读，已有进程环境优先；`BRIDGE_CONFIG` 只切 JSON；`dataDir` 相对 root 解析 | WorkingDirectory 必须是仓库根；任务使用明确配置，不依赖交互终端的临时 PATH |
| `src/bridge.js:main` | 单进程顺序执行；处理整轮查询结果，再 sleep | `--once` 不是只执行一个任务；30 秒不是开始执行的时限 |
| `src/lock.js` | 锁在 `dataDir/bridge.lock`，以 PID 检测存活 | 只防同一 dataDir 的本地重复实例，不能防另一机器/另一 dataDir 消费同一库 |
| `src/tasksync.js` | 终态先存 ledger，再投影 Notion；pending 只补写 | 启动会恢复/补写，然后消费队列；没有只补写、不消费队列的 CLI 开关 |
| `src/bridge.js:recoverRunning` | PID 已死的 running 记 unknown；PID 仍活则留置 | 崩溃重启不等于旧工作已停止；不能通过删锁、删 ledger 处理 |
| `src/notion.js:request` | fetch 没有显式 deadline | Notion 请求卡住时进程仍可存活；任务计划程序不会因为没有 poll 日志而自动重启 |
| `src/executors.js` | OpenCode run 可连接用户已有 service；Codex 用 sandbox | OpenCode 工作目录与 read-only 字段本身不构成系统级文件隔离；默认只让 Codex 承担首个试点 |
| `src/lock.js:registerCleanup` | 退出时释放锁，没有等待当前任务完成的 drain 机制 | 正常停机先等任务和补写完成；不能把停止包装器当作完成任务取消 |

## 3. 实际交付的文档

- `docs/RUNBOOK.md`：安装前检查、启停、监控、故障处理、恢复、备份、升级和回退。
- `docs/PILOT-PLAN.md`：真实业务场景、输入合同、Notion 发单正文、人工验收和停止条件。
- `docs/VERIFICATION-2026-10-26.md`：代码基线、实际测试/只读探测、未验证范围和问题。

现有入口不提供分布式锁、任务队列暂停、独立健康端点、优雅 drain 或 OpenCode service 取消协议。本轮不实现新的包装器、watchdog 或调度代码。

## 4. 未来部署参数（本轮不应用）

| 项目 | 方案值 |
|---|---|
| 任务名 | `AI-Bridge-Poll`，专用单任务；不得同时手工开 poll.bat |
| 触发 | 指定用户登录时；不选“无论用户是否登录都运行” |
| 身份 | 当前 CLI 已完成登录的用户；InteractiveToken / LeastPrivilege |
| 工作目录 | `D:\AI-Bridge` |
| 程序 | 现有 Node 入口，固定绝对路径；需要日志重定向时通过 cmd 调用，参数见 RUNBOOK |
| 多实例 | `IgnoreNew`；同时保留桥自身同 dataDir PID 锁 |
| 异常退出 | 1 分钟后重启，最多 3 次；配置错误也会退出，不能无限重启掩盖问题 |
| 执行时限 | 无固定任务总时限；桥内 timeoutMs 管单次 executor；网络请求仍可能卡住 |
| 电源 | 不因切电池停任务；不主动唤醒计算机；休眠期间不工作 |
| 日志 | 未来在 `<dataDir>\resident\bridge-current.log` 合并捕获桥 stdout/stderr；轮转前停机，归档名写 UTC 日期及序号 |
| 应用数据 | 保持原有 dataDir；已有 ledger 不丢弃、不重置 |
| 初始运行 | 先专用试点库、空队列、同用户值守；通过后才考虑登录自动触发 |

试点独立配置建议 `maxRetries=0`，`allowedExecutors=["codex"]`、`timeoutMs=1800000`、`pollIntervalMs=30000`、`maxConcurrent=1`。这是建议值，当前 `config.json` 未修改。试点独立 dataDir 必须搭配独立 Notion 数据库，不能与现有 poller 指向同一库。

## 5. 未来落地顺序与验收

1. 对照 `VERIFICATION-2026-10-26.md` 固定源码基线，等用户另行授权部署。核实第 1 项的 N2 diff，不由本文替它签字。
2. 按 RUNBOOK 在停机、无存活 executor 的状态备份；准备同用户、独立业务副本、专用 Notion 试点库及最小配置。
3. doctor/离线测试通过后，先手工短窗口运行一次真实试点；退出并检查产物及 ledger。
4. 按 RUNBOOK 在任务计划程序创建禁用任务。审查 action、cwd、用户、权限及重启设置，再另行启用并启动。
5. 验证任务计划状态、桥 PID、轮询日志、队列到终态的实际业务文件、Notion 属性及正文。Task Scheduler 显示 Running 不是业务通过。
6. 空队列时做登录触发、断网恢复、旧 PID 存活及死 PID 恢复演练；记录执行次数，证明没有重复调用模型。注销后的行为单列，不宣称支持无人登录。
7. 有人值守累计运行 2 小时且业务验收通过后，另约 1 个工作日观察；未通过保持手工模式，不扩大到生产目录。

## 6. 监控、维护和回退约定

- 目标健康检查每 60 秒一次，检查进程身份、空闲 poll 日志、running 时长、pending 时长及磁盘容量。空闲期连续 3 个轮询间隔无 poll 日志要检查网络；执行任务时不能套用空闲阈值。当前没有独立 watchdog，本轮不新建自动化；试点期间由当前用户按此节奏值守。
- 通知接收人是当前用户/业务运行负责人：连续 2 次健康检查失败、pending 超过 5 分钟、进程退出重启耗尽或需要人工处理时提醒一次；恢复时提醒一次；正常空轮询只留日志，不周期性打扰。通知渠道待部署阶段确定，当前只记本地日志，不能声称已具备自动提醒。
- `writeback_pending` 连续 5 分钟列为人工检查项，只处理同步，不改任务为 Queued。报告追加失败可能已 `synced`，需看日志，不能通过重跑 executor 补报告。
- 目标日志策略为每日换档，或单文件 50 MiB 提前换档；run 目录验收后保留 30 天，未结问题及 unknown/pending 永不按天清理；1 GiB 总量提醒人工。当前实现没有自动轮转/保留任务，值守阶段在空闲停机窗口人工归档，不能在线重命名打开的日志当作轮转。ledger 不纳入清理。
- 计划停机：停止新发单，暂停登录触发和失败重启，确认无 running/活子进程并已完成同步，才结束本桥。结束调度任务后需独立核实 node 与 executor 状态。
- 紧急停机：禁用调度后按 RUNBOOK 精确核对 PID 和创建时间，终止本桥拥有的树；OpenCode 共享 service 用其自身取消入口处理，不能杀全部同名进程。
- 回退先停调度并备份，再把任务计划设置和代码恢复至已记录版本；保留与终态相符的 ledger。代码回退不能自动回退任务执行造成的文件修改；业务文件从试点快照恢复，人工决定是否发新任务。

## 7. 发布前仍需解决的问题

未实测任务注册、登录触发、调度重启、长时间运行和真实业务输入；本轮只做离线及只读验证。运行态缺少 Notion Running 写入、API deadline、完整日志脱敏及 OpenCode 后台取消保证。详见 RUNBOOK 风险表和验证报告；这些问题已记录，未改动核心代码。不使用公开仓库绑定 self-hosted runner。
