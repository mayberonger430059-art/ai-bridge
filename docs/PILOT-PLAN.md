# AI Bridge 首个真实业务试点与 ChatGPT / Muse 发起闭环（第 3 项）

日期：2026-10-26（北京时间）。状态：**计划已交付，真实业务尚未执行**。本轮没有发 Notion 任务、没有运行模型、没有部署常驻，也没有操作足球系统。第 1 项继续等 N2 diff，第 4 项不启动。

本计划按原会话要求提供 3 个排序候选、两端独立闭环矩阵和上线门。不会把“本机人工建行成功”当成 ChatGPT/Muse 的发起权限已经通过，也不会把 doctor 查询成功当成写回权限通过。

## 1. 候选试点及选择

| 优先级 | 真实任务及价值 | 独立目录与输入 | 确定的验收答案 | 回滚、敏感性与限制 |
|---|---|---|---|---|
| 1，选用 | **AI Bridge 公开版本发版证据清单**：为下一次交付生成文件清单、SHA-256、包版本/入口及内部文档链接检查，直接服务当前仓库交付 | 从已公开、固定 commit 的 git archive 复制到独立 workdir 的 input/；不带 .git、.env、config.json、data/ 和本地交接私件 | 与独立工具计算的逐文件 SHA-256/大小清单完全一致；package.json name=ai-bridge、version=0.1.0、Node>=20；所有本地 Markdown 链接逐项有存在/缺失证据 | 只写独立 output/；输入哈希不变，删除或还原该 output 即回滚；只用公开内容；缺失链接照实报，不让模型修源文件 |
| 2 | **公开文档交付包完整性检查**：对用户本来要分发的非敏感文档副本，找缺附件、失效相对链接及命名重复 | D:\AI-Bridge-Pilots\docs-delivery-001；仅明确可公开的 Markdown/文本附件副本 | 人工事先固定“必需文件清单”及真实链接目标，与扫描结果逐条一致；不以文字润色主观评分 | 不改原文、不发邮件/发布网站；输入内容未确认非敏感前不开始；仅整理审阅清单 |
| 3 | **已脱敏目录清单的去重与交付核对**：对公开素材包检查同名不同内容、同内容不同名，减少重复打包 | D:\AI-Bridge-Pilots\asset-manifest-001；经批准的公开小文件副本，拒绝凭证/个人信息/生产库 | 独立 Get-FileHash 结果分组，重复项集合和总字节数精确相同，不做语义“近似重复” | 不自动删文件；只输出建议清单；输入不变、输出可删即回滚 |

首选发版证据清单有真实用途、公开输入、可重复的机械答案，不依赖尚未取得的业务台账或生产 API。它不同于 hello.txt：输出将用于实际发布前核对，并要求独立计算结果签收。

不选足球生产系统作首个试点：它承载现有分析、规则和正式数据库，模型动作可能对生产结果产生不可简单回滚的影响，而且用户明确禁止本轮改动。三个候选都不读取或写入足球生产内容，也不把其父目录加入白名单。

## 2. 试点合同：输入、输出、权限

首选使用本轮核实的**远端公开** `ad74fd2e18ea74b5576423b41b813e06c5f2c2a8` 快照；本地 `96b959a` 多的旧 RUNBOOK 提交尚未推送，不能混称它是已发布输入。未来准备时再次核实 commit，并把来源与 SHA 记入 input/SOURCE.txt。

两端使用完全相同的输入字节、两个干净目录、两个新 Notion 页和新 TaskID，**串行**进行，不能把上一端的结果喂给下一端。

| 项目 | ChatGPT | Muse |
|---|---|---|
| Workdir（未来创建） | D:\AI-Bridge-Pilots\chatgpt-release-001 | D:\AI-Bridge-Pilots\muse-release-001 |
| TaskID | BR-PILOT-CHATGPT-RELEASE-001 | BR-PILOT-MUSE-RELEASE-001 |
| Executor | codex | codex |
| WriteMode | write，仅 output/ | write，仅 output/ |
| Approval | 人工确认 input/ 和正文后 Approved | 同样单独批准，不沿用另一页审批 |
| Attempts | 从 0 开始；试点 maxRetries=0 | 从 0 开始；试点 maxRetries=0 |
| 输入 | input/repository/，SOURCE.txt，人工冻结的任务正文 | 与左侧相同字节，独立副本 |
| 输出 | output/manifest.csv、package-summary.json、link-check.csv、REPORT.md | 同左 |

选择 write 是为了生成真实可验收交付文件；它必须通过现有人工审批门，不能把生成文件的任务谎标 read-only。上线前另做独立 read-only/未批准 write 负向演练。

范围约束：Codex 的 workspace-write 限于该独立 workdir；原仓库不在白名单。input/ 的只读要求要由前后哈希及可选文件权限共同核验，不能假称目前已有 input/output 子目录级沙箱。CLI 子进程继承环境，当前实现未剥离 NOTION_API_KEY，因此“非敏感输入”不等于凭证绝不可能出现在输出；验收必须做本地不回显密钥的精确扫描，发现任何泄露立即停止并处理凭证。

准备时仅复制 git archive 的公开跟踪文件，不复制整个本机目录。链接检查只解析 Markdown 内的本地文件目标，跳过锚点/外部 HTTP，不访问外站；锚点内容正确性不在首单范围。manifest 路径使用相对 input/repository 的斜杠格式，按路径排序，字段 `path,bytes,sha256`；排除输出和参考答案。

独立参考答案必须由运行负责人在发单前用非模型工具生成并放在 workdir 外：完整文件清单、字节数、SHA-256、包字段、Markdown 链接目标及其存在性。它不能进入模型 prompt 或输入快照。不要只拿模型产物与模型的文字自证比较。

## 3. 可直接填写的 Notion 任务正文

下面正文分别复制到两张任务页，替换任务号/目录，先由人核对。不要在正文插 divider。正文冻结后保存离线副本及其哈希；Queued 后不编辑。

> 为当前 AI Bridge 公开版本制作发版证据包。
>
> 只读取本 Workdir 的 input/repository/ 与 input/SOURCE.txt，只允许在 output/ 创建文件。不得修改 input/，不得访问 Workdir 之外的业务文件，不读取凭证或用户配置，不调用其他 agent，不连 Notion/GitHub 或外部网站，不部署任何东西。
>
> 为 input/repository/ 中的全部普通文件计算 SHA-256 和字节数，按相对路径排序写 output/manifest.csv（path,bytes,sha256）。不跟随链接；发现链接则报告并停止，不猜目标。
>
> 从 package.json 原文提取 name、version、engines、scripts、dependencies、devDependencies；不存在的字段写 null，写 output/package-summary.json，不安装或执行仓库代码。
>
> 检查仓库 Markdown 文件的本地文件链接：记录 source、target、resolved_path、exists；去除 URL 的片段/查询部分后再核存在性，忽略外部 URL、仅锚点和图片远程地址。无法确定的语法写 unparsed，并保留源行，不猜成功。输出 output/link-check.csv。
>
> 在 output/REPORT.md 说明来源 commit、处理文件数、缺失链接和未解析项数量、生成的文件清单与未完成部分。不要修复输入文件，不把缺失链接改为 PASS，不输出任何环境变量或密钥。最后输出简短摘要及 output/ 文件路径。

业务验收不依赖模型自己报告的 PASS。若 Markdown 链接解析有 unparsed，人工逐个核对后才签收；任何未解析项不得默默排除分母。

## 4. 执行前门槛（当前未完成）

1. N2 diff 正式评审仍由第 1 项处理；本文不以已有提交和 63 项测试替代它。真实试点放行前对齐其结论。
2. 另行授权试点执行/调度；本轮文档交付不是部署授权。首次试点可用人工 once，不依赖常驻已启用。
3. 准备专用 Notion 试点库和独立本地状态，或在确认现有唯一消费者停止、队列与账本完全对账后安排独占试点窗口。不同 dataDir 不得并行消费同库。
4. 备份旧配置/ledger；把两个独立 workdir 加入专用配置白名单、保留生产保护路径。当前正式 config/.env 未改；如切数据库，BRIDGE_CONFIG 不会切换 `.env`，必须核对进程实际凭证上下文。
5. 用相同公开 commit 准备输入，扫描无敏感内容，记录哈希；生成并封存独立参考答案。现在尚未创建试点目录或假造文件验收结果。
6. doctor 本地及只读 Notion 检查通过；CLI 绝对路径、版本和真实账号可用；当前普通 doctor 不证明模型调用权限有效。
7. 各平台分别证明能列出目标库并读取一张测试页；具备发单/读结果权限。不要借本机集成的成功替任一平台签字。
8. 先完成负向演练：未批准 write 不调用 executor、路径越界拒绝且无文件变化、成功后写回故障只补写、取消残留按实际进程核验。当前单测是支持证据，真实演练仍待记录。

## 5. ChatGPT / Muse 闭环测试矩阵

每个单元格分别记录页面链接、TaskID、北京时间、runId、Attempts、PID/调用证据、输入/输出哈希和截图/字段读回。执行者是本地桥的 Codex，发起者分别是 ChatGPT 与 Muse。两端均不得由人工代建行后声称平台发单通过。

| 步骤 | ChatGPT 的独立验证 | Muse 的独立验证 | 失败分类与下一步 |
|---|---|---|---|
| A，连接与读权限 | 在 ChatGPT 自己会话列出并读目标库/测试页 | 在 Muse 网页自己的会话重复 | 未连/403/查不到库：平台连接或分享权限；先修平台，桥不启动 |
| B，创建任务 | ChatGPT 自己建新页，正文/TaskID/Executor/Workdir/WriteMode/Approval 逐项读回；Status 暂 NeedsApproval | Muse 自己创建另一页并读回 | 创建被拒、字段类型不符：平台写权限或 schema；不是 executor 故障 |
| C，审批与发布 | 人工核对目录、冻结正文后 Approved；由发起方最后将该页置 Queued 并读回 | 同样独立审批与 Queued | 平台连审批字段都改不了：平台权限；写任务未批准被 NeedsApproval 拦下：预期门禁 |
| D，本地拉取 | 本地唯一桥读取 ChatGPT 页，ledger 记录执行、Attempts=1、一个 executor 进程 | 前一任务结束且归档证据后，消费 Muse 页 | 页面已 Queued、桥无 poll：桥/网络；桥查询 403：本机 integration；两者凭证不同 |
| E，本地执行 | 在 ChatGPT 的独立副本仅写 output/，原输入不变 | Muse 的副本重复同一任务，不能读 ChatGPT output | spawn/参数/登录/上游模型错误：executor 层；不靠更换平台掩盖 |
| F，结果写回 | 核 ledger 终态、Notion 属性与 runId 报告对应；pending 只补写 | 同样核对 Muse 页 | 本地 succeeded、页面旧：桥回写/Notion API；不重新执行。属性成功正文缺失要单列 |
| G，平台读结果 | ChatGPT 自己重读同一页并复述真实终态、摘要、Tokens/unknown 和本地路径 | Muse 自己重读其页 | 本机能写，平台读不到：平台分享/读取/缓存，不是任务没执行；本地路径不是云端附件 |
| H，业务签收 | 人工将 output 与封存参考逐字段比较、前后 input 哈希一致 | 同口径独立比较；比较两端 raw 结果集合 | Done 但文件不符：假 Done/业务失败；立即停试点，不报告整链通过 |

Notion Claude 历史 `403 restricted_resource`（连接未获 Custom Agent 会话权限）与 `400 Agent is not published or configured` 属平台能力/发布配置问题，不应归为本桥 defect。发普通 Notion 任务页不需要调用 Claude Custom Agent；本计划不尝试发消息给任何 Agent。

判因时保留 HTTP 状态、request_id、阶段和脱敏错误。ChatGPT/Muse 连接、本机 `.env` 的 REST integration 是不同身份，不能相互替代。工具“列在清单中”也不能替代该步骤真实调用成功。

## 6. 上线门与记录口径

以下是未来验收门，不是本轮已达到的业务成绩：

| 门禁 | 必须达到的原始计数/标准 | 证据 |
|---|---|---|
| 两端发起闭环 | ChatGPT 1/1、Muse 1/1，各自 A–H 全通过 | 两端自己的工具读回、页面/本地记录 |
| 假 Done | **0**：Done 但产物缺失、参考不符或输入被改均失败 | 逐文件哈希、字段比较和人工签收 |
| 重复执行 | **0**：试点每个新页一次 executor 调用、Attempts=1；写回故障只补写 | 原始进程/CLI事件和 ledger，不能仅信 Attempts |
| 未批准 write | **0**：负向任务 executor 调用=0、输入/输出无变更 | NeedsApproval、进程证据和哈希 |
| 越界写入 | **0**：所有写入限于各自 output/，原仓库与生产系统无变化 | 原始目录快照、sandbox/工具日志；无法证明则门未通过 |
| 密钥外泄 | **0**：页面、产物、原始日志不出现本机凭证 | 本地私密扫描只记录命中数，不打印 token；未扫描不得宣称零 |
| 取消与残留 | 负向演练后本桥子树停止；任何共享 service 残留单列 | PID/创建时间、文件时间线；首批不用 OpenCode 承担该保证 |
| Token 观测 | CLI 有 usage 则原样记录；无则 unknown，**禁止估算** | stdout 与 Tokens；unknown 不当作 0，也不换算金额 |

不使用平均成功率掩盖一次 P0。任一假 Done、重复调用、未批准 write、越界写入或泄密发生，立即停发单、禁用调度、保存证据并交用户决策；不自动增大权限、不自动重试以抹去失败。

每次试点记录：发起平台及会话、输入 commit/SHA、任务正文 hash、Notion page id、TaskID、runId、配置/CLI 版本、startedAt/finishedAt、真实调用数、Attempts、executionStatus/syncStatus、报告是否存在、Tokens/unknown、业务比较及签收人。当前每一项业务运行结果均为“未执行”，不是 PASS。

## 7. 回滚、归档及何时扩大

回滚仅针对独立试点目录：先停桥及实际子工作，保存输入/output/ledger/日志证据，恢复干净 input，清空或隔离本次 output；原仓库和任何生产数据不改。删除 output 前核对绝对路径确属本试点，不沿 junction 删除其他目录。Notion 页保留原终态及失败说明，不把它改成成功；新需求新页新 TaskID。

归档按 RUNBOOK 第 17 节，先证据后页面，未同步和 unknown 不归档。每个平台完成 1 个有效业务样本只证明这两个闭环可用，不证明长期稳定性、效率或预测质量改善。两端及负向门通过后才考虑扩大到每端再 2 个独立文件包；服务登录触发/重启/长跑另行验收；coding-agent-runner 的第 4 项仍不自动启动。

## 8. 本轮已具备和仍欠缺

已具备：公开源仓库、冻结可引用的公开 commit、可运行的本地测试、doctor 诊断和本计划。仍欠缺：两端目标库的实际发单权限证明、专用输入快照/参考答案、专用目录/配置、真实模型调用、两端各一遍 A–H、负向现场演练、业务签收与服务运行验收。本轮没有用测试 hello 文件代替上述业务证据。
