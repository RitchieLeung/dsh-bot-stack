#!/usr/bin/env node
/**
 * 决定性实验 #2：codex 的 `-c mcp_servers.X={url=..., bearer_token_env_var=...}`
 * 注入后，是否真的带上 bearer 头访问 HTTP MCP（dscord LoopbackMcp 需要
 * `Authorization: Bearer <token>`）。信号：带鉴权的探针服务器若收到 tools/list，
 * 说明 codex 正确发送了 bearer token。
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'

const SECRET = 'test-secret-token-123'
const LOG = []
const log = (m) => { const line = `[${new Date().toISOString()}] ${m}`; LOG.push(line); console.error(line) }

let toolsListed = false
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
    const replies = calls.map((m) => {
      if (m.method === 'initialize') { log(`initialize client=${JSON.stringify(m.params?.clientInfo ?? {})}`); return { jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '1' } } } }
      if (m.method === 'tools/list') { toolsListed = true; log('tools/list (authorized)'); return { jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'probe_hello', description: 'probe', inputSchema: { type: 'object', properties: {} } }] } } }
      if (m.method === 'ping') return { jsonrpc: '2.0', id: m.id, result: {} }
      if (m.method === 'tools/call') { log(`tools/call name=${m.params?.name}`); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'ok' }], isError: false } })}\n\n`); res.end(); return null }
      log(`unhandled ${m.method}`)
      return { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'nf' } }
    }).filter(Boolean)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(Array.isArray(msg) ? replies : replies[0]))
  })
})

await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
log(`probe (auth) listening :${port}`)

const child = spawn(`${process.env.HOME}/.local/bin/codex`,
  ['app-server', '--listen', 'stdio://', '-c', `mcp_servers.probe={url="http://127.0.0.1:${port}/mcp", bearer_token_env_var="PROBE_TOKEN"}`],
  { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, PROBE_TOKEN: SECRET } })

let rest = ''
child.stdout.setEncoding('utf8')
child.stdout.on('data', (c) => {
  rest += c
  let i
  while ((i = rest.indexOf('\n')) !== -1) { const line = rest.slice(0, i).trim(); rest = rest.slice(i + 1); if (line) onLine(line) }
})
child.on('exit', (code) => { log(`codex app-server EXITED ${code}`); finish() })

let reqId = 0
const pending = new Map()
const send = (o) => { try { child.stdin.write(JSON.stringify(o) + '\n') } catch {} }
function onLine(line) {
  let m; try { m = JSON.parse(line) } catch { return }
  if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
}
function request(method, params, t = 60000) {
  return new Promise((res, rej) => { const id = ++reqId; pending.set(id, res); send({ jsonrpc: '2.0', id, method, params }); setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(`timeout ${method}`)) } }, t) })
}

async function main() {
  try {
    await request('initialize', { clientInfo: { name: 'ds-bot', title: null, version: '1' } })
    send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
    await request('thread/start', { cwd: process.cwd(), input: [{ type: 'text', text: 'List your available tools.' }] }, 120000)
    for (let i = 0; i < 30; i++) { await new Promise((r) => setTimeout(r, 1000)); if (toolsListed) break }
    log(`RESULT: toolsListed=${toolsListed} badAuth=${badAuth}`)
  } catch (e) { log(`ERROR: ${e.message}`) } finally { finish() }
}

let done = false
function finish() {
  if (done) return
  done = true
  try { child.kill('SIGKILL') } catch {}
  try { server.close() } catch {}
  console.error('=== SUMMARY ==='); for (const l of LOG) console.error(l)
  console.error(`FINAL toolsListed=${toolsListed} badAuth=${badAuth}`)
  process.exit(0)
}
setTimeout(() => { log('HARD TIMEOUT 120s'); finish() }, 120000)
main()
