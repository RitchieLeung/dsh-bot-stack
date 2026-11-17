#!/usr/bin/env node
/**
 * 回归探针：LoopbackMcp 的 tools/list 必须返回 200 与工具数组。
 * 复现并锁定根因「二次包裹」：adapter.js 曾写 `new LoopbackMcp(() => tools, ...)`，
 * 导致 `this.tools()` 返回函数而非数组，`.map` 抛错 → tools/list 返回 500。
 *
 * 用法：node probe-loopback-tools.mjs
 * 期望：打印 HTTP 200 与 tools 数组；若回归会打印 500。
 */
const { LoopbackMcp } = await import(`${process.env.HOME}/.dsh/bot/workspace/bot-knowledge/dscord-fork/vendor/ds-bot/src/host/local-agents/mcp.js`)

// 与 adapter.js 的调用约定一致：tools 是「返回工具数组」的函数，单层传入。
const tools = () => [{ name: 'remember', description: 'write a memory', parameters: { type: 'object', properties: {} } }]
const mcp = new LoopbackMcp(tools, async () => ({ text: 'ok' }))
await mcp.listen()

const res = await fetch(mcp.url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${mcp.token}` },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
})
const body = await res.text()
console.log(`HTTP ${res.status}: ${body}`)
mcp.close()
if (res.status !== 200) process.exit(1)
