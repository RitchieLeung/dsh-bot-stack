// Fork: Structured single-line diff activity helpers for local CLI agents
// (codex-cli, claude-code, acp). Emits `▸ DIFF <json>` lines that stepActivity()
// in vendor/ds-bot/client.js extracts from reasoning and renders with FileDiffCard.

const MAX_TEXT = 12_000

function clip(text) {
  if (typeof text !== 'string') return undefined
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n... (truncated)` : text
}

export function lineDiff(before, after) {
  const a = (before || '').split('\n')
  const b = (after || '').split('\n')
  if (a.length * b.length > 90_000) {
    return [
      ...a.map(s => ({ k: '-', s })),
      ...b.map(s => ({ k: '+', s })),
    ]
  }
  const dp = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ k: ' ', s: a[i++] })
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ k: '-', s: a[i++] })
    } else {
      out.push({ k: '+', s: b[j++] })
    }
  }
  while (i < a.length) out.push({ k: '-', s: a[i++] })
  while (j < b.length) out.push({ k: '+', s: b[j++] })
  return out
}

export function parseUnifiedDiffRows(diffText) {
  if (typeof diffText !== 'string' || !diffText.trim()) return []
  const lines = diffText.replace(/\r\n/g, '\n').split('\n')
  const rows = []
  for (const line of lines) {
    if (
      line.startsWith('--- ') ||
      line.startsWith('+++ ') ||
      line.startsWith('diff --git ') ||
      line.startsWith('index ') ||
      line.startsWith('*** Begin Patch') ||
      line.startsWith('*** End Patch') ||
      line.startsWith('*** Update File:') ||
      line.startsWith('*** Add File:') ||
      line.startsWith('*** Delete File:')
    ) continue
    if (line.startsWith('@@')) {
      rows.push({ k: '@', s: line })
      continue
    }
    if (line.startsWith('+')) {
      rows.push({ k: '+', s: line.slice(1) })
    } else if (line.startsWith('-')) {
      rows.push({ k: '-', s: line.slice(1) })
    } else if (line.startsWith(' ')) {
      rows.push({ k: ' ', s: line.slice(1) })
    } else if (line.length > 0) {
      rows.push({ k: ' ', s: line })
    }
  }
  return rows
}

export function diffRowsOf(payload) {
  if (!payload || typeof payload !== 'object') return []
  if (typeof payload.diff === 'string' && payload.diff.trim()) {
    return parseUnifiedDiffRows(payload.diff)
  }
  const hasOld = typeof payload.oldText === 'string'
  const hasNew = typeof payload.newText === 'string'
  if (hasOld && !hasNew) {
    return payload.oldText.split('\n').map(s => ({ k: '-', s }))
  }
  if (!hasOld && hasNew) {
    return payload.newText.split('\n').map(s => ({ k: '+', s }))
  }
  if (hasOld || hasNew) {
    return lineDiff(payload.oldText ?? '', payload.newText ?? '')
  }
  return []
}

export function formatDiffActivity({ tool = 'edit', path = '', kind = 'update', diff, oldText, newText } = {}) {
  const payload = {
    tool: String(tool || 'edit'),
    path: String(path || ''),
    kind: String(kind || 'update'),
  }
  if (typeof diff === 'string' && diff.trim()) payload.diff = clip(diff)
  if (typeof oldText === 'string') payload.oldText = clip(oldText)
  if (typeof newText === 'string') payload.newText = clip(newText)
  const rows = diffRowsOf(payload)
  let added = 0
  let removed = 0
  for (const r of rows) {
    if (r.k === '+') added++
    else if (r.k === '-') removed++
  }
  payload.added = added
  payload.removed = removed
  return `▸ DIFF ${JSON.stringify(payload)}`
}

export function parseDiffActivity(line) {
  if (typeof line !== 'string') return null
  const trimmed = line.trim()
  const raw = trimmed.startsWith('▸ DIFF ')
    ? trimmed.slice('▸ DIFF '.length).trim()
    : trimmed.startsWith('DIFF ')
      ? trimmed.slice('DIFF '.length).trim()
      : null
  if (!raw || !raw.startsWith('{')) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

export function claudeDiffActivities(block) {
  if (!block || block.type !== 'tool_use') return []
  const name = String(block.name ?? '')
  const lower = name.toLowerCase()
  const input = block.input ?? {}
  if (lower === 'multiedit' && Array.isArray(input.edits)) {
    const path = input.file_path ?? input.path ?? ''
    return input.edits.map(edit => formatDiffActivity({
      tool: name,
      path: edit?.file_path ?? path,
      kind: 'update',
      oldText: edit?.old_string ?? edit?.oldText ?? '',
      newText: edit?.new_string ?? edit?.newText ?? '',
    }))
  }
  if (lower === 'edit' || lower === 'str_replace_editor' || lower === 'edit_file') {
    const path = input.file_path ?? input.path ?? input.TargetFile ?? ''
    const oldText = input.old_string ?? input.old_str ?? input.oldText ?? input.Target
    const newText = input.new_string ?? input.new_str ?? input.newText ?? input.Replacement
    if (typeof oldText === 'string' || typeof newText === 'string') {
      return [formatDiffActivity({ tool: name, path, kind: 'update', oldText: oldText ?? '', newText: newText ?? '' })]
    }
  }
  if (lower === 'write' || lower === 'write_file') {
    const path = input.file_path ?? input.path ?? input.TargetFile ?? ''
    const content = input.content ?? input.new_string ?? input.Content
    if (typeof content === 'string') {
      return [formatDiffActivity({ tool: name, path, kind: 'create', newText: content })]
    }
  }
  if (lower === 'apply_patch') {
    const patch = input.patch ?? input.diff ?? input.input
    if (typeof patch === 'string') {
      return [formatDiffActivity({ tool: name, path: input.path ?? '', kind: 'patch', diff: patch })]
    }
  }
  return []
}

export function acpDiffActivities(call) {
  if (!call || typeof call !== 'object') return []
  const kind = String(call.kind ?? '').toLowerCase()
  const title = String(call.title ?? '')
  const input = call.rawInput && typeof call.rawInput === 'object' ? call.rawInput : {}
  const path = call.locations?.[0]?.path ?? input.file_path ?? input.path ?? ''
  if (typeof input.diff === 'string' || typeof input.patch === 'string') {
    return [formatDiffActivity({
      tool: title || kind || 'edit',
      path,
      kind: 'patch',
      diff: input.diff ?? input.patch,
    })]
  }
  const oldText = input.old_string ?? input.old_str ?? input.oldText ?? input.Target
  const newText = input.new_string ?? input.new_str ?? input.newText ?? input.Replacement ?? input.content
  if (kind === 'edit' || /edit|write|patch/i.test(title)) {
    if (typeof oldText === 'string' || typeof newText === 'string') {
      return [formatDiffActivity({
        tool: title || kind || 'edit',
        path,
        kind: typeof oldText === 'string' ? 'update' : 'create',
        oldText,
        newText,
      })]
    }
  }
  return []
}
