# 结论：Codex 路由的 Bot 拿不到任何 DS Bot 工具

日期：2026-11-11
状态：**已修复**（`patches/dscord-codex-mcp.mjs`），待重启验证

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

## 修复：用 `-c` 调用级覆盖注入

一开始以为只能改全局 `config.toml`，但 `dsbot` 的端点是**动态的**（随机端口 + 每会话随机 token），写进静态全局配置不可行。后来找到 Codex 的第三条配置通道：

- **项目级配置不支持**。`<cwd>/.codex/config.toml` 不会被读取：`codex doctor` 只报告一份 `~/.codex/config.toml`，实测在带 `.codex/config.toml` 的目录里 `codex mcp list` 也看不到项目里的服务器。
- **调用级覆盖支持**。`codex -c 'key=value'` 会覆盖配置，且 `codex app-server` 同样接受 `-c`：

  ```bash
  codex -c 'mcp_servers.probe_x={url="http://127.0.0.1:9/mcp"}' mcp list
  # → probe_x  http://127.0.0.1:9/mcp  enabled  Unknown
  ```

而且 ds-bot 是**每个 live session 起一个 `codex app-server --listen stdio://` 子进程**，所以完全可以在 spawn 时把该会话自己的 MCP url/token 作为 `-c` 覆盖传进去：

```js
const processMcpArgs = mcp => (mcp?.url && mcp?.token
  ? ['-c', `mcp_servers.dsbot={url="${mcp.url}", http_headers={Authorization="Bearer ${mcp.token}"}}`]
  : []);
```

好处：不动全局配置、不污染用户自己的 Codex；每个子进程只拿到自己那个 bot 的工具服务，不会跨 bot 泄漏。

## 对比：API 模型路由是正常的

同一份 rollout 里记录了 小欣、伟峰的对话：他们**成功用 `experience` 写入组内共享日记，并通过 `recall` 回读成功**。这两只是 API 路由（kimi / deepseek），工具走 DSH 原生通道，不经过 MCP。

## 现状

| 需求 | 状态 |
|---|---|
| Codex Bot 拿到 remember/recall/contacts/message_bot/dispatch_work | 已打补丁，待重启验证 |
| Codex Bot 写记忆 | 已修复（自动整理，走 API 模型） |
| 需要重放补丁的时机 | dscord 升级或重装后，见 `patches/README.md` |
