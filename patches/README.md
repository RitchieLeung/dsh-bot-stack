# 已退休：运行时补丁

> **这些脚本已不再需要。** 2026-11-11 起 profile 使用自建 fork（`../dscord-fork/`），改动直接写在源码里。
>
> 保留本目录是为了：记录每个问题的根因、保留可复现的补丁逻辑、以及万一回滚到官方 tgz 时还能重放。
>
> 当前 dscord = fork：`dscord-fork/FORK.md` 是权威改动清单。

# 对 dscord 的补丁

本目录存放**必须手工重放**的第三方补丁。dscord 是从 tgz 安装的 npm 包，`pnpm install`、升级或重装都会覆盖这些改动。

## dscord-memory-session.mjs

**问题**：codex-cli / claude-code / ACP 这类本地 agent 路由的 Bot 写不了记忆。实测 `review-validation-error` 991 次 vs `review-proposal` 59 次（94% 失败），真莹 0 条记忆。

这里其实是**两个独立缺陷**，第一个修完才暴露第二个。

**根因**（代码级）：dscord 的记忆审查调用复用了 Bot 自己的聊天 sessionId：

```js
sessionId: tag.sessionId || rt.chatOf(bot.id), purpose: 'memory', system: REVIEW
```

而 ds-bot 的本地 agent 适配器按 DSH sessionId 维护持久 CLI 线程，且只在**全新线程**时注入系统指令：

```js
instructions: live.spec.kind === 'codex' && freshCli ? instructions : undefined
```

Bot 的聊天线程必然已存在 → `freshCli` 为 false → "只输出 JSON"的指令被丢弃 → 审查请求变成既对话里的一条普通消息 → agent 回"收到…"→ JSON 解析失败 → 记忆永远不产出，同时把审查载荷灌进 Bot 的真实对话线程。

### 缺陷一：审查复用了 Bot 的聊天会话

**修法**：记忆调用改用专用 session id `memory:<botId>`，让它拥有独立的 CLI 线程，不再污染 Bot 的聊天线程。token 记账仍记在 Bot 的聊天 session 上。

**效果**：`memory:` 会话确实建出来了，污染止住；但审查**仍然失败**——错误从"收到，索引仍与上一条相同"变成"我先确认一下收到的内容…"，说明 Codex 即使在全新线程、拿到"只输出 JSON"的指令，仍然以 agent 的方式自然语言作答。

### 缺陷二：CLI agent 不适合当严格 JSON 生成器

对照证据：**同一个审查 prompt**，deepseek 模型（鲸鱼）产出 54 条记忆、59 次成功提案；codex-cli 模型 0 成功。这是 Codex app-server 的行为，会话隔离解决不了。

**修法**：记忆审查是机械抽取任务，对本地 agent 路由改用一个配置的 API 模型执行，不影响 Bot 自己回答用户所用的模型。

```js
const CLI_MODEL_ROUTES = ['codex-cli', 'claude-code', 'opencode', ...];
const reviewModelReference = async (bot, signal) => {
  const own = await modelReference(bot, signal);
  const route = own.slice(0, own.indexOf('/'));
  if (!CLI_MODEL_ROUTES.includes(route)) return own;
  return config.memoryReviewModel || process.env.DSCORD_MEMORY_REVIEW_MODEL || 'deepseek-official/deepseek-flash';
};
```

覆盖方式：设置 `DSCORD_MEMORY_REVIEW_MODEL=provider/model` 环境变量，或在 dscord 配置里给 `memoryReviewModel`。

```js
const memorySessionId = bot => `memory:${bot.id}`;
// ...
sessionId: tag.sessionId || memorySessionId(bot), purpose: 'memory', ...
```

**应用 / 校验**：

```bash
node patches/dscord-memory-session.mjs           # 应用（幂等，可分段补齐）
node patches/dscord-memory-session.mjs --check   # 校验，缺任一改动则 exit 1
```

默认作用于 `~/.dsh/profiles/web/node_modules/dscord`，可传路径覆盖。

**回滚**：`patches/backup/dscord-0.4.0-alpha.2-native.mjs.orig` 是打补丁前的原文，直接拷回去即可。

**重放时机**：dscord 升级 / 重装 / `pnpm install` 之后。`--check` 应该进安装后检查清单。

---

## dscord-codex-mcp.mjs — 未采用，已回退

> 保留脚本作为记录与将来基础。**当前不要应用**：它注入的进程级 `-c` 会被**所有** `codex-cli` Bot 共享，这是错的。
>
> 原因：`vendor/ds-bot/src/host/local-agents/adapter.js` 的 `this.engines` 按 route 缓存，所有同 route 的 Bot 共用一个 `codex app-server` 进程；而 Codex 的 MCP 配置是进程级的。要每 Bot 一份，必须先让引擎按 Bot 分进程。

**问题**：Codex 路由（`codex-cli/*`）的 Bot 拿不到**任何** DS Bot 工具——不只是记忆，连 `message_bot`、`dispatch_work` 都没有，所以它们永远无法主动找其他成员协作。

**根因**：dscord 把工具服务器放在 `thread/start` 的 `mcp_servers` 参数里，而 Codex 0.163.0 只从**调用级配置**读 MCP 服务器，线程参数里的 `mcp_servers` 被静默忽略；Codex 也**不支持项目级配置**。于是那个 MCP 服务器从未被加载。

**证据**：真莹的 Codex 线程 rollout 里 `"dsbot"` 出现 0 次，而 `mcp__codex_apps__*` 正常；`codex doctor` 只报告一份全局 `config.toml`；实测 `-c 'mcp_servers.x={url=...}'` 能注入成功。

**修法**：Codex 的 app-server 接受 `-c key=value` 覆盖，而 ds-bot 每个 live session 起一个 app-server 子进程，所以在 spawn 时把该会话自己的 MCP url/token 作为 `-c` 传入。

```js
const processMcpArgs = mcp => (mcp?.url && mcp?.token
  ? ['-c', `mcp_servers.dsbot={url="${mcp.url}", http_headers={Authorization="Bearer ${mcp.token}"}}`]
  : []);
```

不动全局 `~/.codex/config.toml`；每个子进程只拿到自己 Bot 的工具服务。

**应用 / 校验**：

```bash
node patches/dscord-codex-mcp.mjs           # 应用（幂等）
node patches/dscord-codex-mcp.mjs --check   # 校验
```

**已知副作用**：每只 CLI 路由的 Bot 会多出一个 `memory:<botId>` 的 CLI 线程记录（存在 bot 状态的 `localAgents.sessions` 里），这是预期行为。
