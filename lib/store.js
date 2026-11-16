/**
 * Durable store for the issue board.
 *
 * The single writable source of truth behind the issue module: schema, the
 * status state machine, optimistic versioning, comments and the dispatch
 * ledger that joins an issue to a dscord worker task. Kept free of Cordis so
 * it is unit-testable against a scratch database.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const STATUSES = ['open', 'discussing', 'dispatched', 'in_review', 'done', 'failed', 'cancelled'];
/** Human-facing names: everything written for people (comments, messages) uses these. */
export const STATUS_LABELS = {
  open: '待处理',
  discussing: '讨论中',
  dispatched: '进行中',
  in_review: '待验收',
  done: '已闭环',
  failed: '失败',
  cancelled: '已取消',
};
/** Label of a status, falling back to the raw id for unknown values. */
export const statusLabel = status => STATUS_LABELS[status] || String(status || '');
/** Status ids as whole words, for rewriting raw ids inside old comment text. */
const STATUS_WORD_RE = /\b(open|discussing|dispatched|in_review|done|failed|cancelled)\b/g;
export const ACTIVE_STATUSES = ['open', 'discussing', 'dispatched', 'in_review'];
export const TERMINAL_STATUSES = ['done', 'failed', 'cancelled'];

// Who may move where. A dispatched issue is owned by its worker until it reports
// (in_review / failed) or a human cancels: it must never be re-dispatched.
const TRANSITIONS = {
  open: new Set(['discussing', 'dispatched', 'cancelled']),
  discussing: new Set(['open', 'dispatched', 'cancelled']),
  dispatched: new Set(['in_review', 'failed', 'cancelled', 'open']),
  in_review: new Set(['done', 'open', 'cancelled']),
  done: new Set(['open']),
  failed: new Set(['open', 'cancelled']),
  cancelled: new Set(['open']),
};

const VALID_KINDS = new Set(['user', 'agent', 'system']);

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const shortId = () => `I-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
const now = () => Date.now();

function issueFrom(row) {
  if (!row) return null;
  return {
    id: row.id,
    number: typeof row.number === 'number' ? row.number : null,
    title: row.title,
    body: row.body,
    status: row.status,
    parentId: row.parentId || null,
    type: row.type || null,
    createdBy: row.createdBy,
    createdByName: row.createdByName,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    closedAt: row.closedAt || null,
    result: row.result || null,
  };
}

function assertTitle(title) {
  if (typeof title !== 'string' || !title.trim()) throw failure('INVALID_TITLE', '标题不能为空');
  return title.trim().slice(0, 200);
}

export function openIssueStore({ dbPath }) {
  if (!dbPath) throw failure('NO_DB_PATH', '缺少数据库路径');
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout = 3000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS issues (
      id            TEXT PRIMARY KEY,
      number        INTEGER,
      title         TEXT NOT NULL,
      body          TEXT NOT NULL DEFAULT '',
      status        TEXT NOT NULL DEFAULT 'open',
      parentId      TEXT,
      type          TEXT,
      createdBy     TEXT NOT NULL,
      createdByName TEXT NOT NULL DEFAULT '',
      version       INTEGER NOT NULL DEFAULT 1,
      createdAt     INTEGER NOT NULL,
      updatedAt     INTEGER NOT NULL,
      closedAt      INTEGER,
      result        TEXT
    );
    CREATE TABLE IF NOT EXISTS comments (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      issueId    TEXT NOT NULL,
      authorKind TEXT NOT NULL DEFAULT 'user',
      authorName TEXT NOT NULL DEFAULT '',
      body       TEXT NOT NULL,
      kind       TEXT NOT NULL DEFAULT 'comment',
      at         INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_comments_issue ON comments (issueId, at);
    CREATE TABLE IF NOT EXISTS dispatches (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      issueId         TEXT NOT NULL,
      taskId          TEXT NOT NULL,
      workerSessionId TEXT,
      status          TEXT NOT NULL DEFAULT 'dispatched',
      at              INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dispatches_issue ON dispatches (issueId);
    CREATE INDEX IF NOT EXISTS idx_dispatches_task  ON dispatches (taskId);
  `);

  // Migration: boards created before the issue type/number existed lack the columns.
  const existingCols = db.prepare('PRAGMA table_info(issues)').all().map(col => col.name);
  if (!existingCols.includes('type')) db.exec('ALTER TABLE issues ADD COLUMN type TEXT');
  if (!existingCols.includes('number')) {
    db.exec('ALTER TABLE issues ADD COLUMN number INTEGER');
    // Backfill in creation order so old issues keep a stable, human #N.
    const backfill = db.prepare('SELECT id FROM issues ORDER BY createdAt ASC, rowid ASC').all();
    const assign = db.prepare('UPDATE issues SET number = ? WHERE id = ?');
    backfill.forEach((row, index) => assign.run(index + 1, row.id));
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_issues_number ON issues(number)');

  // Migration: early boards wrote status comments with raw ids (状态：open → dispatched).
  // Rewrite them once so the timeline reads the same everywhere (panel, tools, exports).
  const legacy = db.prepare("SELECT id, body FROM comments WHERE kind = 'status' AND body LIKE '状态：%'").all();
  const rewrite = db.prepare('UPDATE comments SET body = ? WHERE id = ?');
  for (const row of legacy) {
    const friendly = row.body.replace(STATUS_WORD_RE, word => STATUS_LABELS[word] || word);
    if (friendly !== row.body) rewrite.run(friendly, row.id);
  }

  const insertIssue = db.prepare(`
    INSERT INTO issues (id, number, title, body, status, parentId, type, createdBy, createdByName, version, createdAt, updatedAt, closedAt, result)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL, NULL)`);
  const selectIssue = db.prepare('SELECT * FROM issues WHERE id = ?');
  const selectIssueByNumber = db.prepare('SELECT * FROM issues WHERE number = ?');
  const nextNumber = db.prepare('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM issues');
  const selectChildren = db.prepare('SELECT * FROM issues WHERE parentId = ? ORDER BY createdAt ASC');
  const insertComment = db.prepare(
    'INSERT INTO comments (issueId, authorKind, authorName, body, kind, at) VALUES (?, ?, ?, ?, ?, ?)');
  const selectComments = db.prepare('SELECT * FROM comments WHERE issueId = ? ORDER BY at ASC, id ASC');
  const selectDispatches = db.prepare('SELECT * FROM dispatches WHERE issueId = ? ORDER BY at ASC, id ASC');
  const selectDispatchByTask = db.prepare('SELECT * FROM dispatches WHERE taskId = ?');
  const insertDispatch = db.prepare(
    'INSERT INTO dispatches (issueId, taskId, workerSessionId, status, at) VALUES (?, ?, ?, ?, ?)');
  const updateDispatch = db.prepare('UPDATE dispatches SET status = ? WHERE taskId = ?');
  const touch = db.prepare('UPDATE issues SET updatedAt = ?, version = version + 1 WHERE id = ?');

  /** Accepts an internal id (`I-xxxx`) or a human ref (`#12` / `12`). */
  function requireIssue(id) {
    const text = typeof id === 'string' ? id.trim() : id;
    const numeric = typeof text === 'string' ? text.match(/^#?(\d+)$/) : null;
    const row = numeric ? selectIssueByNumber.get(Number(numeric[1])) : selectIssue.get(text);
    if (!row) throw failure('NOT_FOUND', `找不到 issue：${id}`);
    return row;
  }

  function getFull(id) {
    const issue = issueFrom(requireIssue(id));
    const comments = selectComments.all(issue.id).map(row => ({
      id: row.id,
      issueId: row.issueId,
      authorKind: row.authorKind,
      authorName: row.authorName,
      body: row.body,
      kind: row.kind,
      at: row.at,
    }));
    const dispatches = selectDispatches.all(issue.id).map(row => ({
      id: row.id,
      issueId: row.issueId,
      taskId: row.taskId,
      workerSessionId: row.workerSessionId || null,
      status: row.status,
      at: row.at,
    }));
    return { ...issue, comments, dispatches };
  }

  function list({ status, parentId, type, query, limit = 50, offset = 0 } = {}) {
    let rows;
    if (parentId !== undefined && parentId !== null) {
      rows = selectChildren.all(requireIssue(parentId).id);
    } else {
      const clauses = [];
      const params = [];
      if (status && STATUSES.includes(status)) {
        clauses.push('status = ?');
        params.push(status);
      }
      if (typeof query === 'string' && query.trim()) {
        clauses.push('(title LIKE ? OR body LIKE ?)');
        const like = `%${query.trim()}%`;
        params.push(like, like);
      }
      if (typeof type === 'string' && type.trim()) {
        clauses.push('type = ?');
        params.push(type.trim());
      }
      const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
      rows = db.prepare(`SELECT * FROM issues${where} ORDER BY createdAt DESC`).all(...params);
    }
    const total = rows.length;
    const size = Math.max(1, limit);
    const start = Math.max(0, offset);
    return { items: rows.slice(start, start + size).map(issueFrom), total };
  }

  function create({ title, body = '', parentId = null, type = null, createdBy = 'user', createdByName = '' }) {
    title = assertTitle(title);
    if (!VALID_KINDS.has(createdBy)) createdBy = 'user';
    if (parentId) parentId = requireIssue(parentId).id; // parent must exist (accepts #N)
    const id = shortId();
    const at = now();
    const number = nextNumber.get().n;
    const typeText = typeof type === 'string' && type.trim() ? type.trim().slice(0, 40) : null;
    insertIssue.run(id, number, title, String(body || ''), 'open', parentId || null, typeText, createdBy, String(createdByName || ''), at, at);
    return issueFrom(selectIssue.get(id));
  }

  function update(id, patch = {}, actor = {}) {
    const row = requireIssue(id);
    id = row.id; // normalize a #N reference to the internal id for the writes below
    const from = row.status;
    const next = patch.status !== undefined ? patch.status : from;
    if (next !== from) {
      if (!STATUSES.includes(next)) throw failure('INVALID_STATUS', `未知状态：${next}`);
      if (!TRANSITIONS[from]?.has(next)) {
        throw failure('FORBIDDEN_TRANSITION', `不能从「${statusLabel(from)}」直接到「${statusLabel(next)}」`);
      }
    }
    if (patch.expectedVersion !== undefined && patch.expectedVersion !== row.version) {
      throw failure('VERSION_CONFLICT', `issue 已被改动（v${row.version}），请重新读取后再写`);
    }
    const title = patch.title !== undefined ? assertTitle(patch.title) : row.title;
    const body = patch.body !== undefined ? String(patch.body) : row.body;
    const result = patch.result !== undefined ? (patch.result === null ? null : String(patch.result)) : row.result;
    const type = patch.type !== undefined
      ? (patch.type === null ? null : (String(patch.type).trim().slice(0, 40) || null))
      : row.type;
    const closedAt = TERMINAL_STATUSES.includes(next)
      ? (row.closedAt ?? now())
      : (next === 'open' && row.closedAt ? null : row.closedAt);
    db.prepare(`UPDATE issues SET title = ?, body = ?, type = ?, status = ?, result = ?, closedAt = ?, updatedAt = ?, version = version + 1 WHERE id = ?`)
      .run(title, body, type, next, result, closedAt, now(), id);
    const updated = issueFrom(selectIssue.get(id));
    if (next !== from) {
      insertComment.run(id, actor.kind || 'system', actor.name || '', `状态：${statusLabel(from)} → ${statusLabel(next)}`, 'status', now());
    }
    return updated;
  }

  function comment(id, { body, authorKind = 'user', authorName = '', kind = 'comment' } = {}) {
    id = requireIssue(id).id; // accept #N
    if (typeof body !== 'string' || !body.trim()) throw failure('EMPTY_COMMENT', '评论不能为空');
    if (!VALID_KINDS.has(authorKind)) authorKind = 'user';
    const at = now();
    const info = insertComment.run(id, authorKind, String(authorName || ''), body.trim(), kind, at);
    touch.run(now(), id);
    return { id: Number(info.lastInsertRowid), issueId: id, authorKind, authorName: String(authorName || ''), body: body.trim(), kind, at };
  }

  /** The dispatch row of a worker task still in flight, or null. */
  function activeDispatch(id) {
    return selectDispatches.all(requireIssue(id).id).find(d => d.status === 'dispatched') || null;
  }

  const TERMINAL_TASK = new Set(['done', 'failed', 'cancelled', 'unknown']);
  function issueStatusForTask(status) {
    if (status === 'done') return 'in_review';
    if (status === 'failed' || status === 'unknown') return 'failed';
    return 'cancelled';
  }

  /**
   * System-level status write: reflects a worker task's real state, so it may
   * jump `open → in_review` when the poller first sees the task already
   * finished. Human/agent writes still go through `update` and its transition
   * guard.
   */
  function setStatusUnchecked(id, next, actorName) {
    const row = requireIssue(id);
    id = row.id; // accept #N
    if (next === row.status) return;
    const closedAt = TERMINAL_STATUSES.includes(next)
      ? (row.closedAt ?? now())
      : (next === 'open' && row.closedAt ? null : row.closedAt);
    db.prepare('UPDATE issues SET status = ?, closedAt = ?, updatedAt = ?, version = version + 1 WHERE id = ?')
      .run(next, closedAt, now(), id);
    insertComment.run(id, actorName ? 'agent' : 'system', actorName || '', `状态：${statusLabel(row.status)} → ${statusLabel(next)}`, 'status', now());
  }

  /**
   * Idempotent one-way sync of a dscord worker task into its issue. The
   * writeback poller calls this every sweep; a re-sync of the same task is a
   * no-op, and a task the human already closed is never overwritten (its
   * result lands as a comment instead).
   */
  function syncTask(id, { taskId, workerSessionId = null, status, resultText, workerName = null }) {
    id = requireIssue(id).id; // accept #N
    if (typeof taskId !== 'string' || !taskId.trim()) throw failure('INVALID_TASK', '缺少任务编号');
    const existing = selectDispatchByTask.get(taskId);
    if (existing && existing.status !== 'dispatched') return getFull(id); // already settled
    const terminal = TERMINAL_TASK.has(status);
    if (!existing) {
      insertDispatch.run(id, taskId.trim(), workerSessionId, terminal ? status : 'dispatched', now());
    } else if (terminal) {
      updateDispatch.run(status, taskId);
    }
    const row = requireIssue(id);
    if (terminal) {
      const handler = typeof workerName === 'string' && workerName.trim() ? workerName.trim() : null;
      if (ACTIVE_STATUSES.includes(row.status)) {
        setStatusUnchecked(id, issueStatusForTask(status), handler || '系统');
      }
      if (typeof resultText === 'string' && resultText.trim()) {
        comment(id, { body: resultText, authorKind: handler ? 'agent' : 'system', authorName: handler || '系统', kind: 'result' });
      }
    } else if (ACTIVE_STATUSES.includes(row.status) && row.status !== 'dispatched') {
      // First sighting of the live task: the issue is now owned by a worker.
      setStatusUnchecked(id, 'dispatched', '');
    }
    return getFull(id);
  }

  /** Per-status counts for the board sidebar. */
  function counts() {
    const map = {};
    for (const row of db.prepare('SELECT status, COUNT(*) AS n FROM issues GROUP BY status').all()) map[row.status] = row.n;
    return map;
  }

  /** Distinct issue types in use, for the create form's quick picks. */
  function types() {
    return db.prepare("SELECT DISTINCT type FROM issues WHERE type IS NOT NULL AND type <> '' ORDER BY type").all().map(row => row.type);
  }

  return {
    list, get: getFull, create, update, comment, activeDispatch, syncTask, counts, types,
    close() { try { db.close(); } catch { /* already closed */ } },
  };
}
