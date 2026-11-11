#!/usr/bin/env node
/**
 * 决定性实验 #3：agy 的 `session/load`（恢复会话）是否应用 mcpServers。
 *
 * kiki 的现状：她有一个持久化的 cliSessionId，dscord 每次用 `session/load` 恢复，
 * 而我的上一次探针只验证了 `session/new` 会带 MCP。本实验复刻 kiki 的路径：
 *   1. session/new 不带 MCP（模拟她创建时没拿到 dsbot）
 *   2. session/load 带上 MCP（dscord 每次恢复时都会带的 dsbot）
 * 若第 2 步的 MCP 服务器收不到 tools/list，即证明 agy 的 session/load 忽略 mcpServers，
 * 根因坐实：老会话永远补不上团队工具。
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'

const LOG = []
const log = (m) => { const line = `[${new Date().toISOString()}] ${m}`; LOG.push(line); console.error(line) }

let toolsListed = false
let toolsCalled = false

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
      log(`tools/call name=${tc.params?.name}`)
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: tc.id, result: { content: [{ type: 'text', text: 'load-probe-ok' }], isError: false } })}\n\n`)
      res.end(); return
    }
    const replies = calls.map((m) => {
      if (m.method === 'initialize') { log(`initialize client=${JSON.stringify(m.params?.clientInfo ?? {})}`); return { jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '1' } } } }
      if (m.method === 'tools/list') { toolsListed = true; log('tools/list'); return { jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'probe_load_hello', description: 'probe tool for session/load MCP test', inputSchema: { type: 'object', properties: {} } }] } } }
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

const child = spawn('agy', ['acp'], { stdio: ['pipe', 'pipe', 'inherit'] })

let rest = ''
child.stdout.setEncoding('utf8')
child.stdout.on('data', (c) => {
  rest += c
  let i
  while ((i = rest.indexOf('\n')) !== -1) { const line = rest.slice(0, i).trim(); rest = rest.slice(i + 1); if (line) onLine(line) }
})
child.on('exit', (code) => { log(`agy acp EXITED ${code}`); finish() })
child.on('error', (e) => { log(`agy spawn error: ${e.message}`); finish() })

let reqId = 0
const pending = new Map()
const send = (o) => { try { child.stdin.write(JSON.stringify(o) + '\n') } catch {} }
function onLine(line) {
  let m
  try { m = JSON.parse(line) } catch { return }
  if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
}
function request(method, params, t = 60000) {
  return new Promise((res, rej) => { const id = ++reqId; pending.set(id, res); send({ jsonrpc: '2.0', id, method, params }); setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(`timeout ${method}`)) } }, t) })
}

async function main() {
  try {
    const init = await request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'ds-bot', version: '1' } })
    log(`initialize reply keys=${Object.keys(init.result ?? {}).join(',')}`)
    send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })

    // 1. 新建会话，不带 MCP（模拟 kiki 创建时没拿到 dsbot）
    const created = await request('session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = created?.result?.sessionId ?? created?.sessionId
    log(`session/new full=${JSON.stringify(created).slice(0, 300)}`)
    if (!sessionId) throw new Error('no sessionId from session/new')

    // 2. 恢复会话，带上 MCP（dscord 每次恢复都会带 dsbot）
    const loaded = await request('session/load', { sessionId, cwd: process.cwd(), mcpServers: [{ type: 'http', name: 'probe', url: `http://127.0.0.1:${port}/mcp` }] })
    log(`session/load full=${JSON.stringify(loaded).slice(0, 300)}`)

    // 3. 让它用工具
    send({ jsonrpc: '2.0', id: ++reqId, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'Please call the probe_load_hello tool and tell me what it returns.' }] } })

    for (let i = 0; i < 60; i++) { await new Promise((r) => setTimeout(r, 1000)); if (toolsCalled) break }
    log(`RESULT: toolsListed=${toolsListed} toolsCalled=${toolsCalled}`)
  } catch (e) { log(`ERROR: ${e.message}`) } finally { finish() }
}

let done = false
function finish() {
  if (done) return
  done = true
  try { child.kill('SIGKILL') } catch {}
  try { server.close() } catch {}
  console.error('=== SUMMARY ==='); for (const l of LOG) console.error(l)
  console.error(`FINAL toolsListed=${toolsListed} toolsCalled=${toolsCalled}`)
  process.exit(0)
}
setTimeout(() => { log('HARD TIMEOUT 120s'); finish() }, 120000)
main()
