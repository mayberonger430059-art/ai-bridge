# AI Bridge — 候选项目实查结论（2026-10-25）

结论先行：三个候选都不直接等于“Notion 任务中心 + 本地执行 + 结果回写”。
最贴合的是第一候选，但它只是执行层，不是完整桥；另外两个要么太重、要么方向反了。
所以 v1 的正确做法是：**自写约 600 行零依赖 Node 服务做队列/状态/回写，
直接调官方 CLI 做执行；把 coding-agent-runner 留作 Phase 2 可选执行适配器，
Cezar 和 Agent_MCP-Bridge 本轮不引入。**

## 1. yinguangyao/coding-agent-runner — 采用为 Phase 2 执行适配器，不做 v1 主路径

- 仓库：https://github.com/yinguangyao/coding-agent-runner ，MIT，公开，24 stars，19 commits（2026-07-08 创建）。
- 它是什么：Node.js SDK，“Run local coding-agent CLIs from Node.js through one small Node-only API”。
  覆盖 codex（`codex app-server --listen stdio://`）、claude（stream-json）、cursor、opencode（`opencode acp`）、pi。
  提供统一事件流、取消、会话续跑、CLI 检测。
- 它明确**不提供**的东西（README 原话）：UI、数据库、任务队列、沙箱、凭证管理、内存层。
  也就是说：它解决不了 Notion 拉取、任务唯一 ID、防重跑、超时取消回写、审批这些桥的核心需求。
- Windows 兼容性：Node 20+、ESM、纯 stdio 子进程，理论上 Windows 可用；
  但有两个未验证点：① Codex app-server 是实验性接口，稳定性不如 `codex exec`；
  ② OpenCode ACP（`opencode acp`）在用户本机版本上是否可用未验证；
  ③ README 里的沙箱示例是 macOS 的 `sandbox-exec`，Windows 上不适用。
- 判定：复用价值高，但只复用“执行”这一层，且要等直接 exec 闭环跑通后再接。
  代码里已留 `src/runners/coding-agent-runner.mjs`（未接入 bridge.js，bridge.js 会明确拒绝
  `useCodingAgentRunner=true`，防止有人误切未验证路径）。

## 2. open-mercato/cezar — 功能最全，但违背“最简单、最稳定”目标，本轮不引入

- 仓库：https://github.com/open-mercato/cezar ，MIT，832 stars，1670 commits，v0.15.0（2026-10-11）。
- 它是什么：多智能体编排 + 驾驶舱：`npx cezar-run` 起 `http://localhost:4321`，
  每个任务独立 git worktree、并行队列、YAML 工作流、实时 token/成本看板、
  GitHub/Jira/Linear 触发、无数据库（状态存 `.ai/cezar/` 文件）。
  用你自己的 claude/codex/opencode 等登录，不需要额外 API key。
- 为什么不做主路径：
  ① 它的任务源是 GitHub issue / 驾驶舱输入 / Jira/Linear，**没有 Notion 原生任务源**，
     要接 Notion 还得再写一层，等于在重系统外面再套一层；
  ② 它是“几百个 agent 并行 + 工作流图 + 节点编辑器”的大系统，用户本轮明确要求
     “不要同时引入多个大型框架”“先做真实闭环，不开发复杂界面”；
  ③ 它的驾驶舱是本地 HTTP 服务，跑起来容易，但与“本地服务不对公网开放、
     只做 Notion 拉取”这个安全模型不完全同路，需要额外收口。
- 保留价值：如果将来要“并行多任务 + 可视化驾驶舱 + 工作流图”，Cezar 是第一备选，
  到时再评估把它当执行层、Notion 只做任务登记的做法，而不是现在就全量引入。

## 3. jadAkeel/Agent_MCP-Bridge — 方向反了，且版本钉死，本轮不引入

- 仓库：https://github.com/jadAkeel/Agent_MCP-Bridge ，ISC，2 stars，387 commits。
- 它是什么：一个 MCP 服务器，让 Codex / Claude Code **作为规划方**，把有边界的
  任务委派给 OpenCode agent 执行，带 Scope Contract（越界改动拒绝）、写者 worktree、
  合并前人工预览补丁、SQLite 持久化、并行上限。
  安装目标明确写了 Windows 11 / Linux / macOS。
- 为什么不做主路径：
  ① 方向反了：它是“Codex 指挥 OpenCode”，而 AI Bridge 需要的是
     “Notion 派单 → Codex 或 OpenCode 任一执行 → Notion 回写”，Codex 在这里是执行者不是指挥者；
  ② 它要求 OpenCode **恰好 1.18.32**（公开安装器限定版本，README 原话），
     版本钉死 + 2 stars 的小众项目，升级和排障成本都落在我们头上；
  ③ 它没有 Notion 任务中心，也没有 Muse（网页版）参与路径。
- 保留价值：它的 Scope Contract / 写者 worktree / 合并前预览这三个机制值得借鉴，
  v1 用更简单的等价物代替：工作目录白名单 + WriteMode/Approval 双 gate + git status 事后核对。

## 4. 官方 CLI 直调（v1 实际采用的执行路径）

- Codex：`codex exec --json --sandbox read-only|workspace-write -`，prompt 走 stdin
  （避开 Windows 命令行长度限制）；默认 exec 沙箱是只读，写文件必须显式放宽，
  这正好对应本项目的审批 gate。注意：Windows 原生 Codex 在第三方资料里标注为
  Experimental，WSL 被推荐为更稳的路线——所以 v1 的 Codex 闭环必须在用户本机实测，
  不能只凭文档断言通过。
- OpenCode：`opencode run --format json <prompt>`（另有 `--standalone` 与旧版
  `-p/-f json -q` 两种形态，见 config.opencodeMode）。OpenCode 版本迭代快，
  本机实测时以 `opencode run --help` 的实际输出为准选模式，**不要**在报错后自动换
  模式重试（会造成重复模型调用和重复扣费），改配置后由人工在 Notion 里重新 Queued。
- Token：只解析 CLI 自身 JSON 输出里的 usage 字段；解析不到就写 unknown，
  绝不估算、绝不编造。

## 5. Muse（网页版）的定位——先说清楚边界

- Muse 网页版**不能直接控制用户 Windows 电脑**，这一点不假设、不绕过。
  它的参与路径只能是：通过它自己的 Notion 连接读写任务库（创建任务、读结果），
  以及通过 GitHub 读代码仓库、做审核。本地执行永远由 Windows 上的桥接服务发起。
- 本机助手侧已验证：Notion 连接 connected、GitHub 连接 connected（2026-10-25 实测），
  但这只证明助手侧连接通，不等于 Muse 网页版侧的 Notion/GitHub 连接已就绪；
  第五步验证时，Muse 网页版需要在它自己的界面里先确认这两个连接，再发第一个任务。
