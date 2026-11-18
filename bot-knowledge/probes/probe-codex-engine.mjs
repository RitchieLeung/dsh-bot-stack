#!/usr/bin/env node
/**
 * 验证 codex 路由补丁：真实 CodexEngine 是否把 per-session LoopbackMcp 通过
 * `-c mcp_servers.dsbot={url=..., bearer_token_env_var="DSBOT_MCP_TOKEN"}` 注入，
 * 并且线程运行时会连上来（tools/list，最好还有 tools/call）。
 *
 * 用法：node probe-codex-engine.mjs
 */
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'

const MOD = `${process.env.HOME}/.dsh/bot/workspace/bot-knowledge/dscord-fork/vendor/ds-bot/src/host/local-agents`
const { CodexEngine } = await import(`${MOD}/codex.js`)
const { ENGINES } = await import(`${MOD}/engines.js`)
const { findExecutable } = await import(`${MOD}/discover.js`)

const SECRET = 'codex-engine-secret'
const LOG = []
const log = (m) => { const line = `[${new Date().toISOString()}] ${m}`; LOG.push(line); console.error(line) }
let listed = false
let called = false
let badAuth = false

const server = createServer((req, res) => {
  if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
  if (req.headers.authorization !== `Bearer ${SECRET}`) {
    badAuth = true
    log(`REJECTED auth=${JSON.stringify(req.headers.authorization)}`)
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'unauthorized' } }))
    return
  }
  let body = ''
  req.setEncoding('utf8')
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    let msg
    try { msg = JSON.parse(body) } catch { res.writeHead(400); res.end(); return }
    const msgs = Array.isArray(msg) ? msg : [msg]
    const calls = msgs.filter((m) => m.method !== undefined)
    if (calls.length === 0) { res.writeHead(202); res.end(); return }
    const tc = calls.find((m) => m.method === 'tools/call')
    if (tc) {
      called = true
      log(`tools/call name=${tc.params?.name}`)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: tc.id, result: { content: [{ type: 'text', text: 'remembered from probe' }], isError: false } })}\n\n`)
      res.end(); return
    }
    const replies = calls.map((m) => {
      if (m.method === 'initialize') { log(`initialize client=${JSON.stringify(m.params?.clientInfo ?? {})}`); return { jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '1' } } } }
      if (m.method === 'tools/list') { listed = true; log('tools/list'); return { jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'remember', description: 'remember something', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] } } }
      if (m.method === 'ping') return { jsonrpc: '2.0', id: m.id, result: {} }
      log(`unhandled ${m.method}`)
      return { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'nf' } }
    }).filter(Boolean)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(Array.isArray(msg) ? replies : replies[0]))
  })
})

await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
log(`probe MCP listening :${port}`)

const spec = ENGINES['codex-cli']
const engine = new CodexEngine('codex-cli', spec, { findExecutable })
let done = false
const finish = async () => {
  if (done) return
  done = true
  await engine.close().catch(() => {})
  try { server.close() } catch {}
  console.error('=== SUMMARY ===')
  for (const l of LOG) console.error(l)
  console.error(`FINAL listed=${listed} called=${called} badAuth=${badAuth}`)
  process.exit(0)
}

try {
  const thread = await engine.open('probe-codex-session', { cwd: tmpdir(), mcp: { url: `http://127.0.0.1:${port}/mcp`, token: SECRET }, resumeId: undefined, mode: 'danger-full-access' })
  log(`engine.open ok threadId=${thread?.threadId}`)
  await engine.prompt(thread, [{ type: 'text', text: 'You have a remember tool. Call it now with text="probe" and tell me the result. Do nothing else.' }], { signal: undefined })
  for (let i = 0; i < 60; i++) { await new Promise((r) => setTimeout(r, 1000)); if (called) break }
  log(`RESULT listed=${listed} called=${called} badAuth=${badAuth}`)
} catch (e) {
  log(`ERROR ${e?.message ?? e}`)
} finally {
  await finish()
}
setTimeout(() => { log('HARD TIMEOUT 90s'); void finish() }, 90000)
