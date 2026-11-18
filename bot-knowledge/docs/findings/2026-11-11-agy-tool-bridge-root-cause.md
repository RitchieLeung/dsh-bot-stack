# 根因：LoopbackMcp 二次包裹导致 tools/list 一律 500，本地 Agent 拿不到任何团队工具

日期：2026-11-11
状态：**已修复，待重启验证**。

## 一句话根因

`vendor/ds-bot/src/host/local-agents/adapter.js` 的 `ensureMcp` 把 `tools` 多包了一层：

```js
// 错误：tools 本身已是 () => this.deps.toolsFor(options)，又被包成 ()=>tools
const mcp = new LoopbackMcp(() => tools, ...)

// 正确：
const mcp = new LoopbackMcp(tools, ...)
```

`LoopbackMcp.answer('tools/list')` 里执行 `this.tools().map(...)`。二次包裹后 `this.tools()` 返回的是**函数**而不是数组，`.map` 直接抛 `TypeError`，`tools/list` 返回 **HTTP 500 空响应**。结果：任何本地 Agent（agy / codex / claude）连上 LoopbackMcp 后都拉不到工具清单，自然没有 `remember`/`contacts` 等团队工具。

## 证据

用真实 `LoopbackMcp` 复现（`probes/probe-loopback-tools.mjs`）：

| 构造方式 | `tools/list` 结果 |
|---|---|
| `new LoopbackMcp(() => tools, ...)`（修复前） | **HTTP 500，空 body** |
| `new LoopbackMcp(tools, ...)`（修复后） | HTTP 200，`tools` 数组正常返回 |

## 为什么之前一直没定位到

之前把精力全放在「agy 支不支持 MCP」「codex 认不认 mcp_servers」上，而这两层都是**通的**（都做了探针实测）：

1. **agy 的 ACP MCP 完全正常** —— 5 个探针全部通过：
   - `session/new` + mcpServers → 连上 + tools/list + tools/call（`agy-mcp-probe-2026-11-11.log`）
   - `session/load` + mcpServers → 连上（`probe-agy-load.mjs`）
   - bearer 鉴权头 → 正确发送（`probe-agy-auth.mjs`，badAuth=false）
   - 同名换端口 → 会重连（`probe-agy-name-reuse.mjs`）
2. **dscord 侧代码看着也正确**：`acp.js` 的 caps gate 不拦 agy（`mcpCapabilities` 缺失 → `mcpDeclared=false`），`session/new`/`session/load` 都带 `mcpServers`。

真正的问题出在**桥这头**：LoopbackMcp 自己把 `tools/list` 答挂了。所以 agy 连上了、鉴权过了、工具服务器也在了，但一问「你有哪些工具」就得到 500，于是 kiki 报「只有 google-flow 和钉钉文档（agy 自己的全局 MCP），没有 contacts」。

## 影响面与修复

| 引擎 | 修复后 |
|---|---|
| agy（kiki） | ✅ 工具恢复（LoopbackMcp 修好后即可） |
| claude | ✅ 工具恢复（同样走 LoopbackMcp） |
| codex（真莹/鹤鸣） | ❌ **仍不行** —— codex 还有第二个独立 bug：`thread/start` 的 `mcp_servers` 被静默忽略（见 `2026-11-11-codex-tool-bridge.md`），得用「按会话分进程 + `-c` 注入」那条路 |

## 附带：agy 把会话 MCP 缓存到磁盘

调查中还发现 agy 会把每个 MCP 服务器的工具清单缓存到 `~/.gemini/antigravity-cli/mcp/<name>/`（每个工具一个 .json）。经实测（`probe-agy-name-reuse.mjs`）**同名换端口会重连**，缓存不构成障碍；但它印证了「dsbot 从未被 dscord 成功接通过」——那个 `dsbot/` 目录里只有我探针留下的 `probe_hello.json`，没有 `remember.json`/`contacts.json`。

## 验证步骤

1. 重启 `dsh web`（已带修复 + 临时 debug 日志，写到 `/tmp/dscord-acp-debug.log`）。
2. 让 kiki 再跑一轮（问「用 contacts 查鲸鱼」）。
3. 看 `/tmp/dscord-acp-debug.log`：应有 `mcpServers.length=1`、`bridgeTools=N(N>0)`，且 kiki 能报出 `session-a05e2e6a-…`。
4. 验证通过后移除 `acp.js` / `adapter.js` 里的 TEMP DEBUG 日志，重新同步。
