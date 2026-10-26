# 本机 Codex 接手清单（Windows，D:\AI-Bridge）

这份清单是给用户本机 Codex 的：云主机助手够不着这台 Windows 电脑，
所以下面每一步都必须在本机真实跑，跑完把证据贴回 Notion 任务行或发回主聊。
**不要用模拟输出冒充真实执行；跑不通就把原始报错原样贴回来。**

## 0. 前置确认（先回答，再动手）

- [ ] D:\AI-Bridge 是否已存在？若不存在，先建目录；若已存在其他内容，先备份再放代码。
- [ ] `codex --version`、`opencode --version`、`node --version`、`git --version` 各输出什么？
- [ ] OpenCode 本机形态：`opencode run --help` 是否支持 `--format json`？
      若不支持，把 config.json 的 opencodeMode 改成实际支持的那档（standalone/print）。
- [ ] GPU 型号：用户本次说 RTX 2080 Ti，记忆里旧机是 RTX 2060——以本机 `nvidia-smi`
      输出为准，记下来即可，**不影响桥接服务能否启动**（服务本身不跑模型）。

## 1. 放代码

- 把 `ai-bridge/` 整个目录复制到 `D:\AI-Bridge\`（或从 GitHub 克隆，见第 5 步）。
- `copy config.example.json config.json`，`copy .env.example .env`。
- config.json：allowedWorkdirs 至少含 `D:\AI-Bridge\test-workdir`；
  确认 protectedPaths 里有 `D:\yangyang_data`，**不要**把足球目录加进白名单。
- .env：填 NOTION_API_KEY、NOTION_DATABASE_ID（只存本机）。

## 2. 诊断 + 干跑（不花模型钱）

```powershell
cd D:\AI-Bridge
.\scripts\doctor.bat
node src\doctor.js --check-notion
.\scripts\test-dryrun.bat
node --test test\*.test.mjs
```

通过标准：doctor 全 PASS；test-dryrun 后 `test-workdir\AI_BRIDGE_DRYRUN_OK.txt`
存在，`data\runs\` 下 result.json 的 outcome=done。

## 3. 真实闭环（花少量模型调用，各做一次）

1. 按 `notion\schema.md` 建库并分享给 Integration。
2. 按 `examples\task-opencode-test.md` 在 Notion 建一行，Status=Queued，
   正文写完整指令，Approval=Approved，WriteMode=write。
3. `.\scripts\run-once.bat`，核对：Notion 行变 Done，
   `test-workdir\hello-from-opencode.txt` 内容正好是一行，
   页面正文末尾有报告块，Tokens 一栏如实填写（unknown 也算如实）。
4. 用 `examples\task-codex-test.md` 对 Codex 重复一次。
5. 把两次的 Notion 行截图/链接、两个 txt 文件内容、两次的 Tokens 栏原样发回。

## 4. 异常演练（各做一次，留记录）

- 取消：在 poll 运行时把一个长任务 Status 改成 Cancelled，确认 15 秒内停下且记 Cancelled。
- 失败：发一个 Workdir 不在白名单的任务，确认记 Failed 且**没有**执行任何文件改动。
- 审批：发一个 WriteMode=write 但 Approval=Pending 的任务，确认转 NeedsApproval 且不执行；
  再把 Approval 改成 Approved、Status 改回 Queued，确认下一轮执行。
- 重启：poll 运行时 Ctrl+C 停掉再启动，确认 ledger 恢复逻辑没有把旧任务悄悄重跑。

## 5. GitHub 独立仓库（用户确认后做）

- 用户先定：仓库名（建议 `ai-bridge`）、公开还是私有。
- 建仓后在本机：`git init`（若从助手侧复制的目录无 .git）、`git add .`、
  先 `git status` 确认 **没有** `.env`、`config.json`、`data/` 被加进去，
  再 commit 并 push。
- 推完把仓库链接发回主聊，助手侧再用 GitHub 连接读回验证。

## 6. 回报格式（发回主聊时按这个写）

```
关键结果：doctor / dry-run / OpenCode 闭环 / Codex 闭环 各通过与否 + 证据链接
未解决问题：哪一步卡住了 + 原始报错
重要风险：本机实测发现的、与验收清单不一致的地方
```
