# Notion 任务数据库配置方法

## 1. 建库（人工，约 5 分钟）

1. 在 Notion 里新建一个 Full page database，命名：`AI Bridge Tasks`。
2. 按下表建属性，**属性名必须一字不差**，否则桥接服务读不到：
   | 属性名 | 类型 | 说明 |
   |---|---|---|
   | Title | Title | 任务标题（Notion 默认 title 列改名即可） |
   | TaskID | Rich text | 稳定任务号，如 `BR-TEST-OPENCODE-001`；为空时桥接服务用 Notion page id 派生 |
   | Status | Select | 选项必须包含：`Queued` `Running` `Done` `Failed` `Cancelled` `NeedsApproval` |
   | Executor | Select | 选项：`opencode` `codex`（`dryrun` 仅本地测试，Notion 任务里不要用） |
   | Workdir | Rich text | 绝对路径，如 `D:\AI-Bridge\test-workdir`，必须在 config.json 白名单内 |
   | WriteMode | Select | 选项：`read-only` `write`；默认 read-only |
   | Approval | Select | 选项：`Pending` `Approved`；WriteMode=write 时必须 Approved 才执行 |
   | Attempts | Number | 桥接服务回写，已执行次数 |
   | ResultSummary | Rich text | 桥接服务回写，执行结果摘要（截断 1900 字） |
   | Tokens | Rich text | 桥接服务回写，如 `input=.. output=.. total=..`，解析不到写 unknown |
   | Error | Rich text | 桥接服务回写，原始错误（截断） |
   | LogPath | Rich text | 桥接服务回写，Windows 本机日志路径（日志本身不在 Notion 里） |
   | ChangedFiles | Rich text | 桥接服务回写，git status 结果；非 git 目录写明“无 diff” |
3. 在 Notion 里建一个 Integration（notion.so/my-integrations），把这个数据库
   **单独**分享给该 Integration（Share → 选 Integration），复制 token 到本机 `.env`。
   不要把 token 写进 Notion 页面、不要发到聊天里、不要提交到 Git。
4. 把数据库 id 填进 `.env` 的 `NOTION_DATABASE_ID`。
   数据库 id 是数据库页面 URL 里 `notion.so/` 后面那串 32 位十六进制（去掉横杠也行）。

## 2. 发任务（ChatGPT / Muse / 人工，三方同一种写法）

新建一行，填：
- Title、TaskID、Executor、Workdir、WriteMode、Approval、Status=`Queued`
- **页面正文（body）写完整任务指令**——桥接服务读 body 作为 prompt，
  不要只把指令塞进某个属性里（属性会被截断）。
- ⚠️ **正文里不要用分隔线（divider）做排版**。桥接服务用 divider 划分
  「指令区」和「桥接服务自己追加的报告区」：读 prompt 时**读到第一条 divider 就停**。
  如果你自己在指令中插了 divider，它**后面**的内容不会被当成指令执行——
  而且不会有任何报错，表现为「任务跑了但后半段要求没做」。要分段请用标题或空行。
- ⚠️ **这条 divider 是桥接服务自己插的**（第一次写回执时，包括 `NeedsApproval`
  门禁提示）。所以「任务被拦下 → 去正文里补充说明 → 点 Approved」这条流程
  **不生效**：补充说明会落在 divider 之后被跳过，任务仍按旧指令跑。
  要改指令，请改 divider **以上**的内容，或新建一行任务。
  桥接服务现在会**明说**这件事：运行时日志会打印
  `prompt: <TaskID>: stopped at the divider, ignored N block(s)`，
  任务报告末尾也会写一行 `Prompt note: N block(s) after the divider were NOT part of
  this run's instructions.`。看到这行就说明你补的说明没被读到。
- 读 prompt 时会**翻页**（每页 100 块），所以 divider 落在第 100 块之后也能被正确识别。
- **Status 一旦变成 Queued，这次执行的意图就冻结了。** 要改需求请**新建一行任务（新 TaskID）**，
  不要改正文：divider 之后写的内容不属于本次执行，改 divider 以上也会让「同一 TaskID
  跑了两种指令」，事后无法判断模型到底接受了哪一版。

状态机（只有桥接服务和人工能改 Status，ChatGPT/Muse 只负责发 Queued 和读结果）：
```
Queued → Running → Done | Failed
Queued → NeedsApproval →（人工把 Approval 改成 Approved，并把 Status 改回 Queued）→ Running
任何时刻人工把 Status 改成 Cancelled → 桥接服务在 15 秒内杀掉子进程 → Cancelled
```

### 写回与重跑：ledger 是执行事实，Notion 是可重试的投影

本地 `data\ledger.json` 才是「这个任务跑没跑过」的真相，Notion 的 Status 只是它的投影。
每次执行结束后，桥接服务**先把结果落到本地**，再去写 Notion：

```
executor 结束（成功 / 失败 / 取消）
  → ledger: executionStatus=succeeded|failed|cancelled|unknown, syncStatus=properties_pending
  → Notion 属性（Status / Tokens / ResultSummary / ChangedFiles / LogPath / Error）
  → Notion 正文报告（首行是 `Run: <runId>` 标记）
  → 全部成功：syncStatus=synced
  → 属性写失败：syncStatus=writeback_pending + lastSyncError，executionStatus 不变
```

三条硬规则：

- **写回失败不改变任务结论。** 已经成功的执行不会因为 Notion 写不进去而变成 Failed；
  真实的失败原因也不会被「同步失败」的文本覆盖——后者只进 `lastSyncError`。
- **写回失败不导致重跑。** 每次启动、每轮轮询之前都会先做对账（reconcile），
  只补写回、不进执行器。日志里会看到
  `reconcile: N terminal result(s) waiting for Notion writeback (no executor call)`。
- **报告失败不算同步失败。** 报告是注释、不是结论：属性写成功即视为 synced。
  报告带 `Run: <runId>` 标记，重试不会重复追加同一份报告。

所以 `Status=Queued` 其实有两种含义，桥接服务靠 ledger 区分：

| Notion | ledger | 行为 |
|---|---|---|
| Queued | 无记录 | 正常执行 |
| Queued | 有终态但 `syncStatus` 是 pending | **只补同步**，绝不再调模型 |
| Queued | 有终态且已 synced | 视为**人工要求的重跑**，重新执行 |
| Queued | `status=running` 且进程还活着 | 跳过（另一个实例在跑） |

旧版本 ledger（没有 `syncStatus` 字段）按「已同步」处理，不会重复写回；
旧版本遗留的 `running` 条目仍然走原来的 recovered-unknown 路径，
标记为「结果未知」，不会被升级成成功。


## 3. 读结果

- Done/Failed 后看同一行的 ResultSummary / Tokens / Error / ChangedFiles，
  以及页面正文末尾追加的报告块（执行时长、执行者、工作目录、日志本机路径、输出摘要）。
- 完整 stdout/stderr 日志只在 Windows 本机的 `data\runs\<日期>_<TaskID>\` 里，
  不上传 Notion（日志可能含长输出和敏感路径，这是故意的）。

## 4. 不要做的事

- 不要在 Notion 里放 API key、密码、token。
- 不要把 Status 直接改成 Done 来“假装完成”——Done 只能由桥接服务写。
- 不要同时开两个桥接服务实例跑同一个数据库（v1 是单实例顺序执行，防重跑靠
  本地 ledger + 单实例假设；双实例会破坏这个假设）。
- 不要把足球分析系统的目录（`D:\yangyang_data\...`）登记进 allowedWorkdirs。
  测试一律用独立目录 `D:\AI-Bridge\test-workdir`。
