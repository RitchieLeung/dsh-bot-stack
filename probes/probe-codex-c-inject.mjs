#!/usr/bin/env node
/**
 * 决定性实验：`codex app-server -c 'mcp_servers.X={url=...}'` 在进程 spawn 时注入的
 * MCP 服务器，是否真的被线程在运行时加载（而不仅是 `mcp list` 能解析）。
 *
 * 判定信号（probe 服务器收到任一即证明 `-c` 注入到达运行时）：
 *   - `initialize`：codex 连上了我们的 MCP 服务器
 *   - `tools/list`：codex 查询了工具清单
 *   - `tools/call`：模型实际调用了 probe_hello
 *
 * 用法：node probe-codex-c-inject.mjs
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'

const LOG = []
const log = (m) => { const line = `[${new Date().toISOString()}] ${m}`; LOG.push(line); console.error(line) }

let toolsListed = false
let toolsCalled = false
let initialized = false

// ---- 探针 MCP 服务器（无鉴权，聚焦核心问题） ----
const server = createServer((req, res) => {
  if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
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
      toolsCalled = true
      log(`tools/call name=${tc.params?.name} args=${JSON.stringify(tc.params?.arguments ?? {})}`)
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: tc.id, result: { content: [{ type: 'text', text: 'probe ok from codex injection test' }], isError: false } })}\n\n`)
      res.end(); return
    }
    const replies = calls.map((m) => {
      if (m.method === 'initialize') { initialized = true; log(`initialize client=${JSON.stringify(m.params?.clientInfo ?? {})}`); return { jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '1' } } } }
      if (m.method === 'ping') return { jsonrpc: '2.0', id: m.id, result: {} }
      if (m.method === 'tools/list') { toolsListed = true; log('tools/list'); return { jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'probe_hello', description: 'Probe tool that returns a fixed string. Call it to verify MCP injection works.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] } } }
      log(`unhandled ${m.method}`)
      return { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'method not found' } }
    }).filter(Boolean)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(Array.isArray(msg) ? replies : replies[0]))
  })
})

await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
log(`probe MCP listening http://127.0.0.1:${port}/mcp`)

// ---- spawn codex app-server，带 -c 注入 ----
const bin = '/Users/ritchie_leung/.local/bin/codex'
const child = spawn(bin, ['app-server', '--listen', 'stdio://', '-c', `mcp_servers.probe={url="http://127.0.0.1:${port}/mcp"}`], { stdio: ['pipe', 'pipe', 'inherit'] })

let rest = ''
child.stdout.setEncoding('utf8')
child.stdout.on('data', (c) => {
  rest += c
  let i
  while ((i = rest.indexOf('\n')) !== -1) {
    const line = rest.slice(0, i).trim()
    rest = rest.slice(i + 1)
    if (line) onLine(line)
  }
})
child.on('exit', (code) => { log(`codex app-server EXITED code=${code}`); finish() })
child.on('error', (e) => { log(`codex app-server spawn error: ${e.message}`); finish() })

let reqId = 0
const pending = new Map()
const send = (obj) => { try { child.stdin.write(JSON.stringify(obj) + '\n') } catch {} }

function onLine(line) {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
}

function request(method, params, timeout = 60_000) {
  return new Promise((resolve, reject) => {
    const id = ++reqId
    pending.set(id, resolve)
    send({ jsonrpc: '2.0', id, method, params })
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout ${method}`)) } }, timeout)
  })
}

async function main() {
  try {
    await request('initialize', { clientInfo: { name: 'ds-bot', title: null, version: '1' } })
    log('initialize reply ok')
    send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
    const start = await request('thread/start', { cwd: process.cwd(), input: [{ type: 'text', text: 'Please call the probe_hello tool and tell me exactly what it returns. Do not do anything else.' }] }, 120_000)
    log(`thread/start reply: ${JSON.stringify(start).slice(0, 160)}`)
    for (let i = 0; i < 90; i++) {
      await new Promise((r) => setTimeout(r, 1000))
      if (toolsCalled) break
    }
    log(`RESULT: initialized=${initialized} toolsListed=${toolsListed} toolsCalled=${toolsCalled}`)
  } catch (e) {
    log(`ERROR: ${e.message}`)
  } finally {
    finish()
  }
}

let done = false
function finish() {
  if (done) return
  done = true
  try { child.kill('SIGKILL') } catch {}
  try { server.close() } catch {}
  console.error('=== SUMMARY ===')
  for (const l of LOG) console.error(l)
  console.error(`FINAL initialized=${initialized} toolsListed=${toolsListed} toolsCalled=${toolsCalled}`)
  process.exit(0)
}

setTimeout(() => { log('HARD TIMEOUT 200s'); finish() }, 200_000)
main()
