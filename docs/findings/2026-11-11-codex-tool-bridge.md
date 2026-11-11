# 结论：Codex 路由的 Bot 拿不到任何 DS Bot 工具

日期：2026-11-11
状态：**未修复**。两次尝试均失败，根因是 dscord 的进程架构与 Codex 的进程级配置不兼容。

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

## 尝试一（失败）：用 `-c` 调用级覆盖注入

思路本身成立（见下），但落地失败：`adapter.js` 的 `this.engines` 按 **route** 缓存，**所有 `codex-cli` 的 Bot 共用同一个 `codex app-server` 进程**，而 Codex 的 MCP 配置是**进程级**的——一个进程只能挂一份工具服务。要每只 Bot 各有一份，就得一个 Bot 一个进程，这与 dscord 的共享进程设计冲突。

补丁已回退（`patches/backup/dscord-0.4.0-alpha.2-codex.js.orig`），`node patches/dscord-codex-mcp.mjs --check` 现在会报未打。

### 思路记录：`-c` 调用级覆盖确实能注入

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

## 两条可行路径

**A. 换 API 模型（推荐）**：把需要协作/写日记的 Bot 换成 deepseek / kimi。工具走 DSH 原生通道，不经过 MCP，一次配置全部恢复。零补丁。

**B. 让 Codex 引擎按 Bot 分进程**：把 `adapter.js` 的 `this.engines` 缓存键从 `route` 改成 `route + sessionId`，每只 Bot 一个 `codex app-server` 子进程，再配合已验证可行的 `-c` 注入。代价：每个子进程约占 250 MB 内存；属于对 dscord 架构的改动，升级要重放；补丁数量再 +1。

## 现状

| 需求 | 状态 |
|---|---|
| Codex Bot 写记忆 | ✅ 已修复（自动整理改走 API 模型，见 `patches/README.md`） |
| Codex Bot 拿到工具 / 主动协作 | ❌ 未修复（需选 A 或 B） |
| Codex Bot 被其他成员点名协作 | ✅ 本来就可以（消息只是聊天，不依赖工具） |

## 可用的闭环：靠群里点名，不靠工具

`dsh-connect/`（原生路径）里**没有** "文本 `@名字` 转派活"的实现——那是 `src/`（独立节点路径）的能力。前台工具清单也只有 `message_bot` / `post_to_group` 这类工具。所以 Codex Bot 在回复里写 `@鲸鱼` **不会**被转成委派请求。

但可用的路是另一种：**共同群里的点名**。

- 「赛博算法组」（`session-bd524f09-…`）里有全部 6 只 Bot。
- 在群里跟真莹说话，她的回复回到群里。
- 她在回复里写 `@鲸鱼 帮我查 X`，这是**房间里的点名**，会触发鲸鱼的轮次，鲸鱼用它自己的工具去办。

**成立的前提**：

1. 必须在**群聊**里。私聊里她的回复只到你那里，鲸鱼看不到。
2. 鲸鱼的参与方式需是"点名回应"或"自然参与"（`state.json` 的 `attentionModes` 为空时用默认值）。

**仍然缺的**：

- Codex Bot **不能主动发起**：只能在被叫到的那一轮里把 `@鲸鱼` 带出来。
- 它**读不到群聊历史**（没有 `read_group_chat`），只能基于当前轮次上下文判断。
