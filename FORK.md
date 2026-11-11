# dscord fork（自用）

从官方发行包 `dscord-0.4.0-alpha.2.tgz` 解包而来，直接改源码，而不是在运行时打补丁。

- 上游：https://github.com/MixGeekers/dscord （tag `ds-group-v0.4.0-alpha.2`）
- 原始包 SHA-256：`a01e39bcf9c82ba4ea76e98cece6a455efd196b41662fdb74eddfd5ce0da7c23`
- 许可证：Apache-2.0，`LICENSE` / `NOTICE` 原样保留

## 改了什么

### 1. 记忆审查：独立会话 + 改用 API 模型 — `memory/native.mjs`

**为什么**：记忆审查原本复用 Bot 自己的聊天 sessionId。对 CLI agent 路由（codex/claude/ACP）来说，ds-bot 按 sessionId 维护持久 CLI 线程，而"只输出 JSON"的系统指令**只在全新线程时注入**。Bot 的聊天线程必然已存在，指令被丢弃，审查变成往真实对话里插一句，模型回"收到…"，JSON 解析必然失败 —— 这些 Bot 永远产不出记忆（实测 991 次失败 / 59 次成功，真莹 0 条记忆）。

**改成**：
- `const memorySessionId = bot => `memory:${bot.id}`` —— 记忆管线用自己的会话，拥有独立线程且不再污染 Bot 的对话。
- `reviewModelReference()` —— 对本地 agent 路由，审查改用 API 模型（默认 `deepseek-official/deepseek-flash`，可用 `config.memoryReviewModel` 或 `DSCORD_MEMORY_REVIEW_MODEL` 覆盖）。因为即使拿到指令，CLI agent 仍然以自然语言作答，不吐 JSON。

### 2. Antigravity 作为一等引擎 — `vendor/ds-bot/src/host/local-agents/engines.js`

新增 `agy-cli`（`agy acp`）。Google Antigravity CLI 提供 ACP stdio server，握手实测通过（`Antigravity ACP Server` v1.5.5，protocolVersion 1）。

### 3. ACP 能力门槛放宽 — `vendor/ds-bot/src/host/local-agents/acp.js`

原逻辑：agent 不**声明** `mcpCapabilities.http === true` 就拒绝开会话。
Antigravity 的 `mcpCapabilities` 是 null（不声明），但 `session/new` 实际接受 HTTP MCP 参数。改成**只有明确声明 `http === false` 才拒绝**。

副作用：真正不支持 MCP 的 ACP agent 会静默拿不到工具，但 Bot 仍能正常对话——这比直接拒绝开会话更可用。

### 4. 审查模型判定改为通用 — `memory/native.mjs`

原先用手写路由表判断"是不是本地 agent 路由"，新增 `agy-cli` 后漏掉了，导致 agy 的记忆审查仍走 agy 自己的模型 → `MEMORY_MODEL_EMPTY`。改成调用引擎注册表的 `isLocalAgentRoute()`，以后新增路由（含自定义 `acp-*`）自动覆盖。

### 5. 空错误码容错 — `vendor/ds-bot/src/host/local-agents/adapter.js`

ACP agent 可能回报空字符串错误码，`??` 会把空串保留下来，`LlmError` 于是拒绝："code must be a non-empty string"。改成空串当作没有 code。

## 不是改在这里的问题

Codex 路由的 Bot 拿不到 DS 工具（`message_bot`/`remember` 等）是**上游设计冲突**：Codex 的 MCP 配置是进程级，而 ds-bot 让同 route 的所有 Bot 共用一个 `codex app-server` 进程。修它要让引擎按 Bot 分进程，本 fork 暂未改。详见 `bot-knowledge/docs/findings/2026-11-11-codex-tool-bridge.md`。

## 改代码后怎么生效

profile 用的是 `file:` 目录依赖，pnpm 装的是**快照不是软链**（试过软链：fork 目录没有 node_modules，`deep-view` 等依赖解析失败，整个 DSCord 插件加载不了）。所以：

```bash
cd dscord-fork
./sync.sh          # 同步到 profile 的 node_modules/dscord
# 然后重启 dsh web
```

`./sync.sh --check` 可以看到两边的差异。

## 升级上游

1. 下载新 tgz，解包到临时目录
2. 用本文件的三条改动作为清单，在新版本里重新应用（改动都很小，锚点清楚）
3. 替换 `dscord-fork/` 内容，更新本文件的 SHA
4. 重启 `dsh web`，验证：面板能开、Bot 正常回话、codex Bot 仍能产记忆、agy 路由可用

## 回滚

profile 的依赖改回原 tgz 后 `pnpm install`：

```
"dscord": "file:/Users/ritchie_leung/Documents/deepseek-harness/default-workspace/dscord-install/dscord-0.4.0-alpha.2.tgz"
```
