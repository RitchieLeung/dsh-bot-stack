#!/usr/bin/env node
/**
 * 决定性实验 #5：agy 对「同名 MCP 服务器 + 换端口」是否复用旧缓存而不重连。
 * dscord 的 LoopbackMcp 每次会话都是随机端口、且名字恒为 "dsbot"；agy 把 MCP 服务器
 * 按名字缓存到 ~/.gemini/antigravity-cli/mcp/<name>/。若同名换端口时 agy 不重连，
 * 就能解释「kiki 永远拿不到团队工具」：它连的是第一次（或探针污染）的旧端口，早已关闭。
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'

const SECRET = 'reuse-secret'
const LOG = []
const log = (m) => { const line = `[${new Date().toISOString()}] ${m}`; LOG.push(line); console.error(line) }

function makeServer(toolName) {
  const events = { listed: false, called: false }
  const server = createServer((req, res) => {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
    if (req.headers.authorization !== `Bearer ${SECRET}`) { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'unauthorized' } })); return }
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
      if (tc) { events.called = true; log(`[${toolName}] tools/call name=${tc.params?.name}`); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: tc.id, result: { content: [{ type: 'text', text: `${toolName}-ok` }], isError: false } })}\n\n`); res.end(); return }
      const replies = calls.map((m) => {
        if (m.method === 'initialize') { events.listed = true; return { jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: toolName, version: '1' } } } }
        if (m.method === 'tools/list') { events.listed = true; log(`[${toolName}] tools/list`); return { jsonrpc: '2.0', id: m.id, result: { tools: [{ name: toolName, description: `tool ${toolName}`, inputSchema: { type: 'object', properties: {} } }] } } }
        if (m.method === 'ping') return { jsonrpc: '2.0', id: m.id, result: {} }
        log(`[${toolName}] unhandled ${m.method}`)
        return { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'nf' } }
      }).filter(Boolean)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(Array.isArray(msg) ? replies : replies[0]))
    })
  })
  return { server, events }
}

const A = makeServer('tool_A')
const B = makeServer('tool_B')
await new Promise((r) => A.server.listen(0, '127.0.0.1', r))
await new Promise((r) => B.server.listen(0, '127.0.0.1', r))
const portA = A.server.address().port
const portB = B.server.address().port
log(`serverA(portA=${portA}) serverB(portB=${portB})`)

const child = spawn('agy', ['acp'], { stdio: ['pipe', 'pipe', 'inherit'] })
let rest = ''
child.stdout.setEncoding('utf8')
child.stdout.on('data', (c) => { rest += c; let i; while ((i = rest.indexOf('\n')) !== -1) { const line = rest.slice(0, i).trim(); rest = rest.slice(i + 1); if (line) onLine(line) } })
child.on('exit', (code) => { log(`agy EXITED ${code}`); finish() })

let reqId = 0
const pending = new Map()
const send = (o) => { try { child.stdin.write(JSON.stringify(o) + '\n') } catch {} }
function onLine(line) { let m; try { m = JSON.parse(line) } catch { return }; if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
function request(method, params, t = 60000) { return new Promise((res, rej) => { const id = ++reqId; pending.set(id, res); send({ jsonrpc: '2.0', id, method, params }); setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(`timeout ${method}`)) } }, t) }) }
const mcpOf = (port) => [{ type: 'http', name: 'dsbot', url: `http://127.0.0.1:${port}/mcp`, headers: [{ name: 'Authorization', value: `Bearer ${SECRET}` }] }]

async function main() {
  try {
    await request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'ds-bot', version: '1' } })
    send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })

    // 阶段1：dsbot → serverA，应连通
    const s1 = await request('session/new', { cwd: process.cwd(), mcpServers: mcpOf(portA) })
    const sid1 = s1?.result?.sessionId ?? s1?.sessionId
    log(`phase1 session/new sid1=${sid1}`)
    send({ jsonrpc: '2.0', id: ++reqId, method: 'session/prompt', params: { sessionId: sid1, prompt: [{ type: 'text', text: 'call the tool_A tool' }] } })
    for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 1000)); if (A.events.called) break }
    log(`phase1 RESULT: A.listed=${A.events.listed} A.called=${A.events.called}`)

    // 阶段2：同名 dsbot → serverB（端口变了）
    const s2 = await request('session/new', { cwd: process.cwd(), mcpServers: mcpOf(portB) })
    const sid2 = s2?.result?.sessionId ?? s2?.sessionId
    log(`phase2 session/new sid2=${sid2}`)
    send({ jsonrpc: '2.0', id: ++reqId, method: 'session/prompt', params: { sessionId: sid2, prompt: [{ type: 'text', text: 'call the tool_B tool' }] } })
    for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 1000)); if (B.events.called) break }
    log(`phase2 RESULT: B.listed=${B.events.listed} B.called=${B.events.called}`)
  } catch (e) { log(`ERROR: ${e.message}`) } finally { finish() }
}

let done = false
function finish() {
  if (done) return
  done = true
  try { child.kill('SIGKILL') } catch {}
  try { A.server.close() } catch {}
  try { B.server.close() } catch {}
  console.error('=== SUMMARY ==='); for (const l of LOG) console.error(l)
  console.error(`FINAL A.called=${A.events.called} B.called=${B.events.called}`)
  process.exit(0)
}
setTimeout(() => { log('HARD TIMEOUT 150s'); finish() }, 150000)
main()
