# RUNBOOK · 执行器版本与升级

本文件只记两件事：**本机现在实测的是哪个版本**，以及**换版本时按什么顺序做**。
含糊的「最新版」不算数：opencode 从 1.19.4 到 2.1.4 已经悄悄删过 `--dir`，
升级后直接接真实任务，失败会以「模型不听话」的样子出现，很难查回版本。

## 1. 实测基线（2026-10-26，Windows 本机）

| 组件 | 实测版本 | 路径 | 怎么测的 |
|---|---|---|---|
| opencode | `opencode v2.1.4` | `C:\Users\mr\AppData\Local\Programs\@opencodedesktop\resources\opencode-cli.exe` | `opencode-cli.exe --version` |
| codex | `codex-cli 0.164.0-alpha.11.1` | `C:\Users\mr\.codex\.sandbox-bin\codex.exe` | `codex.exe --version` |
| node | `v24.14.0` | `D:\Program Files\nodejs\node.exe` | `node --version` |
| git | `2.53.0.windows.2` | `D:\Program Files\Git\cmd\git.exe` | `git --version` |

`node src/doctor.js` 会把上面两行原样打印出来，并在方括号里带上**实际探测的二进制路径**
（`[C:\...\opencode-cli.exe]`）：PATH 与 `executorPaths` 可能指向不同安装，
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

   **4a. OpenCode 功能烟测**（一次真实调用）：在 `D:\AI-Bridge\test-workdir` 下跑一个 opencode 任务，
   确认桥接调用能正常执行、`outcome=done`、Tokens 可解析。
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
而且第二次失败的原因会被第一次的噪音盖住。改配置后由人重新 `Queued`。

## 4. 回退

`opencodeMode` 有 `run|standalone|print` 三档，换档属于配置改动，不属升级：
先跑 doctor，再按第 3 节第 4 步做只读烟测。v2 上 `print` 已知不可用，不要拿它当回退档。

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

