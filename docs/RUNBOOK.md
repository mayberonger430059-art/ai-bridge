# RUNBOOK · AI Bridge Windows 运行、恢复与交付

本文件是现有入口的完整操作手册。第 1–5 节保留此前 CLI 版本及运行拓扑证据；第 6 节起为 2026-10-26 核对当前代码后补全的操作规程。

本轮只交付方案和文档，不新增运行代码，没有部署服务或执行真实业务任务。第 1 项等 N2 diff，第 4 项暂不启动。当前核对基线为本地 `96b959a`（代码未变），远端 `main=8fc959b`；远端两项运行手册修正（4a/4b 拆分、git 版本命令）已并入本文件。当前复测证据见 `VERIFICATION-2026-10-26.md`。

常驻方案见 [SERVICE-PLAN.md](SERVICE-PLAN.md)，真实业务试点计划见 [PILOT-PLAN.md](PILOT-PLAN.md)。历史 `acceptance.md` 及交接单是当时记录，不能替代本次验证证据。

> 公开文档中的安装路径均为占位符。实际路径和完整运行日志保存在本机私有配置与证据中，不提交到公共仓库。本手册不是发布批准记录；发布 PR 应附独立复审与验证证据。

## 1. 实测基线（2026-10-26，Windows 本机）

| 组件 | 实测版本 | 路径 | 怎么测的 |
|---|---|---|---|
| opencode | `opencode v2.1.4` | `<OpenCode 安装目录>\resources\opencode-cli.exe` | `opencode-cli.exe --version` |
| codex | `codex-cli 0.164.0-alpha.11.1` | `<Codex 安装目录>\codex.exe` | `codex.exe --version` |
| node | `v24.14.0` | `<Node.js 安装目录>\node.exe` | `node --version` |
| git | `2.53.0.windows.2` | `<Git 安装目录>\cmd\git.exe` | `& '<Git 安装目录>\cmd\git.exe' --version` |

`node src/doctor.js` 会把上面两行原样打印出来，并在方括号里带上**实际探测的二进制路径**
（例如 `[<安装目录>\opencode-cli.exe]`）：PATH 与 `executorPaths` 可能指向不同安装，
不打印路径就说不清 doctor 到底测的是哪一个。

### doctor 的身份校验（2026-10-26 起）

`opencode CLI available` / `codex CLI available` 的 PASS 条件不再是「命令能跑」，
而是版本输出**同时**满足：

1. 含执行器特征名（`opencode` / `codex`，大小写不敏感，按词边界）；
2. 含版本号（`2.1.4`、`v1.19.4`、`0.164.0-alpha.11.1` 都算）。

反例（实测）：把 `executorPaths.opencode` 指向 `C:\Windows\System32\cmd.exe`，
旧 doctor 报 `PASS  opencode CLI available — Microsoft Windows [版本 10.0.19045.6456]`；
现在报
`FAIL  opencode CLI available — Microsoft Windows [...] [C:\Windows\System32\cmd.exe] -- rejected: version output does not name opencode; fix executorPaths.opencode`。
这条反向对照已固化成单测 `test/doctor-identity.test.mjs`（正向用例读本机真实 opencode，缺失时 skip）。

## 2. opencode 参数现状（v2.1.4）

`opencode run --help` 实测存在的 flag：

```
--standalone  --server  --continue/-c  --session/-s  --fork
--model/-m  --agent  --format <default|json>  --file/-f  --title  --thinking  --auto
```

已确认**不存在**的（历史坑，别照着旧文档写）：

- `--dir`：2.x 删除。工作目录只通过 spawn 的 `cwd` 传递，桥接 `runProcess` 已如此。
- `-p` / `-q`：2.x 没有。`-f` 在 2.x 是 `--file`（附加文件），不是 `--format`。
  所以 `opencodeMode=print` 只适用于 1.x，v2 用 `run`（默认）或 `standalone`。

## 3. 升级流程（缺一步都别接真实任务）

1. **记下旧版本**：`opencode --version`，连同 `config.json` 里 `executorPaths.opencode` 的路径一起记进本文件第 1 节。
2. **换二进制**，然后重开终端（PATH 改动不会进已开的进程）。
3. **跑 doctor**：`node src/doctor.js`。要求 `opencode CLI available` 为 PASS 且版本号是新的。
   FAIL 时不要往下走：先看 detail 里是「找不到」还是「不是 opencode」。
4. **升级验收（两项，分开判定，不能互相替代）**

   **4a. OpenCode 功能烟测**（一次真实调用）：在 `<隔离测试目录>` 下跑一个 opencode 任务，
   确认桥接调用能正常执行、`outcome=done`；Tokens 按 CLI 上报解析，无 usage 则如实记 `unknown`，不估算。
   **本步只证明「能跑通、输出能解析」，不验证只读安全**：当前 OpenCode 执行器没有强制只读沙箱，
   `WriteMode=read-only` 不能保证禁止写入（依据见第 2 节：opencode v2.1.4 的 `run` 没有只读/沙箱类参数）。

   **4b. Codex 只读安全测试**（负向，一次真实调用）：用 Codex 的 `--sandbox read-only`，在隔离测试目录
   跑一个**明确要求创建文件**的提示词。
   - 通过条件：文件**确实没有生成**，并有证据表明写入被阻止。
   - 文件一旦生成即 **FAIL**，不要接真实业务任务。
   - **不以 `outcome=done` 作为通过条件**：正确阻止写入也可能让任务以失败结束；
     判定看的是「文件未生成 + 写入被阻止的证据」，不是 CLI 退出码。

5. **两项都通过才接真实业务任务**：4a 通过只说明该执行器能跑通，4b 通过只说明 Codex 的只读边界有效；
   两者验证的执行器不同，不能互相替代。没通过就回退到第 1 节记录的旧路径，把新版本号与报错写进本文件再讨论。

**不要**升级完直接跑真实任务，也**不要**在报错后自动换 `opencodeMode` 重试——会重复扣费，
而且第二次失败的原因会被第一次的噪音盖住。改配置后用新页面和新 TaskID 提交新任务；已执行旧单回写失败时只补同步，不通过改回 `Queued` 重跑。

## 4. 回退

`opencodeMode` 有 `run|standalone|print` 三档，换档属于配置改动，不属升级：
先跑 doctor，再按第 3 节第 4a 步验证 OpenCode 功能；若同时变更 Codex 版本或沙箱配置，
还须独立执行第 4b 步的 Codex 只读安全测试。两者不能互相替代。
v2 上 `print` 已知不可用，不要拿它当回退档。

如果新版本连 `run --format json` 都不认，结论是**不要接这个版本**，
把 `executorPaths.opencode` 指回旧安装并记录，而不是改代码去猜新 flag。

## 5. 运行拓扑（影响取消与排障，升级时别忽略）

本机实测：`opencode run` 默认**不自己起服务**，而是连桌面版已经拉起的后台 service
（`%USERPROFILE%\.local\state\opencode\service.json`，实测 `http://127.0.0.1:28894`，
进程为 `opencode-cli.exe serve --service`，父进程是 `OpenCode.exe`）。
所以一次 opencode 任务里有两条进程链：

```
桥 → node src/bridge.js → 子进程 opencode-cli.exe run ...     ← 桥拥有这个 pid
                                    │ HTTP
                                    └→ 桌面版 service（桥不拥有，先于任务存在）
                                          └→ 模型调用 / 工具执行（写文件落在这里）
```

由此产生两条必须知道的事实：

1. **取消只能杀桥拥有的那条链。** 实测取消后 CLI 客户端与其子进程全死，
   桌面版 service 仍在（它是用户 UI 的服务，杀了会连桌面版一起挂）。
   **但被杀不等于任务停止**：本轮演练里客户端死后再过 80 秒，service 仍然
   spawn 了一次 PowerShell 去写 `cancel-probe-06.txt`（最后停在 06/20）。
   也就是说 opencode 的"取消"只保证桥侧进程树死，不保证工作立刻停；
   长任务接真实业务前必须考虑这一点（要么用 `--standalone` 让服务成为桥的子进程并实测，
   要么不要在 opencode 上跑"取消后不能继续动手"的任务）。
2. **排障要看 service 自己的日志**：`%USERPROFILE%\.local\share\opencode\log\opencode.log`。
   桥的 `stderr.log` 可能是空的 —— 例如上游返回 503 时，opencode 只在这里写
   `Failed to drain Session: AI.Error: Upstream request failed`，而 CLI 退出码是 1、
   stderr 为空，桥只能回写 `executor exited with code 1`。
   另外同名任务当天复用同一个 run 目录，重试会覆盖上一次的 `stdout.log`，
   失败那次的原始输出要靠这份 service 日志才找得回来。

以上 OpenCode service 的取消延迟是此前手册记载的现场演练，本轮没有重做真实模型或取消测试。`standalone` 是待验候选，不能仅凭参数名宣称取消问题已解决。

## 6. 入口、权限和目录合同

所有命令除另有说明外，在 `D:\AI-Bridge` 的普通用户终端执行。命令中的 `rtk proxy` 是本机命令约定；桥内部仍直接调用配置的 CLI。无需 npm install。

| 入口 | 会做什么 | 使用条件 |
|---|---|---|
| `node src/doctor.js` | 读配置、测 CLI --version、测 git，不调用模型 | 可随时诊断；凭证“set”不等于有效 |
| `node src/doctor.js --check-notion` | 额外查询队列及数据库结构，不认领、不回写 | 只读联网检查；仍需正确 Notion 授权 |
| `node --test test/*.test.mjs` | 离线测试，部分临时子进程及 --version 探测 | 不调用模型，不部署服务 |
| `node src/bridge.js --once` | 恢复 ledger、补写、处理本轮查询到的**全部** Queued 行，然后退出 | 不是“只拿一条”；发单前隔离队列 |
| `node src/bridge.js --poll` | 同上，循环执行，整轮结束后 sleep | 必须避免另一消费者指向同一数据库 |
| `--once --local-task <json>` | 本地任务入口，不读 Notion、不写 Notion ledger | 能测 plumbing/CLI，不能证明 Notion、恢复或防重跑闭环 |

配置及状态位置：

- `.env`：`NOTION_API_KEY`、`NOTION_DATABASE_ID`、可选 `NOTION_VERSION`；当前代码默认 `2022-06-28`。不要把 key 放在 Notion 指令或命令参数里。
- `config.json`：白名单、保护路径、CLI 绝对路径、dataDir、超时与重试；已在 gitignore 中。
- `.env` 按 cwd 读取，已有进程环境中的同名键优先，即使环境值为空也不会从文件覆盖。文件值没有引号剥离功能；写 `KEY=value`，不要写 `KEY="value"`。
- `BRIDGE_CONFIG` 可指定另一份 JSON，**不会**切换 `.env`；相对 dataDir 仍基于工作目录。切试点库时要隔离进程环境与 ledger，不能只换 dataDir 继续消费同一库。
- `data/ledger.json`：执行事实、次数、PID、runId、终态及同步状态；临时落盘用 ledger.json.tmp 后 rename。
- `data/bridge.lock`：桥自身 PID 锁；仅同 dataDir 有效。
- `data/runs/<UTC日期>_<清洗后的TaskID>/stdout.log`、`stderr.log`：executor 原始输出。同日相同 TaskID 或重试可覆盖；因此每个业务任务使用新 TaskID，并及时归档。
- 本地成功任务才会写 run 目录的 `result.json`。Notion 任务终态以 ledger 和页面为准，不要求一个代码并未生成的 result.json。

`protectedPaths`/allowedWorkdirs 是入口路径检查，不是通用 OS 文件沙箱。尤其 OpenCode 没有因 WriteMode=read-only 自动加只读 CLI 参数。首个试点用 Codex 的 `--sandbox read-only`，只挂独立副本目录，不把原始业务目录和足球目录放进白名单。

## 7. 首次准备与开机前检查

本节为未来操作规程，本轮未创建库、未改运行配置、未启用调度。

1. 确认普通登录用户与已有 CLI 账号一致。不要改用 SYSTEM，也不要把凭证复制到服务账户。
2. 记录 `rtk git status --short --branch`、`rtk git rev-parse HEAD` 和真实 CLI 版本。已有修改先保存差异，不覆盖 config/.env/data。
3. 用模板新建配置时只在文件不存在的情况下复制；现有安装不要再次 copy 覆盖。allowedWorkdirs 仅包括明确的隔离工作区；protectedPaths 必须与其无双向重叠。
4. Notion 库属性按 [schema.md](../notion/schema.md) 核对。Status/Executor/WriteMode/Approval 是 Select，Title 是 Title，Attempts 是 Number，其他结果字段为 Rich text。不能用同名 Status 类型替代 Select。
5. API token 只授权专用任务库，在本机填写 `.env`，确认集成可读库、读正文、写属性、追加正文。查询通过只证明读取；写权限需后续真实闭环证明。
6. 确认同一数据库只有一个消费者；检查桥 PID、任务计划和手工终端。不同 dataDir 的锁互相看不见。
7. 看完 ledger：有 unknown 或活 PID 的 running 先人工处理，不删账本强行启动。
8. 执行下面的只读检查。若本机策略阻断已确认的工具，交由管理员按既有政策处理；不自动改全局执行策略。

```powershell
Set-Location -LiteralPath 'D:\AI-Bridge'
rtk proxy node src/doctor.js
rtk proxy node --test test/*.test.mjs
rtk proxy node src/doctor.js --check-notion
```

通过标准：doctor 无 FAIL、版本身份正确、路径是预期 CLI；测试零失败；Notion 查询/结构通过。这些都不是部署或业务完成的证据。

## 8. 正常启动、停机与重启

本轮**没有执行**本节启动命令。未来首次启动先确认试点数据库除本次任务外无 Queued 行、无 pending 补写、无活旧 executor。

```powershell
# 前台一次性处理整轮队列；执行真实任务，需另外授权后才使用。
rtk proxy node src/bridge.js --once

# 前台常驻；默认 pollIntervalMs=30000。
rtk proxy node src/bridge.js --poll
```

未来任务计划程序配置步骤（本轮未操作）：

1. 打开任务计划程序 → 创建任务，名为 AI-Bridge-Poll；选当前 CLI 已登录用户，“只在用户登录时运行”，不勾最高权限。
2. 触发器设“此用户登录时”，初始禁用；多实例规则为“不启动新实例”。不要同时运行手工 poll。
3. 操作选 cmd.exe，起始于 D:\AI-Bridge；不要直接调带 pause 的 poll.bat。先在空闲准备 data\resident 目录，再用下列 action 捕获桥日志。示例对应默认 dataDir；独立试点须同步换日志目录和配置/凭证上下文。
4. 条件不因切电池停止，不唤醒计算机；设置不设总运行时限，失败后 1 分钟重启、最多 3 次。保持任务禁用，导出 XML 留档。
5. 人工复核路径、用户、队列与账本，再另行授权启用和启动。Windows 更新后重启必须用户登录才会触发；不能保证无人登录时自恢复。

action 的程序：`C:\Windows\System32\cmd.exe`；参数（单行）：

```text
/d /s /c ""D:\Program Files\nodejs\node.exe" "D:\AI-Bridge\src\bridge.js" --poll >> "D:\AI-Bridge\data\resident\bridge-current.log" 2>&1"
```

这是待部署的设置草案，未用实际任务计划执行验证。固定 Node 路径后仍要 doctor 核对 executorPaths。任务计划 IgnoreNew 加同 dataDir bridge.lock 防误双开，不支持多主机消费同库。断网时桥捕获 API 错误、循环时继续重试查询/补写；fetch 长挂起则不会自行恢复，需要值守人工处理。

正常停机：

1. 停止发新任务，禁用该任务的登录触发及失败重启。队列没有“全局暂停”开关，切勿用重建 ledger 代替暂停。
2. 等待本次执行完成；核对 ledger 无 status=running、旧 executor 无存活 PID、syncStatus 已收敛。看 Notion Queued 为空还不够。
3. 前台空闲时 Ctrl+C；调度方式结束对应任务后，独立核实 cmd、Node 与其子进程已结束。当前 signal handler 只释放锁和退出，不优雅等待任务。
4. 存在活 executor 时先按照第 11 节取消，不在正在写文件时直接停桥。停止桥可能导致下次恢复 unknown，不能认定执行失败后无副作用。

重启前重新检查旧 PID/创建时间/命令所属目录。确认停净后再启相同 dataDir。锁里死 PID 由代码回收；活 PID 则拒绝启动。不要手删活锁。

## 9. 发单、审批和验收

发单正文用顶层普通段落或标题，首条 divider 之前才会进入 prompt；嵌套子页面、数据库行和附件内容不会自动展开。正文最多遍历 20 页 × 100 块；触及上限只日志提示，并非自动拒绝。指令应短且完整。

Notion 的推荐操作顺序：先填正文和属性，Status 暂设 NeedsApproval；检查后最后改成 Queued。只读任务无需 Approved，但为记录审阅可先设 Approved。写任务必须 `WriteMode=write` 且 `Approval=Approved`；Pending 会被置 NeedsApproval，不调用 executor。批准后人工将 Status 改回 Queued，仅改 Approval 不会被查询到。

Queued 后不改需求；新需求新行新 TaskID。门禁回执自己也会插 divider，往它下方补充指令无效。重复排队已同步的终态任务被视为新的真实执行请求，可能再次调用模型；不要把重置 Queued 当作“刷新结果”。

当前正常运行路径**没有写 Notion Status=Running**。本地 ledger.status=running 才是执行中的依据，页面可能一直显示 Queued 至终态。schema.md 中的理想状态箭头不应被用来要求现场出现尚未实现的 Running。

Done 只表示 CLI code=0。必须另外核验任务要求、输出文件、原始输入哈希、数据口径、人工签收。ChangedFiles 是执行后 git status 列表，并非 before/after 差集；干净目录、非 Git 目录或原有脏文件需要独立文件哈希/差异核对。Tokens 只取 CLI 上报，unknown 不代表零消耗，也没有货币成本计算。

## 10. 执行与同步状态判读

| ledger 状态 | 含义 | 正确操作 |
|---|---|---|
| status=running / executionStatus=running | 已创建本地运行记录；PID 可为 null 或仍存活 | 查 PID、日志及 CLI；不能凭页面 Queued 再启动另一桥 |
| succeeded + properties_pending/writeback_pending | CLI 已成功，Notion 属性未完成 | 自动/下次启动只补写；不重跑模型 |
| failed/cancelled + pending | 执行失败/取消已落本地，展示待同步 | 保留终态，先解决 API/权限问题 |
| unknown / status=recovered-unknown | 重启时旧 PID 已死，结果未知 | 查看业务文件和原始日志；人工核验，不猜 Done |
| 任一终态 + synced | 属性已同步；正文追加可能失败 | 若日志 report=failed，只补报告，不回到 Queued |

补写发生在启动以及每轮查询之前。syncEntry 的属性更新失败才进入 pending；属性成功、报告追加失败时仍置 synced，**没有自动补报告的持久队列**。需要人工从本地记录恢复正文；不能通过重新调用模型修复展示。

旧格式 ledger 的 done/failed/cancelled 没有 syncStatus，代码把它当作已投影终态；再次 Queued 会执行。恢复前应核对格式，不能概括为“同一 TaskID 永不重跑”。实际索引是 Notion page id，TaskID 用于运行标识及路径；保持业务号全局唯一。

## 11. 取消、超时、重试与紧急停止

- 运行中把对应 Notion 行改 Cancelled，桥每 15 秒查询一次；API 可达且 watcher 正常才可及时发现，**不是 15 秒内无条件停止**。开始执行前已有队列快照，临近启动取消也不是原子队列撤销保证。
- Windows 用 taskkill 终止所拥有 PID 的树；OpenCode 已有 service 不在此树，任务可能继续。首批试点不使用需要取消后立即停止写入的 OpenCode 工作。
- timeoutMs 默认 1800000，下限 60000。超时会走进程树停止，必要时强杀；最终报告 Timeout 仍需核对副作用及外部 service。
- 默认 maxRetries=1，单次运行最多 1+maxRetries 次，跨排队次数由 Attempts 硬上限 3 限制。失败及超时后的写操作可能已部分发生；试点配置设 0，避免自动再写。
- Attempts>=3 时不再调用 executor。只有人工确认前次结果、保存证据后才重置；新需求优先新行，不复用旧意图。

紧急停止先禁用 AI-Bridge-Poll，记录锁 PID、创建时间、命令行/仓库归属及子进程。仅对已确认属于本桥的 PID 执行终止，不批量杀 node.exe/codex.exe/opencode-cli.exe。不把读取到的 PID 直接拼成杀进程命令；PID 可能复用。停桥、停本桥 executor、核对 OpenCode session 三件事分别验收。若无法确认后台任务已停止，保持输入/输出目录隔离，禁止恢复生产消费。

## 12. 故障处理表

| 现象 | 核查 | 处理与通过标准 |
|---|---|---|
| another bridge instance | 锁 PID 是否是本桥、是否仍活、是否另一终端或调度启动 | 保留唯一实例；死锁让代码回收；不能删 ledger |
| ENOENT / EINVAL | doctor 的实际二进制路径；是否 .bat/.cmd 而非 exe | 固定真实 exe；doctor 通过后再烟测，不复制巨大二进制伪装名字 |
| doctor 版本身份 FAIL | 是否把 opencode 指向 cmd.exe，是否版本输出命名正确 | 修 executorPaths；不能把任意 code=0 视为 CLI 有效 |
| Notion 401 | token 的本机来源、同名环境覆盖 | 本地修凭证/重启进程，不回显 key |
| Notion 403/404 | 库是否分享给同一 integration，ID 是否数据库而非视图/数据源 | read-only doctor 通过，再做隔离写回验收 |
| 400 / data-source 提示 | 固定 API 版本和实际单/多数据源 | 记录错误；不自动升级版本、不自动改库；保持队列停止 |
| 429 / 5xx | bridge 日志 lastSyncError、网络与 Notion 状态 | 不新发模型任务，等补写；客户端没有专门的退避/Retry-After 策略 |
| 进程活着，空闲很久无 poll | 是否在 executor、是否卡 fetch、是否 sleep/休眠 | 对照 ledger/PID/最后日志；不只重启造成未知执行 |
| opencode code=1、stderr 空 | 用户 service 日志与会话 | 区分上游错误和 CLI 参数；不自动换档/再排队 |
| 正文缺报告，属性 Done | bridge 日志 report append failed | 从 ledger/日志人工补报告；不重跑 executor |
| Done 但文件不对 | CLI 最后消息、输入/output 哈希、任务指令读取边界 | 标业务验收失败；保存证据、发新修正任务 |
| ledger JSON 损坏 | 停桥后严格 JSON.parse、历史快照与运行日志 | 当前 loadLedger 会静默回退空账本；**先恢复证据，不带坏账本重启** |
| workdir 不合法/重叠 | 配置及真实路径/junction | 只修隔离目录的白名单，不能放开到磁盘根或生产父目录 |

## 13. 日常监控与日志

本轮没有创建自动化或通知渠道。未来由运行负责人在值守窗口开始/结束检查，并按下列规则做人工记录：

1. 进程层：任务计划 Running、桥 PID 和创建时间；这只能证明进程存在。
2. 队列层：空闲时最近 poll 时间及排队量；正常空闲应约每 pollIntervalMs 出现日志，但执行、补写和网络耗时会拉长。
3. 执行层：ledger running 的开始时间、PID、Attempts；超过 timeoutMs + 40 秒仍活要检查，但网络等待不受此 timeout 管。
4. 展示层：pending 持续 5 分钟则人工核查 API；以同一 runId 对照 Notion 属性及报告标记。
5. 业务层：核对产物和验收人签收，不能用 Done 或 tokens 替代。

时间：bridge 日志和运行目录日期使用 UTC，业务表按北京时间（UTC+8）记录，跨日不要混用。

`redact()` 作用于桥日志和部分摘要，**stdout.log / stderr.log 是直接 pipe 的原始 CLI 输出，ledger 的部分 error/lastSyncError 也不保证完全脱敏**。日志和 data 仅保留在受限本机目录；对外共享需审阅脱敏。备份不上传密钥，也不把 data 直接推到公开 GitHub。

当前没有自动日志轮转。目标是桥日志每日换档或 50 MiB 提前换档；值守时先按第 8 节停机，再将 bridge-current.log 复制到带 UTC 日期/序号的归档，确认字节/hash 后才清空当前日志并重启，不能在线重命名视为已完成轮转。executor 日志同日同 TaskID 会覆盖，每个任务验收后立刻按 TaskID/runId 复制其日志、ledger 条目及业务产物至证据归档。保留近 30 天为操作建议，不是已实现定时清理；ledger、pending/unknown 和未结问题证据不删。日志总量超过 1 GiB 提醒人工。

## 14. 备份、恢复和迁移

一致性备份应在停止发单、无运行中任务、无活旧 executor、桥已停止后进行。若只能紧急快照，记录“非一致性、可能有未知执行”，恢复后逐条人工核对。

备份包至少包括：代码 HEAD 与未提交 patch、package/config 模板、私密配置及 `.env` 的受控本地备份、整个 dataDir、业务输入/output 和哈希清单、CLI 版本/路径、任务计划导出 XML。含密钥的备份与可共享证据包分开，不交叉上传。

恢复顺序：

1. 保持调度禁用，确认没有原桥及其 executor 仍在消费同库。
2. 恢复配套代码/配置/业务快照，严格解析 ledger.json；不能将解析失败的空 ledger 当成“没有执行过”。
3. 核对每个 running PID 的身份和存活；对已死的 PID 用实际文件及日志复核，记录 unknown；活 PID 不能靠旧锁推定归属。
4. 对终态 pending 保持本地执行真相，只恢复 Notion 投影。**恢复旧 ledger 会遗失备份之后的执行记录，可能重跑仍 Queued 的页**；必须先与最新日志/页面对账。
5. 临时隔离队列：启动会补写后立即查询并执行，当前没有 reconcile-only 模式；不能以“只补写”为由忽略其他 Queued。
6. doctor 与离线测试通过，人工签收对账清单后，才在专用测试队列恢复运行。

迁移主机时禁用原实例，完整带走 ledger；重新验证新用户 CLI 登录、真实绝对路径和白名单。不能两台机器共享同一个 Notion 队列同时上线。

## 15. 变更、升级与回退

第 1–5 节是 CLI 具体升级规则。代码/调度变更也按以下顺序：停发单并排空 → 停调度和桥 → 保存代码/config/data 及任务计划 → 记录版本 → 隔离测试 → doctor → 专用只读烟测 → 业务验收 → 另行授权恢复常驻。

失败时保留失败日志及版本，恢复旧二进制路径/旧代码。不要运行会抹掉现有改动的 git reset --hard；可在独立 checkout 准备旧版本后人工切换。不要为了回退代码恢复过时 ledger；账本必须反映已经发生的执行。调度模板卸载或禁用不会撤销业务文件，副作用按业务快照单独恢复。

回退完成标准：新任务不再运行、唯一已知版本可诊断、无未知活子进程、ledger 对账完毕。恢复生产消费需新决策，不由一次测试通过自动触发。

## 16. 试点放行与已知缺口

完整业务输入、试点库授权、隔离目录和人工复核人尚待试点阶段落实。当前仅证明本地测试和只读诊断，不证明模型业务正确性或常驻稳定性。详见 PILOT-PLAN。

| 缺口 | 当前处理 |
|---|---|
| Notion 正常运行没有 Running 投影 | 以本地 ledger 为准，纳入后续工程问题，不在本轮改 src |
| API 无 deadline、进程无心跳告警 | 有人值守，卡住先查 PID/日志，不自动重跑 |
| OpenCode 共享 service 取消不可靠 | 首批用 Codex 只读；standalone 待真实验收 |
| 原始 CLI 日志和部分错误未全量脱敏 | 本机受控保存；共享前人工脱敏 |
| ledger 损坏回落空记录 | 启动前严格解析，停机一致性备份 |
| TaskID 同日目录复用、无不可变 prompt 快照 | 每单新 TaskID，试点人工冻结正文/输入/输出和哈希 |
| 调度停止不保证所有子工作已停止 | PID/创建时间和 service/session 分别核对 |
| 仅规划进程退出重启，无自愈卡住逻辑 | 设置有界重启；登录/断网/重启/长跑仍待未来现场验收 |

## 17. pending 人工处理、演练页归档与升级求助

“清理 pending”指让待同步结果正常投影，不能删除 ledger 条目。操作顺序：

1. 停发单并保存 ledger/日志副本，列出 page id、runId、executionStatus、syncStatus、lastSyncError。
2. 检查 Notion 凭证/访问权和 API，运行只读 doctor；不清 Attempts、不重新 Queued。
3. 确认没有其他排队任务会被误执行后，再允许原桥下一轮补写。无 reconcile-only 开关，不能为了补写直接忽略队列内容。
4. 对照 ledger 为 synced、属性与原终态一致；缺正文则从本地证据人工补回带同一 runId 的报告，并避免重复追加。
5. 仍失败保留原条目，记录原始错误并找运行负责人。错误中的密钥先脱敏，不把未知执行改成 Done。

演练页归档：先完成本地证据归档和哈希校验，确认无 running/unknown/pending；在清单记录 Notion page id、TaskID、runId 和终态；再由人工把已验收演练页归档（或移入人工归档视图，按本机 Notion 功能确认）。归档不是删除执行历史，ledger 留存。未同步页不可先归档，否则补写可能 404。需要再演练时新建页新 TaskID，不恢复旧页再排 Queued。每次归档后核查队列不包含旧演练任务。

出现以下任一项停发单、保留证据并找用户/运行负责人：疑似重复调用模型、越界访问/写入、未批准 write 被执行、密钥出现在日志或页面、坏 ledger、未知活 PID、生产目录进白名单、API 模型需要迁移。CLI 参数/身份不能确认找工具维护者；平台 403/400 找平台连接或 Agent 发布配置负责人；不自行拓权或切换执行器掩盖错误。

本轮完成定义是第 2、3 项文件与离线/只读证据交付。N2 的正式评审、实际服务部署、真实业务执行及第 4 项都不包含在这个完成结论中。不使用公开仓库绑定 self-hosted runner。
