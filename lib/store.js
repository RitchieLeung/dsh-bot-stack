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
    title: row.title,
    body: row.body,
    status: row.status,
    parentId: row.parentId || null,
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
      title         TEXT NOT NULL,
      body          TEXT NOT NULL DEFAULT '',
      status        TEXT NOT NULL DEFAULT 'open',
      parentId      TEXT,
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

  const insertIssue = db.prepare(`
    INSERT INTO issues (id, title, body, status, parentId, createdBy, createdByName, version, createdAt, updatedAt, closedAt, result)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL, NULL)`);
  const selectIssue = db.prepare('SELECT * FROM issues WHERE id = ?');
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

  function requireIssue(id) {
    const row = selectIssue.get(id);
    if (!row) throw failure('NOT_FOUND', `找不到 issue：${id}`);
    return row;
  }

  function getFull(id) {
    const issue = issueFrom(requireIssue(id));
    const comments = selectComments.all(id).map(row => ({
      id: row.id,
      issueId: row.issueId,
      authorKind: row.authorKind,
      authorName: row.authorName,
      body: row.body,
      kind: row.kind,
      at: row.at,
    }));
    const dispatches = selectDispatches.all(id).map(row => ({
      id: row.id,
      issueId: row.issueId,
      taskId: row.taskId,
      workerSessionId: row.workerSessionId || null,
      status: row.status,
      at: row.at,
    }));
    return { ...issue, comments, dispatches };
  }

  function list({ status, parentId, query, limit = 50, offset = 0 } = {}) {
    let rows;
    if (parentId !== undefined && parentId !== null) {
      rows = selectChildren.all(parentId);
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
      const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
      rows = db.prepare(`SELECT * FROM issues${where} ORDER BY createdAt DESC`).all(...params);
    }
    const total = rows.length;
    const size = Math.max(1, limit);
    const start = Math.max(0, offset);
    return { items: rows.slice(start, start + size).map(issueFrom), total };
  }

  function create({ title, body = '', parentId = null, createdBy = 'user', createdByName = '' }) {
    title = assertTitle(title);
    if (!VALID_KINDS.has(createdBy)) createdBy = 'user';
    if (parentId) requireIssue(parentId); // parent must exist
    const id = shortId();
    const at = now();
    insertIssue.run(id, title, String(body || ''), 'open', parentId || null, createdBy, String(createdByName || ''), at, at);
    return issueFrom(selectIssue.get(id));
  }

  function update(id, patch = {}, actor = {}) {
    const row = requireIssue(id);
    const from = row.status;
    const next = patch.status !== undefined ? patch.status : from;
    if (next !== from) {
      if (!STATUSES.includes(next)) throw failure('INVALID_STATUS', `未知状态：${next}`);
      if (!TRANSITIONS[from]?.has(next)) {
        throw failure('FORBIDDEN_TRANSITION', `不能从 ${from} 直接到 ${next}`);
      }
    }
    if (patch.expectedVersion !== undefined && patch.expectedVersion !== row.version) {
      throw failure('VERSION_CONFLICT', `issue 已被改动（v${row.version}），请重新读取后再写`);
    }
    const title = patch.title !== undefined ? assertTitle(patch.title) : row.title;
    const body = patch.body !== undefined ? String(patch.body) : row.body;
    const result = patch.result !== undefined ? (patch.result === null ? null : String(patch.result)) : row.result;
    const closedAt = TERMINAL_STATUSES.includes(next)
      ? (row.closedAt ?? now())
      : (next === 'open' && row.closedAt ? null : row.closedAt);
    db.prepare(`UPDATE issues SET title = ?, body = ?, status = ?, result = ?, closedAt = ?, updatedAt = ?, version = version + 1 WHERE id = ?`)
      .run(title, body, next, result, closedAt, now(), id);
    const updated = issueFrom(selectIssue.get(id));
    if (next !== from) {
      insertComment.run(id, actor.kind || 'system', actor.name || '', `状态：${from} → ${next}`, 'status', now());
    }
    return updated;
  }

  function comment(id, { body, authorKind = 'user', authorName = '', kind = 'comment' } = {}) {
    requireIssue(id);
    if (typeof body !== 'string' || !body.trim()) throw failure('EMPTY_COMMENT', '评论不能为空');
    if (!VALID_KINDS.has(authorKind)) authorKind = 'user';
    const at = now();
    const info = insertComment.run(id, authorKind, String(authorName || ''), body.trim(), kind, at);
    touch.run(now(), id);
    return { id: Number(info.lastInsertRowid), issueId: id, authorKind, authorName: String(authorName || ''), body: body.trim(), kind, at };
  }

  /** The dispatch row of a worker task still in flight, or null. */
  function activeDispatch(id) {
    return selectDispatches.all(id).find(d => d.status === 'dispatched') || null;
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
    if (next === row.status) return;
    const closedAt = TERMINAL_STATUSES.includes(next)
      ? (row.closedAt ?? now())
      : (next === 'open' && row.closedAt ? null : row.closedAt);
    db.prepare('UPDATE issues SET status = ?, closedAt = ?, updatedAt = ?, version = version + 1 WHERE id = ?')
      .run(next, closedAt, now(), id);
    insertComment.run(id, 'system', actorName, `状态：${row.status} → ${next}`, 'status', now());
  }

  /**
   * Idempotent one-way sync of a dscord worker task into its issue. The
   * writeback poller calls this every sweep; a re-sync of the same task is a
   * no-op, and a task the human already closed is never overwritten (its
   * result lands as a comment instead).
   */
  function syncTask(id, { taskId, workerSessionId = null, status, resultText }) {
    requireIssue(id);
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
      if (ACTIVE_STATUSES.includes(row.status)) {
        setStatusUnchecked(id, issueStatusForTask(status), 'worker');
      }
      if (typeof resultText === 'string' && resultText.trim()) {
        comment(id, { body: resultText, authorKind: 'system', authorName: 'worker', kind: 'result' });
      }
    } else if (ACTIVE_STATUSES.includes(row.status) && row.status !== 'dispatched') {
      // First sighting of the live task: the issue is now owned by a worker.
      setStatusUnchecked(id, 'dispatched', 'dispatch');
    }
    return getFull(id);
  }

  return {
    list, get: getFull, create, update, comment, activeDispatch, syncTask,
    close() { try { db.close(); } catch { /* already closed */ } },
  };
}
