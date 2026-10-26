# AI Bridge v0.1 — 最小可行桥接服务

目标：最简单、最稳定、最低成本地让 ChatGPT / Muse（网页版）/ 本地 OpenCode / Codex
通过 Notion 交换任务和成果。**不是**一个大系统：没有界面、没有插件市场、
没有多智能体辩论、没有并行 agent 循环。一次只跑一个任务。

```
ChatGPT / Muse（网页版）          Windows 本机                Notion
  创建任务（Status=Queued） ──→  ┌─────────────────┐  拉取 Queued
  读结果（Done/Failed）   ←───  │ ai-bridge 轮询   │ ──→ 回写结果
                                 │  ├─ 白名单校验  │      （状态/摘要/token/错误/改动文件）
                                 │  ├─ 审批 gate   │
                                 │  └─ codex exec / opencode run
                                 └─────────────────┘
  本机只做 outbound 调用（api.notion.com + 本地 CLI），不开放任何监听端口。
```

## 依赖版本（v1 实测基线）

- Node.js >= 20（无任何 npm 依赖：只用 Node 内置 fetch / child_process / fs，
  所以 `npm install` 不是必需的；只有 Phase 2 试 coding-agent-runner 时才需要装包）
- Codex CLI（本机已装，版本以 `codex --version` 为准）
- OpenCode CLI（本机已装，版本以 `opencode --version` 为准）
- 若 CLI 不在 PATH，在本机 `config.json` 设置 `executorPaths` 为可执行文件的绝对路径，例如
  `{"codex":"C:\\Users\\mr\\.codex\\.sandbox-bin\\codex.exe","opencode":"C:\\Users\\mr\\AppData\\Local\\Programs\\@opencodedesktop\\resources\\opencode-cli.exe"}`。
  `doctor` 和实际任务会使用同一路径；不需要复制或重命名 OpenCode 二进制文件。
  这两个消费点都走 `resolveExecutorCommand(config, name)`（`src/config.js`），
  一处解析、两处使用，`doctor` 报的二进制与实际跑的不可能不一致。
- Git（用于执行前后 `git status` 核对改动文件；非 git 目录时如实写“无 diff”）
- GPU 不参与本服务：桥接服务本身不跑模型，模型在 Codex/OpenCode 各自的账号里跑；
  RTX 2080 Ti 与否不影响本服务能否启动。

## Windows 安装与启动（在 D:\AI-Bridge 里操作）

```powershell
# 1. 放代码（本机 Codex 接手时从 GitHub 克隆，或直接复制本目录）
cd D:\AI-Bridge

# 2. 配置（各复制一份模板再改，不要直接改 .example）
copy config.example.json config.json
copy .env.example .env
notepad config.json   # 把 allowedWorkdirs 改成你真实的测试目录，默认 D:\AI-Bridge\test-workdir
notepad .env          # 填 NOTION_API_KEY、NOTION_DATABASE_ID（只存本机，绝不提交）

# 3. 建测试目录和 Notion 库（见 notion\schema.md）
mkdir test-workdir

# 4. 一键诊断（不跑模型、不打印密钥）
.\scripts\doctor.bat
# 需要连 Notion 时：node src\doctor.js --check-notion

# 5. 干跑测试（不跑模型、不连 Notion，证明整条管线通）
.\scripts\test-dryrun.bat
# 通过标志：test-workdir\AI_BRIDGE_DRYRUN_OK.txt 出现，data\runs\ 下的 result.json 有 status=Done（stdout 的 outcome=done）

# 6. 真实闭环（先 OpenCode，再 Codex，各一次）
#    a. 在 Notion 按 examples\task-opencode-test.md 建一行，Status=Queued
#    b. 跑一次：
.\scripts\run-once.bat
#    c. 核对：Notion 该行变 Done，test-workdir\hello-from-opencode.txt 内容正好是一行，
#       页面正文末尾有报告块；再用 examples\task-codex-test.md 重复一次。
#    d. 常驻跑：.\scripts\poll.bat（保持窗口开着；Ctrl+C 停；重启后有恢复逻辑）

# 7. 单元测试（不需要 Notion、不需要模型）
node --test test\*.test.mjs
```

## 关键安全规则（写进代码，不是只写进文档）

1. **工作目录白名单**：Workdir 不在 `config.json` 的 allowedWorkdirs 内，拒绝执行。
   保护目录（protectedPaths，如 `D:\yangyang_data`）即使被误登记也会被挡下。
2. **审批 gate**：WriteMode=write 且 Approval≠Approved 时，任务转 NeedsApproval，**不执行**。
   人工在 Notion 里把 Approval 改成 Approved 并把 Status 改回 Queued，才会在下一轮执行。
   Read-only 任务不需要审批，但 Codex 侧仍用 `--sandbox read-only`。
3. **唯一 ID 与防重跑**：Notion page id + TaskID 为键，本地 `data\ledger.json` 记录每次执行；
   单实例顺序执行（maxConcurrent 恒为 1），不存在“两个 agent 同时改同一文件”的竞态。
4. **超时、取消、重启恢复**：
   - 超时：默认 30 分钟（timeoutMs 可改），超时杀子进程，记 Failed（Timeout）。
   - 取消：Notion 里把 Status 改成 Cancelled，桥接服务 15 秒内杀掉子进程，记 Cancelled。
   - 重启：启动时检查 ledger 里 status=running 的任务；若子进程已死，记 Failed
     （“重启时正在跑，结果未知，请查日志”），**不自动重跑、不编造成功**。
   - 失败重试：同一任务在进程内最多重试 maxRetries 次（默认 1 次，硬上限 3 次），
     每次间隔递增；重试耗尽记 Failed，原始错误原样回写。
5. **Token 与成本**：只解析 CLI 自身 JSON 输出的 usage；解析不到写 unknown，绝不估算。
   没有多 agent 循环：一个任务 = 一个执行者 = 最多 1+maxRetries 次调用。
6. **密钥**：只读本机 `.env` / `config.json`，`.gitignore` 已排除两者和 `data/`；
   日志输出经过 redact（Notion token 形如 `ntn_...` 会被掩码）。
7. **不碰现有系统**：本服务不读、不写足球分析系统、核心算法、生产数据库、
   已有 Agent 配置。测试目录必须是独立目录。

## OpenCode 调用形态（本机实测时确认一次）

`config.json` 里 `opencodeMode` 三档，默认 `run`：
- `run`：`opencode run --format json <prompt>`
- `standalone`：`opencode run --standalone --format json <prompt>`
- `print`：`opencode -p <prompt> -f json -q`（**仅 opencode 1.x**。本机 v2.1.4 上 `-p` / `-q` 都不存在，
  `-f` 在 v2 是 `--file`（附加文件）而不是 format —— 选这一档会得到「把名为 json 的文件附上」+ 未知 flag 的双重报错。
  v2 请用 `run` 或 `standalone`）

**已在 opencode v2.1.4 实测**：`run --format json` 可用；`--dir` 已被移除（工作目录通过 spawn 的 cwd 传递）。

先跑 `opencode run --help` 看本机实际支持的 flag 再定；报错后**不要自动换档重试**
（会重复扣费），改配置后人工重新 Queued。

## 目录结构

```
src\bridge.js      轮询、认领、审批 gate、取消监听、回写、重试、重启恢复
src\notion.js      Notion REST 客户端（内置 fetch，无 SDK 依赖）
src\executors.js   codex exec / opencode run 直调、token 解析、git status 核对
src\config.js      配置、白名单、审批、密钥掩码
src\ledger.js      本地防重跑账本
src\doctor.js      一键诊断
src\runners\coding-agent-runner.mjs   Phase 2 可选适配器（v1 未接入，见 RESEARCH.md）
scripts\*.bat      Windows 一键脚本
notion\schema.md   Notion 建库与发任务方法
examples\*.md      两个真实闭环测试任务模板
docs\acceptance.md 完成/未完成/风险清单
docs\local-handoff-codex.md  本机 Codex 接手清单（本机实测步骤）
```

## 本轮已完成 / 未完成（诚实版，见 docs\acceptance.md）

- 已完成：三候选实查、Notion/GitHub 连接状态核对、v1 完整源码、Windows 脚本、
  Notion schema、单元测试、Linux 侧 dry-run 验证。
- **未完成（必须在本机做，不能在这台云主机上冒充）**：Windows 上 codex/opencode
  真实闭环、Notion 真实回写、Muse 网页版发任务验证。步骤见
  `docs\local-handoff-codex.md`，做完把证据贴回 Notion 任务行即算闭环。
