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

**已知副作用**：每只 CLI 路由的 Bot 会多出一个 `memory:<botId>` 的 CLI 线程记录（存在 bot 状态的 `localAgents.sessions` 里），这是预期行为。
