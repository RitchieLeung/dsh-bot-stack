// Budget & auto-compaction helpers for local-agent CLI engines (Codex, Claude Code, ACP).
export const DEFAULT_CONTEXT_WINDOW = 200_000
export const DEFAULT_FRONT_MAX_TOOL_CALLS = 6
export const DEFAULT_COMPACT_RATIO = 45
export const DEFAULT_COMPACT_MAX_K = 120
export const COMPACT_COOLDOWN_MS = 120_000

export function resolveFrontLocalExecLimit(prefs) {
  const pref = prefs?.frontMaxToolCalls
  if (Number.isInteger(pref) && pref >= 0 && pref <= 50) return pref
  return DEFAULT_FRONT_MAX_TOOL_CALLS
}

export function resolveLocalCompactThreshold(live, prefs) {
  const ratio = Number.isInteger(prefs?.compactRatio) && prefs.compactRatio >= 20 && prefs.compactRatio <= 90
    ? prefs.compactRatio
    : DEFAULT_COMPACT_RATIO
  const maxK = prefs?.compactMaxK
  const cap = maxK === 0
    ? Infinity
    : (Number.isInteger(maxK) && maxK >= 32 && maxK <= 500 ? maxK * 1000 : DEFAULT_COMPACT_MAX_K * 1000)
  const window = live?.contextWindow || live?.spec?.contextWindow || DEFAULT_CONTEXT_WINDOW
  return Math.min(Math.round(window * (ratio / 100)), cap)
}

export function trackFrontLocalExec(live, rt) {
  if (rt?.selfOf?.(live.sessionId) === undefined) return 'ignored'
  const limit = resolveFrontLocalExecLimit(rt?.state?.prefs)
  if (limit <= 0) return 'disabled'
  live.turnLocalExecs = (live.turnLocalExecs || 0) + 1
  if (live.turnLocalExecs >= limit && !live.frontLimitWarned) {
    live.frontLimitWarned = true
    const notice = `【系统约束】前台本轮本地执行工具已达上限（${limit} 次）。请立即停止在前台继续跑命令或改文件：多步或耗时任务请马上调用 dispatch_work 派给独立后台工作者（新上下文），然后简短回复已派工并结束本轮。`
    Promise.resolve(live.engine?.steer?.(live.engineSession, notice)).catch(() => {})
    return 'steered'
  }
  if (live.turnLocalExecs >= limit + 3 && !live.frontLimitInterrupted) {
    live.frontLimitInterrupted = true
    live.engine?.cancel?.(live.engineSession)
    return 'interrupted'
  }
  return 'counted'
}

export async function maybeAutoCompact(live, rt, { now = Date.now(), cooldownMs = COMPACT_COOLDOWN_MS, force = false } = {}) {
  if (live.dead || live.compacting || typeof live.engine?.compact !== 'function') return false
  const tokens = live.lastPromptTokens || 0
  const threshold = resolveLocalCompactThreshold(live, rt?.state?.prefs)
  if (!force) {
    if (tokens <= 0 || tokens < threshold) return false
    if (now - (live.lastCompactAt || 0) < cooldownMs) return false
  }
  live.compacting = true
  live.lastCompactAt = now
  const run = (async () => {
    try {
      const ok = await live.engine.compact(live.engineSession)
      if (ok !== false) {
        live.lastPromptTokens = 0
        rt?.warn?.('ds-bot: local-agent %s auto-compacted at %d tokens (threshold %d)', live.sessionId, tokens, threshold)
        return true
      }
      return false
    } catch (error) {
      rt?.warn?.('ds-bot: local-agent %s auto-compact failed: %s', live.sessionId, error?.message || error)
      return false
    } finally {
      live.compacting = false
      if (live.compactPromise === run) live.compactPromise = undefined
    }
  })()
  live.compactPromise = run
  return run
}
