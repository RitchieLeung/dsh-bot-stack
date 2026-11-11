# 结论：Codex 路由的 Bot 拿不到任何 DS Bot 工具

日期：2026-11-11
状态：**不修**（上游集成缺陷，本地修复成本远超收益）

## 现象

真莹（`codex-cli/gpt-6.1-terra`）自述并实测确认：**没有 `remember`、`recall`、`forget`、`contacts`** 等任何 DS Bot 工具。她只能用 Codex 自带的文件读写能力。

影响范围不止记忆：`dispatch_work`、`message_bot`、`read_group_chat` 等协作工具同样没有。也就是说 Codex 路由的 Bot 实际上是"只能聊天 + 读写文件"。

## 证据链

1. **dscord 侧配置是有的**。`vendor/ds-bot/src/host/local-agents/codex.js` 的 `open()` 把工具服务器塞进线程配置：

   ```js
   ...(mcp !== undefined ? { mcp_servers: { dsbot: { url: mcp.url, http_headers: {...} } } } : {}),
   ```

   `thread/start` 和 `thread/resume` 都带上了这份 `config`。

2. **工具确实被筛选出来了**。适配器 `toolsFor(options)` 从 `options.tools` 里按 `rt.teamTools` 的名字过滤，`remember`/`recall`/`contacts` 都在 `rt.teamTools` 里（`memory/native.mjs` push，`vendor/ds-bot/src/host/tools.js` 也 push 了一批）。

3. **但 Codex 的线程记录里没有它**。真莹的 rollout 文件
   `~/.codex/sessions/2026/11/10/rollout-2026-11-10T14-20-42-01a1c41d-b1e9-7be2-b9f0-cf45f0583b18.jsonl`（6.6 MB）里：

   - `"dsbot"` 出现 **0 次**
   - Codex 自己的 MCP 工具（`mcp__codex_apps__*`）正常出现

4. **Codex 只从全局配置读 MCP**。`~/.codex/config.toml` 里有 `[mcp_servers.node_repl]`、`[mcp_servers.dingtalk_docs]`、`[mcp_servers.missiongo]` 三个静态服务，没有 `dsbot`。

5. Codex 版本：`codex-cli 0.163.0`。

## 根因

dscord 假设 Codex app-server 接受**按线程**的 `mcp_servers` 配置。Codex 0.163.0 的 `thread/start` / `thread/resume` config 只支持有限字段（cwd、model、sandbox_mode、approval_policy、developer_instructions 等），未知字段被**静默忽略**；MCP 服务器只从全局 `~/.codex/config.toml` 读取。

结果：Codex 线程从创建起就没有 `dsbot` 这个 MCP 服务器，CLI 侧永远不会出现这些工具。

## 为什么本地修不了

`dsbot` 的 MCP 端点是**动态的**：`LoopbackMcp` 每次进程启动监听随机端口并生成随机 token。把它写进静态的 `~/.codex/config.toml` 需要一个稳定端点，否则每次重启都得改全局配置。

可行但代价高的路子：自己跑一个固定端口 + 固定 token 的 MCP 服务，预先写进 `config.toml`，再让 dscord 复用它。这要同时改 dscord 和全局 Codex 配置，且 Codex 升级、多实例并发都可能踩坑。

## 对比：API 模型路由是正常的

同一份 rollout 里记录了 小欣、伟峰的对话：他们**成功用 `experience` 写入组内共享日记，并通过 `recall` 回读成功**。这两只是 API 路由（kimi / deepseek），工具走 DSH 原生通道，不经过 MCP。

## 建议

| 需求 | 做法 |
|---|---|
| 要 Bot 能主动记/查记忆、能派活 | 用 API 模型路由（deepseek / kimi） |
| 就是想用 Codex 写代码 | 接受它只能聊天 + 读写文件；记忆依赖自动整理（已于同日修复，见 `patches/README.md`） |
| 需要 Codex Bot 写日记 | 做不到（`remember` 不可用）；只能换模型 |
