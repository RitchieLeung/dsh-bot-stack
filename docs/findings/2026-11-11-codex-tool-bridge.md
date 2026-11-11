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

## 实测终结：项目级 `.codex/config.toml` 不被读取

有人（Gemini）主张 Codex 支持项目级 MCP 配置（`<项目>/.codex/config.toml`，与全局 deep merge）。在**这台机器的真实运行路径**上做了三次递进验证，结论是不支持：

| 实验 | 条件 | 结果 |
|---|---|---|
| CLI 视角 | 含 `.codex/config.toml` 的 git 仓库内 `codex mcp list` | 看不到服务器（0），0.163.0 与 0.167.1 均如此 |
| 带信任覆盖 | 追加 `-c 'projects.<path>.trust_level="trusted"'` | 仍为 0 |
| **app-server 真实路径** | 探针 MCP 服务（独立会话，固定端口，转储所有请求）+ 写入真莹工作目录的 `.codex/config.toml` + 重启 dsh + 真莹实际跑一轮 | 探针日志**无 `initialize`**；线程 rollout 里也没有该 MCP 条目（仅有的 `probe` 命中是 Codex 插件描述里的英文单词） |

辅助证据：`codex doctor` 在项目目录内也只报告 `~/.codex/config.toml` 一份；`codex features list` 175 个 flag 中没有项目级配置开关。

测完已清理：探针进程停止，`zhenying/.codex/config.toml` 删除，`/tmp` 探针文件删除。探针脚本保留在 `probes/probe-mcp.mjs` 以便复现。

**所以 Codex 的配置注入只有 `-c` 调用级覆盖一条路，而它是进程级的——被 dscord"同 route 共享一个 Codex 进程"的设计挡住。**

## 决定性复测（2026-11-11 13:10，推翻两处旧结论）

用两个独立探针（`probes/probe-codex-c-inject.mjs`、`probes/probe-codex-bearer.mjs`）在真实 `codex app-server --listen stdio://` 上验证，结论如下：

### 1. `-c` 注入在运行时生效（不再只是 `mcp list` 能解析）

探针服务器（记录所有请求）收到：

```
initialize client={"name":"codex-mcp-client","title":"Codex","version":"0.163.0"}
tools/list
```

这是 `codex app-server` 子进程在 `spawn` 时带上 `-c 'mcp_servers.probe={url="http://127.0.0.1:PORT/mcp"}'` 后，**真的把该 MCP 服务器挂进了线程并查询了工具清单**。与 `thread/start` 里塞 `mcp_servers`（被静默忽略、rollout 里 0 次 "dsbot"）形成鲜明对比。

### 2. bearer 鉴权可行（`badAuth=false`）

带 `Authorization: Bearer <token>` 校验的探针服务器，用官方字段注入：

```
-c 'mcp_servers.probe={url="...", bearer_token_env_var="PROBE_TOKEN"}'
env PROBE_TOKEN=<token>
```

收到 `tools/list (authorized)`，`badAuth=false`。所以 dscord 的 per-session 随机 token 可以通过 `bearer_token_env_var` 传进去，不必动全局 `config.toml`。

### 3. 内存代价被高估了约 5 倍

| 进程 | RSS |
|---|---|
| dscord 实际跑着的 codex app-server（0.163.0，空闲） | 22–50 MB（随 GC 波动） |
| ChatGPT.app 的托管 app-server daemon（0.167.1，7 小时持续使用） | ~60 MB |
| `codex resume` 交互进程 | 22–33 MB |

"每进程约 250 MB" 是错误估计。真实量级是 **空闲 20–50 MB、活跃约 60 MB**。真莹 + 鹤鸣两只 Bot 分进程，合计约 60–120 MB，在这台机器上可忽略。

### 4. 版本已变，机制稳定

`~/.local/bin/codex` 是指向 `~/.codex/packages/standalone/current/bin/codex` 的软链，ChatGPT.app 在 13:08 自动把它从 0.163.0 升到 0.167.1。两次探针分别在 0.163.0 / 0.167.1 上通过，`-c` + `bearer_token_env_var` 机制两版都成立。

## 修订后结论

路径 B（按 Bot 分进程 + `-c` 注入）**不是"250 MB/进程的昂贵改动"，而是"~30–60 MB/进程的轻量改动"**，且机制已被端到端证实。它与 `claude.js` 已经采用的"每会话一个进程"是同一套模式，只是 Codex 引擎目前按 route 共享进程才挡在这。

修订后的两条路径成本对比：

| 路径 | 改动量 | 内存代价 | 保留 codex 模型 |
|---|---|---|---|
| A. 换 API/agy 路由 | 零补丁 | 零 | 否（换模型/身份） |
| B. Codex 按会话分进程 + `-c` 注入 | 改 `adapter.js` 缓存键 + `codex.js` spawn 参数（局部、镜像 claude.js） | ~30–60 MB/Bot | 是 |

## 已实施修复（2026-11-11 13:52，路径 B）

按「每会话一个 codex app-server + spawn 时 `-c` 注入」落地，三处改动：

1. **`adapter.js`**：`engine(route, sessionId)` 的缓存键对 codex 改成 `route + \0 + sessionId`（`liveFor` 传入 `sessionId`）；ACP/Claude 仍按 route 一个引擎。
2. **`codex.js`**：`ensure(mcp)` 在 spawn 时追加
   `-c 'mcp_servers.dsbot={url="<loopback>", bearer_token_env_var="DSBOT_MCP_TOKEN"}'`，
   token 经 `DSBOT_MCP_TOKEN` 环境变量传入；`open()` 改为 `ensure(mcp)`；删除 `thread/start` 里被 Codex 忽略的 `mcp_servers` 死配置。
3. **`codex.js`**：`onRequest` 处理 `mcpServer/elicitation/request`（返回 `decline`），避免 Codex 的 MCP elicitation 请求被 -32601 拒绝刷错误。

**验证**（`probes/probe-codex-engine.mjs`，用真实 `CodexEngine` + 带鉴权的探针 MCP）：

```
initialize client={"name":"codex-mcp-client","version":"0.167.1"}
tools/list           ← codex 连上并拉取工具，badAuth=false
```

即桥通了、token 鉴权正确。`tools/call` 在裸 app-server 探针里没触发（裸环境的模型未完整加载），真正端到端要靠重启后真莹/鹤鸣跑一轮确认。

**遗留成本**：codex 每会话一个进程（实测空闲 ~30–60 MB）；另有 1 个 route 级探针进程用于 `model/list`。
