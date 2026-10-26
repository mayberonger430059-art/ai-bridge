# 给 Notion Claude 的评审任务：完善 AI Bridge v0.1 代码

## 项目一句话

AI Bridge 是 Windows 本机服务：Notion 发任务 → 本机轮询拉取 → Codex 或 OpenCode
执行一次 → 结果回写 Notion。目标是最简单、最稳定、最低成本，**不是**大系统。

## 硬约束（改动不得违反，违反即视为不合格）

1. 零 npm 依赖（Phase 2 的 coding-agent-runner 适配器除外，且默认不接入）；
   Node >= 20，只用内置 fetch / child_process / fs / path。
2. 不加界面、不加插件市场、不加多智能体辩论、不加并行执行。
   maxConcurrent 恒为 1，一个任务 = 一个执行者。
3. 不碰足球分析系统、核心算法、生产数据库、已有 Agent 配置。
   测试目录只能是独立目录（如 D:\AI-Bridge\test-workdir）。
4. 工作目录白名单 + protectedPaths 挡板 + WriteMode/Approval 审批 gate 必须保留且只能加强。
5. Token 只解析 CLI 自身 JSON 输出的 usage；解析不到写 unknown，绝不估算、绝不编造。
6. 密钥只存本机 .env，绝不写进 Notion、日志、代码、Git；日志输出必须经过 redact。
7. 不改任务状态机语义：Queued → Running → Done/Failed；NeedsApproval、Cancelled
   的含义见 notion/schema.md；Done 只能由桥接服务写。
8. 失败重试有上限（默认 1 次，硬上限 3 次），不许写成无界循环。

## 代码现状（v0.1，本地路径 ~/workspace/ai-bridge/，共 24 个文件）

- src/bridge.js：轮询、认领、审批 gate、取消监听（15 秒查一次 Notion）、回写、重试、重启恢复
- src/notion.js：Notion REST 客户端（内置 fetch），任务正文 body 作 prompt，属性作元数据
- src/executors.js：codex exec --json --sandbox read-only|workspace-write -C <dir> -（prompt 走 stdin）；
  opencode run --format json --dir <dir> <prompt>（另有 standalone / print 两档可配置）
- src/config.js：配置、白名单 isInsideDir、审批、密钥掩码
- src/ledger.js：本地防重跑账本（data/ledger.json）
- src/doctor.js：一键诊断（不跑模型、不打印密钥）
- src/runners/coding-agent-runner.mjs：Phase 2 可选适配器，v1 未接入，bridge.js 会拒绝 useCodingAgentRunner=true
- test/：白名单、token 解析、密钥掩码、ledger 持久化，4 项通过
- 已知实测：Linux 侧 dry-run outcome=done；codex 0.164.0-alpha.9 与 opencode 1.19.4 的
  --help 形态与代码调用一致；但云主机 codex 未登录，Windows 真实闭环尚未跑通。

## 请重点审查、并给出可直接落地的改动（按优先级）

1. **路径逃逸**：isInsideDir 只做了字符串归一化，没有解析符号链接（symlink）。
   允许目录内的软链指向白名单外时是否会逃逸？给出加强方案（realpath / 拒绝软链 /
   执行前二次校验），并说明 Windows 下的注意事项。
2. **取消与杀进程**：取消监听是 15 秒轮询 + killProcessTree；Windows 下 taskkill /T
   与 Node child.kill 的实际效果、孙进程残留、超时后 SIGKILL 的 5 秒兜底是否够用？
   给出更稳妥的写法，但不要引入新依赖。
3. **Codex / OpenCode 输出解析**：目前 output 取 stdout 尾部 8000 字、token 只扫
   JSONL usage。若 CLI 输出格式变化、或结果在前半段被截断，会丢关键信息。
   给出更可靠的提取策略（例如 Codex --json 事件流里取最终消息、OpenCode json 事件
   里取最终文本），并保持“解析不到写 unknown”。
4. **Notion API 版本风险**：v1 默认 Notion-Version 2022-06-28；若工作区已切
   data-source 模型（2025-09-03），query 可能失败。给出兼容处理或明确的报错指引，
   不要静默改写用户数据。
5. **重试与 attempts 计数**：bridge.js 里 attempts 在认领时 +1，但进程内重试
   maxRetries 次并不再 +1；Notion 的 Attempts 栏与实际调用次数是否一致？
   给出一致的计数方案。
6. **单实例假设**：v1 防重跑依赖单实例 + 本地 ledger。若用户误开两个实例，
   有没有低成本的防护（例如启动时 PID 锁文件）？给出 Windows 可用的简单方案，
   不要引入数据库或网络锁。
7. **测试缺口**：现有测试只覆盖白名单、token、掩码、ledger。补上最值得补的
   单元测试：Notion 页面解析（parseTaskPage）、审批 gate、workdir 校验、
   超时/取消路径（用假子进程，不跑真实模型）。
8. **Windows 细节**：.bat 脚本、路径分隔符、命令行长度、stdin 关闭（opencode run
   须关 stdin 否则空挂，已有教训）等方面有没有漏掉的坑？逐项核对。

## 请不要做的事

- 不要把项目改成 Cezar / Agent_MCP-Bridge 那种大系统，不要引入数据库、Web 界面、队列服务。
- 不要默认接入 coding-agent-runner，不要把 Codex app-server 当成默认路径。
- 不要为“好看”加依赖、加配置项、加新执行者。
- 不要改动 README / RESEARCH.md 里已承诺的“未完成、待本机实测”诚实表述；
  改进代码可以，但不能把未验证说成已验证。

## 交付格式（请严格按这个格式回，便于人工落地）

对每一项改动，写清：文件路径、改动原因、改动前后代码（能直接替换的完整片段，
不要只写“大概改成这样”）、对测试的影响。
最后附一张清单：已改 / 未改（及原因）/ 需本机实测验证的项。
不要只给笼统建议；没有可落地代码的建议不算完成。
