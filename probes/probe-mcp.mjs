#!/usr/bin/env node
/**
 * Probe MCP server: proves whether Codex actually loads an MCP server declared
 * in a project-level `.codex/config.toml`.
 *
 * Mirrors the transport dscord's LoopbackMcp speaks (POST /mcp, JSON-RPC,
 * SSE stream for tools/call) but binds a fixed port and needs no auth, so a
 * static Codex config entry can point at it. Every request is appended to
 * probe-mcp.log: an `initialize` line means Codex read the config and connected.
 *
 * Usage: node probe-mcp.mjs [--port 39123] [--log <path>]
 */

import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}
const PORT = Number(argOf('port', '39123'))
const LOG = argOf('log', '/tmp/probe-mcp.log')
const PROTOCOL_VERSION = '2024-11-05'

const log = (line) => {
  const entry = `${new Date().toISOString()} ${line}\n`
  try { appendFileSync(LOG, entry) } catch { /* logging never breaks the probe */ }
  process.stdout.write(entry)
}

const TOOLS = [{
  name: 'probe_hello',
  description: 'Probe tool: returns a fixed string. Used only to verify that a project-level Codex MCP config was loaded.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
}]

const readBody = request => new Promise((resolve, reject) => {
  let body = ''
  request.setEncoding('utf8')
  request.on('data', chunk => { body += chunk })
  request.on('end', () => resolve(body))
  request.on('error', reject)
})

function answer({ id, method, params }) {
  switch (method) {
    case 'initialize':
      log(`initialize client=${JSON.stringify(params?.clientInfo ?? {})}`)
      return { jsonrpc: '2.0', id, result: {
        protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'probe', version: '1' },
      } }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} }
    case 'tools/list':
      log('tools/list')
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } }
    default:
      log(`unhandled ${method}`)
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } }
  }
}

function serveCall({ id, params }, response) {
  log(`tools/call name=${params?.name}`)
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  response.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id, result: {
    content: [{ type: 'text', text: `probe ok (callId=${randomUUID().slice(0, 8)})` }], isError: false } })}\n\n`)
  response.end()
}

const server = createServer(async (request, response) => {
  if (request.method !== 'POST' || !request.url?.startsWith('/mcp')) {
    response.writeHead(405); response.end(); return
  }
  let message
  try { message = JSON.parse(await readBody(request)) } catch { response.writeHead(400); response.end(); return }
  const messages = Array.isArray(message) ? message : [message]
  const calls = messages.filter(item => item?.method !== undefined)
  if (calls.length === 0) { response.writeHead(202); response.end(); return }

  const toolsCall = calls.find(item => item.method === 'tools/call')
  if (toolsCall !== undefined) { serveCall(toolsCall, response); return }

  const replies = calls.map(item => answer(item)).filter(Boolean)
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify(Array.isArray(message) ? replies : replies[0]))
})

server.listen(PORT, '127.0.0.1', () => log(`listening on http://127.0.0.1:${PORT}/mcp`))
