// The Codex app-server engine: `codex app-server --listen stdio://`, one
// JSON-RPC process per route that multiplexes threads. DS Bot Sessions map to
// threads; turns stream item notifications back.
import { spawn } from 'node:child_process'
import { JsonRpcPeer, wireProcess, EventQueue } from './jsonrpc.js'
import { cleanEnv } from './discover.js'
import { formatDiffActivity } from './diff-activity.js'

export class CodexEngine {
  constructor(route, engine, { findExecutable }) {
    this.route = route
    this.engine = engine
    this.findExecutable = findExecutable
    this.child = undefined
    this.peer = undefined
    this.threads = new Map()
  }

  threadFor(dshSessionId) {
    let thread = this.threads.get(dshSessionId)
    if (thread === undefined) {
      const queue = new EventQueue()
      thread = { dshSessionId, threadId: undefined, dead: false, push: event => queue.push(event), next: () => queue.next() }
      this.threads.set(dshSessionId, thread)
    }
    return thread
  }

  async ensure(mcp) {
    if (this.peer !== undefined) return this.peer
    const bin = this.findExecutable(this.engine.command)
    if (bin === undefined) throw Object.assign(new Error(`${this.engine.name} is not installed`), { code: 'NO_ADAPTER' })
    // Fork: Codex reads MCP servers only from process-level config (thread/start's
    // config silently ignores mcp_servers). So each Codex session runs its own
    // app-server (the adapter keys engines by session) and the session's loopback
    // MCP server is injected on the command line, with its token in the env.
    const args = [...(this.engine.args ?? [])]
    let env = cleanEnv(this.engine.env ?? {})
    if (mcp?.url && mcp?.token) {
      args.push('-c', `mcp_servers.dsbot={url="${mcp.url}", bearer_token_env_var="DSBOT_MCP_TOKEN"}`)
      env = cleanEnv({ ...(this.engine.env ?? {}), DSBOT_MCP_TOKEN: mcp.token })
    }
    const child = spawn(bin, args, {
      env,
      stdio: ['pipe', 'pipe', 'inherit'],
      windowsHide: true,
    })
    this.child = child
    const peer = this.peer = new JsonRpcPeer(line => child.stdin.write(`${JSON.stringify(line)}\n`))
    wireProcess(child, peer)
    child.on('exit', () => {
      peer.close(new Error(`${this.engine.name} exited`))
      this.child = undefined
      this.peer = undefined
      for (const thread of this.threads.values()) {
        thread.dead = true
        thread.push({ type: 'error', error: new Error(`${this.engine.name} exited`) })
      }
    })
    peer.notificationHandler = (method, params) => this.onNotice(method, params)
    peer.requestHandler = (method, params) => this.onRequest(method, params)
    await peer.request('initialize', { clientInfo: { name: 'ds-bot', title: null, version: '1' } }, { timeout: 30_000 })
    peer.notify('initialized', {})
    return peer
  }

  onNotice(method, params) {
    const thread = [...this.threads.values()].find(entry => entry.threadId === params?.threadId)
    switch (method) {
      case 'item/started':
      case 'item/completed': {
        const item = params?.item ?? {}
        if (thread === undefined || thread.compacting) break
        if (item.type === 'agentMessage' || item.type === 'agent_message') thread.push({ type: 'text', text: item.text ?? '' })
        else if (item.type === 'reasoning') thread.push({ type: 'thought', text: (item.content ?? []).join('') || item.text || '' })
        else if (method === 'item/completed' && (item.type === 'fileChange' || item.type === 'file_change') && Array.isArray(item.changes)) {
          for (const change of item.changes) {
            thread.push({
              type: 'activity',
              text: formatDiffActivity({
                tool: 'edit',
                path: change?.path ?? '',
                kind: change?.kind ?? 'update',
                diff: change?.diff ?? change?.patch,
                oldText: change?.oldText ?? change?.old_string,
                newText: change?.newText ?? change?.new_string,
              }),
            })
          }
        }
        else if (method === 'item/started' && item.type !== undefined) {
          thread.push({ type: 'activity', text: `▸ ${activityOf(item)}`, ...(isLocalExecItem(item) ? { localExec: true } : {}) })
        }
        break
      }
      case 'turn/completed': {
        if (thread === undefined) break
        if (thread.compacting) {
          thread.compactDone?.()
          break
        }
        const turn = params?.turn ?? {}
        if (turn.status === 'failed') thread.push({ type: 'error', error: new Error(turn.error?.message ?? 'the turn failed') })
        else thread.push({ type: 'done', reason: 'stop' })
        break
      }
      case 'thread/tokenUsage/updated': {
        if (thread === undefined) break
        const raw = params?.tokenUsage ?? params?.usage
        const usage = normalizeCodexTokenUsage(raw)
        const cw = Number(raw?.modelContextWindow ?? raw?.contextWindow ?? 0) || 0
        if (usage !== undefined) thread.push({ type: 'usage', usage, ...(cw > 0 ? { contextWindow: cw } : {}) })
        break
      }
      case 'thread/compacted': {
        if (thread === undefined) break
        thread.compactDone?.()
        thread.push({ type: 'compacted' })
        break
      }
      default: break
    }
  }

  // Server-initiated approval requests bridge to the approval tool.
  onRequest(method, params) {
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval' || method === 'execCommandApproval' || method === 'patchApproval') {
      const thread = [...this.threads.values()].find(entry => entry.threadId === params?.threadId)
      const options = (params?.availableDecisions ?? params?.decisions ?? ['accept', 'decline']).map(decision => ({ optionId: decision, kind: decision === 'accept' || decision === 'acceptForSession' ? 'allow_once' : 'reject_once', name: decision }))
      return new Promise((resolve) => {
        const reply = (decision) => resolve({ decision: decision ?? 'decline' })
        thread?.push({
          type: 'permission', id: `perm-${Math.random().toString(36).slice(2)}`, reply,
          action: params?.reason ?? params?.command ?? 'The agent asks to run an action',
          detail: detailText(params),
          options,
        })
      })
    }
    // Fork: Codex gates MCP tool calls through `mcpServer/elicitation/request`
    // (tool-call elicitation). Rejecting it here makes every call fail with
    // "user rejected MCP tool call". The dsbot server is dscord's own loopback
    // (DSH still enforces its tool guards), so accept it; any other server needs a
    // human answer the Bot cannot give, so decline.
    if (method === 'mcpServer/elicitation/request') {
      return Promise.resolve(params?.serverName === 'dsbot' ? { action: 'accept', content: {} } : { action: 'decline' })
    }
    return Promise.reject({ code: -32601, message: `method not found: ${method}` })
  }

  async open(dshSessionId, { cwd, mcp, resumeId, mode, instructions, model }) {
    const peer = await this.ensure(mcp)
    const thread = this.threadFor(dshSessionId)
    if (resumeId !== undefined) thread.threadId = resumeId
    const config = {
      cwd,
      ...(instructions ? { developer_instructions: instructions } : {}),
      ...(mode ? { sandbox_mode: mode, approval_policy: mode === 'danger-full-access' ? 'never' : 'on-request' } : {}),
      ...(model && model !== 'default' ? { model } : {}),
    }
    if (thread.threadId !== undefined) {
      try {
        await peer.request('thread/resume', { threadId: thread.threadId, config }, { timeout: 30_000 })
        return thread
      } catch {
        thread.threadId = undefined
      }
    }
    const reply = await peer.request('thread/start', config, { timeout: 60_000 })
    thread.threadId = reply?.thread?.id ?? reply?.threadId
    return thread
  }

  // Follow-up instructions while a thread lives (Codex injects a developer item).
  async instruct(thread, text) {
    if (text === '') return
    await this.peer?.request('thread/inject_items', { threadId: thread.threadId, items: [{ type: 'developerMessage', text }] }, { timeout: 15_000 }).catch(() => {})
  }

  async prompt(thread, blocks, { signal }) {
    const peer = await this.ensure()
    const reply = await peer.request('turn/start', {
      threadId: thread.threadId,
      input: blocks.map(block => block.type === 'image' ? { type: 'image', url: block.url ?? block.data } : { type: 'text', text: block.text ?? '' }),
    }, { signal, timeout: 0 })
    thread.turnId = reply?.turn?.id ?? reply?.id
    return thread.turnId
  }

  async steer(thread, text) {
    await this.peer?.request('turn/steer', { threadId: thread.threadId, input: [{ type: 'text', text }] }, { timeout: 15_000 }).catch(() => {})
  }

  async compact(thread) {
    if (!this.peer || !thread?.threadId) return false
    if (thread.compacting) return false
    thread.compacting = true
    let resolveDone
    let timer
    const done = new Promise(resolve => { resolveDone = resolve })
    thread.compactDone = () => {
      if (timer) { clearTimeout(timer); timer = undefined }
      thread.compacting = false
      thread.compactDone = undefined
      resolveDone?.()
    }
    try {
      await this.peer.request('thread/compact/start', { threadId: thread.threadId }, { timeout: 120_000 })
      // Wait for Codex's Compact turn to finish (`thread/compacted` or `turn/completed`)
      // before allowing any new turn/start so Codex never throws ActiveTurnNotSteerable.
      await Promise.race([
        done,
        new Promise(resolve => { timer = setTimeout(resolve, 90_000); timer.unref?.() }),
      ])
      return true
    } finally {
      thread.compactDone?.()
    }
  }

  cancel(thread) {
    this.peer?.request('turn/interrupt', { threadId: thread.threadId, turnId: thread.turnId }, { timeout: 15_000 }).catch(() => {})
  }

  async listModels() {
    const peer = await this.ensure()
    const reply = await peer.request('model/list', {}, { timeout: 30_000 })
    return (reply?.data ?? reply?.models ?? []).map(entry => {
      const cw = entry.contextWindow ?? entry.context_window ?? entry.modelContextWindow ?? entry.maxContextTokens
      return {
        id: String(entry.id ?? entry.model),
        name: String(entry.displayName ?? entry.name ?? entry.id ?? entry.model),
        ...(Number.isInteger(cw) && cw > 0 ? { contextWindow: cw } : {}),
      }
    })
  }

  async close() {
    const child = this.child
    this.child = undefined
    this.peer = undefined
    if (child !== undefined) {
      child.kill('SIGTERM')
      setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 5_000).unref?.()
    }
  }
}

export function normalizeCodexTokenUsage(raw) {
  if (!raw || typeof raw !== 'object') return undefined
  // Codex app-server reports `{ last: { inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, totalTokens }, total: {...}, modelContextWindow }`.
  // Prefer `last` so DSH's context meter reflects the actual current context window occupancy rather than 0.
  const src = (raw.last && typeof raw.last === 'object') ? raw.last
    : (raw.total && typeof raw.total === 'object') ? raw.total
      : raw
  const rawIn = Number(src.inputTokens ?? src.input_tokens ?? 0) || 0
  const cached = Number(src.cachedInputTokens ?? src.cached_input_tokens ?? src.cacheReadInputTokens ?? 0) || 0
  const out = Number(src.outputTokens ?? src.output_tokens ?? 0) || 0
  const reasoning = Number(src.reasoningOutputTokens ?? src.reasoning_output_tokens ?? src.reasoningTokens ?? 0) || 0
  // DSH computes total prompt occupancy as `inputTokens + cacheReadInputTokens`;
  // OpenAI/Codex `inputTokens` already includes `cachedInputTokens`, so split cleanly.
  const uncachedIn = cached > 0 && rawIn >= cached ? rawIn - cached : rawIn
  if (uncachedIn === 0 && cached === 0 && out === 0 && reasoning === 0) return undefined
  return {
    inputTokens: uncachedIn,
    outputTokens: out,
    ...(cached > 0 ? { cacheReadInputTokens: cached } : {}),
    ...(reasoning > 0 ? { reasoningTokens: reasoning } : {}),
  }
}

const LOCAL_EXEC_TYPES = new Set([
  'commandExecution', 'command_execution', 'fileChange', 'file_change',
  'customToolCall', 'custom_tool_call', 'webSearch', 'web_search',
])
export function isLocalExecItem(item) {
  if (!item || typeof item !== 'object') return false
  if (LOCAL_EXEC_TYPES.has(item.type)) return true
  if ((item.type === 'mcpToolCall' || item.type === 'mcp_tool_call') && item.server !== 'dsbot') return true
  return false
}

const activityOf = item => {
  const kind = item.type === 'commandExecution' ? (item.command ?? 'command')
    : item.type === 'fileChange' ? 'edit'
      : item.type === 'mcpToolCall' ? (item.tool ?? 'tool')
        : (item.title ?? item.type)
  return String(kind).split('\n')[0].slice(0, 120)
}
const detailText = params => [params?.command, params?.reason, JSON.stringify(params?.changes ?? params?.patch ?? '')].filter(Boolean).join('\n').slice(0, 4_000)
