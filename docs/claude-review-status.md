# Notion Claude 评审状态（2026-10-25 23:20 左右，实测记录）

## 已做

- 在 Notion 工作区找到 Custom Agent：Claude
  （agent://0192911f-599d-8131-92f3-00038d7b26f7/4032911f-599d-80a5-ad8d-0092112cf15d）
- 写了评审简报：docs/claude-review-brief.md（硬约束 8 条 + 重点审查 8 项 + 交付格式）
- 在 Notion 建了草稿评审页（private）：
  标题：AI Bridge v0.1 代码评审任务（给 Notion Claude）
  页面 id：4042911f-599d-81ed-8a1a-e46cdc61a782
  链接：https://app.notion.com/p/4042911f599d81ed8a1ae46cdc61a782?pvs=204

## 未做成（不是代码问题，是连接权限问题）

- 直接发起 Claude 会话（notion-spawn-session）失败，返回 403 restricted_resource：
  “This Notion MCP connection isn't approved to chat with Custom Agents.
  Reconnect Notion MCP where it was first added, such as your AI app's connector
  settings or your MCP gateway's Notion connector. Then approve
  'Chat with Custom Agents' on Notion's consent screen.
  Reconnecting only your MCP client to a gateway keeps the old approval.”
  request_id：a86313ab-7dc7-4d06-9e85-26c42b3a6b93
- 也就是说：助手侧的 Notion 连接没有“与 Custom Agent 对话”这一项授权，
  工具表里虽然列出了 spawn-session，但准入表里没有它，实测也证实被挡。
- 因此：**Claude 尚未真正审过代码，本文件不伪装成评审已完成。**

## 解锁办法（二选一）

A. 用户在 Muse / MCP 网关当初添加 Notion 的地方重新连接 Notion，
   在 Notion 同意屏上勾选 “Chat with Custom Agents”，然后告诉助手重试。
   重试用的初始消息已备好（简报 + 核心源码，共 36610 字），不用重写。
B. 用户自己在 Notion App 里打开上面那张草稿页，在页内调用 Claude，
   把它的回复留在 Notion 里，然后回主聊说一声，助手再去取回、人工审后落地。

## 与 GitHub 推送的关系

- 公开仓库 ai-bridge 的推送**暂停、未取消**：等 Claude 评审落地后再推改进后版本，
  避免先推旧版、再推一版改动，造成两版混乱。
- 若用户想先推 v0.1 基线占位、评审后再以更新推送，说一声即可，助手马上推。
