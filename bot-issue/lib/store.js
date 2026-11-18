/**
 * Durable store for the issue board.
 *
 * The single writable source of truth behind the issue module: schema, the
 * status state machine, optimistic versioning, comments and the dispatch
 * ledger that joins an issue to a dscord worker task. Kept free of Cordis so
 * it is unit-testable against a scratch database.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path, { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
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

/** A label is a short free-text name; longer input is truncated, not rejected. */
const TAG_MAX_LEN = 40;
/** One issue carries at most this many labels (keeps the panel readable). */
const MAX_TAGS = 10;

/**
 * Normalize a label list: accepts an array or a single string (the legacy
 * `type` argument), trims, truncates, drops empties and duplicates.
 */
export function normalizeTags(input) {
  const raw = Array.isArray(input) ? input : (typeof input === 'string' ? [input] : []);
  const out = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const name = item.trim().slice(0, TAG_MAX_LEN);
    if (!name || out.includes(name)) continue;
    out.push(name);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/** `#12「标题」`, or the title alone for rows created before numbering. */
function issueRef(row) {
  return row.number ? `#${row.number}「${row.title}」` : `「${row.title}」`;
}
export const ACTIVE_STATUSES = ['open', 'discussing', 'dispatched', 'in_review'];
export const TERMINAL_STATUSES = ['done', 'failed', 'cancelled'];

// Who may move where. A dispatched issue is owned by its worker until it reports
// (in_review / failed) or a human cancels: it must never be re-dispatched.
const TRANSITIONS = {
  open: new Set(['discussing', 'dispatched', 'cancelled']),
  discussing: new Set(['open', 'dispatched', 'cancelled']),
  dispatched: new Set(['in_review', 'failed', 'cancelled', 'open']),
  in_review: new Set(['done', 'dispatched', 'open', 'cancelled']),
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
/** 图片走同一个 API 路由的 GET 分支（精确路径匹配，所以用 query 带 id）。 */
const attachmentUrl = id => `/api/bot-issue?attachment=${id}`;
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
    assignee: row.assigneeSessionId
      ? { sessionId: row.assigneeSessionId, name: row.assigneeName || null, at: row.assignedAt || null }
      : null,
  };
}

function assertTitle(title) {
  if (typeof title !== 'string' || !title.trim()) throw failure('INVALID_TITLE', '标题不能为空');
  return title.trim().slice(0, 200);
}

/** 附件（图片）的限制：只收图片，单张 10MB 以内。 */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
const ATTACHMENT_MIME = /^image\/(png|jpeg|jpg|gif|webp|svg\+xml)$/;

export function openIssueStore({ dbPath, attachmentsDir = null }) {
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
      result        TEXT,
      assigneeSessionId TEXT,
      assigneeName  TEXT,
      assignedAt    INTEGER
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
    CREATE TABLE IF NOT EXISTS tags (
      name      TEXT PRIMARY KEY,
      createdAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS issue_tags (
      issueId TEXT NOT NULL,
      tag     TEXT NOT NULL,
      UNIQUE (issueId, tag)
    );
    CREATE INDEX IF NOT EXISTS idx_issue_tags_tag ON issue_tags (tag);
    CREATE TABLE IF NOT EXISTS attachments (
      id        TEXT PRIMARY KEY,
      issueId   TEXT,
      name      TEXT NOT NULL DEFAULT '',
      mime      TEXT NOT NULL,
      bytes     INTEGER NOT NULL,
      createdAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS issue_links (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      issueId   TEXT NOT NULL,
      dependsOn TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      UNIQUE (issueId, dependsOn)
    );
    CREATE INDEX IF NOT EXISTS idx_issue_links_dep ON issue_links (dependsOn);
    -- 已读版本按事务保存在服务端：换浏览器、域名或登录状态后仍然有效。
    CREATE TABLE IF NOT EXISTS issue_seen (
      issueId   TEXT PRIMARY KEY,
      version   INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
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
  // Migration: 执行人字段（派工后记录承接 bot；旧事务为 NULL）。
  if (!existingCols.includes('assigneeSessionId')) db.exec('ALTER TABLE issues ADD COLUMN assigneeSessionId TEXT');
  if (!existingCols.includes('assigneeName')) db.exec('ALTER TABLE issues ADD COLUMN assigneeName TEXT');
  if (!existingCols.includes('assignedAt')) db.exec('ALTER TABLE issues ADD COLUMN assignedAt INTEGER');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_issues_number ON issues(number)');

  // Migration: early boards wrote status comments with raw ids (状态：open → dispatched).
  // Rewrite them once so the timeline reads the same everywhere (panel, tools, exports).
  const legacy = db.prepare("SELECT id, body FROM comments WHERE kind = 'status' AND body LIKE '状态：%'").all();
  const rewrite = db.prepare('UPDATE comments SET body = ? WHERE id = ?');
  for (const row of legacy) {
    const friendly = row.body.replace(STATUS_WORD_RE, word => STATUS_LABELS[word] || word);
    if (friendly !== row.body) rewrite.run(friendly, row.id);
  }

  // 附件落在库旁边的 attachments/ 目录，库里只存元数据（id/名字/mime/字节数）。
  const filesDir = attachmentsDir || (dbPath === ':memory:' ? null : path.join(dirname(dbPath), 'attachments'));
  const selectAttachment = db.prepare('SELECT * FROM attachments WHERE id = ?');
  const selectSeen = db.prepare('SELECT issueId, version FROM issue_seen');
  const upsertSeen = db.prepare(`
    INSERT INTO issue_seen (issueId, version, updatedAt) VALUES (?, ?, ?)
    ON CONFLICT(issueId) DO UPDATE SET version = excluded.version, updatedAt = excluded.updatedAt
    WHERE excluded.version > issue_seen.version`);
  const insertAttachment = db.prepare(
    'INSERT INTO attachments (id, issueId, name, mime, bytes, createdAt) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING');

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
  const updateAssignee = db.prepare('UPDATE issues SET assigneeSessionId = ?, assigneeName = ?, assignedAt = ?, updatedAt = ?, version = version + 1 WHERE id = ?');
  // Insertion order, not alphabetical: the chips should keep the order people made them.
  const selectTagLib = db.prepare('SELECT name FROM tags ORDER BY createdAt ASC, rowid ASC');
  const insertTagLib = db.prepare('INSERT INTO tags (name, createdAt) VALUES (?, ?) ON CONFLICT(name) DO NOTHING');
  const deleteTagLib = db.prepare('DELETE FROM tags WHERE name = ?');
  const selectIssueTags = db.prepare('SELECT tag FROM issue_tags WHERE issueId = ? ORDER BY rowid ASC');
  const insertIssueTag = db.prepare('INSERT INTO issue_tags (issueId, tag) VALUES (?, ?) ON CONFLICT DO NOTHING');
  const deleteIssueTags = db.prepare('DELETE FROM issue_tags WHERE issueId = ?');
  const deleteTagFromAll = db.prepare('DELETE FROM issue_tags WHERE tag = ?');
  const selectDependsOnIds = db.prepare('SELECT dependsOn FROM issue_links WHERE issueId = ?');
  const selectLinksOut = db.prepare(`
    SELECT i.id, i.number, i.title, i.status FROM issue_links l JOIN issues i ON i.id = l.dependsOn
    WHERE l.issueId = ? ORDER BY i.number ASC`);
  const selectLinksIn = db.prepare(`
    SELECT i.id, i.number, i.title, i.status FROM issue_links l JOIN issues i ON i.id = l.issueId
    WHERE l.dependsOn = ? ORDER BY i.number ASC`);
  const insertLink = db.prepare('INSERT INTO issue_links (issueId, dependsOn, createdAt) VALUES (?, ?, ?) ON CONFLICT DO NOTHING');
  const deleteLink = db.prepare('DELETE FROM issue_links WHERE issueId = ? AND dependsOn = ?');

  // Migration: labels used to be one free-text `issues.type`. Move every value
  // into the tag library and the join table so tags can be listed and deleted.
  for (const row of db.prepare("SELECT id, type FROM issues WHERE type IS NOT NULL AND type <> ''").all()) {
    const name = String(row.type).trim().slice(0, TAG_MAX_LEN);
    if (!name) continue;
    insertTagLib.run(name, now());
    insertIssueTag.run(row.id, name);
  }

  /** Accepts an internal id (`I-xxxx`) or a human ref (`#12` / `12`). */
  function requireIssue(id) {
    const text = typeof id === 'string' ? id.trim() : id;
    const numeric = typeof text === 'string' ? text.match(/^#?(\d+)$/) : null;
    const row = numeric ? selectIssueByNumber.get(Number(numeric[1])) : selectIssue.get(text);
    if (!row) throw failure('NOT_FOUND', `找不到 issue：${id}`);
    return row;
  }

  /** Labels of one issue, in the order they were attached. */
  function tagsOf(issueId) {
    return selectIssueTags.all(issueId).map(row => row.tag);
  }

  /** Labels of several issues in one query, so the list stays one round trip. */
  function tagsOfMany(ids) {
    const map = new Map();
    if (!ids.length) return map;
    const placeholders = ids.map(() => '?').join(',');
    const rows = db.prepare(`SELECT issueId, tag FROM issue_tags WHERE issueId IN (${placeholders}) ORDER BY rowid ASC`).all(...ids);
    for (const row of rows) {
      const list = map.get(row.issueId) || [];
      list.push(row.tag);
      map.set(row.issueId, list);
    }
    return map;
  }

  /** Unclosed dependencies (issues that must be done first), as refs. */
  function openDepsOf(issueId) {
    return db.prepare(`
      SELECT i.id, i.number, i.title, i.status FROM issue_links l JOIN issues i ON i.id = l.dependsOn
      WHERE l.issueId = ? AND i.status <> 'done' ORDER BY i.number ASC`).all(issueId);
  }

  /** Open-dependency counts for several issues in one query. */
  function openDepsOfMany(ids) {
    const map = new Map();
    if (!ids.length) return map;
    const placeholders = ids.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT l.issueId AS issueId, COUNT(*) AS n FROM issue_links l JOIN issues i ON i.id = l.dependsOn
      WHERE l.issueId IN (${placeholders}) AND i.status <> 'done' GROUP BY l.issueId`).all(...ids);
    for (const row of rows) map.set(row.issueId, row.n);
    return map;
  }

  /** Replace an issue's labels; also guarantees every label exists in the library. */
  function writeTags(issueId, tags) {
    const clean = normalizeTags(tags);
    deleteIssueTags.run(issueId);
    const at = now();
    for (const name of clean) {
      insertTagLib.run(name, at);
      insertIssueTag.run(issueId, name);
    }
    return clean;
  }

  const depRef = row => ({ id: row.id, number: row.number, title: row.title, status: row.status });

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
    const dependsOn = selectLinksOut.all(issue.id).map(depRef);
    const blocks = selectLinksIn.all(issue.id).map(depRef);
    return {
      ...issue,
      tags: tagsOf(issue.id),
      dependsOn,
      blocks,
      depsOpen: dependsOn.filter(dep => dep.status !== 'done').length,
      comments,
      dispatches,
    };
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
        // `type` is the single-label legacy name for the same thing `tag` means.
        clauses.push('EXISTS (SELECT 1 FROM issue_tags t WHERE t.issueId = issues.id AND t.tag = ?)');
        params.push(type.trim().slice(0, TAG_MAX_LEN));
      }
      const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
      rows = db.prepare(`SELECT * FROM issues${where} ORDER BY createdAt DESC`).all(...params);
    }
    const total = rows.length;
    const size = Math.max(1, limit);
    const start = Math.max(0, offset);
    const items = rows.slice(start, start + size).map(issueFrom);
    const tagMap = tagsOfMany(items.map(item => item.id));
    const depMap = openDepsOfMany(items.map(item => item.id));
    return {
      items: items.map(item => ({ ...item, tags: tagMap.get(item.id) || [], depsOpen: depMap.get(item.id) || 0 })),
      total,
    };
  }

  function create({ title, body = '', parentId = null, tags = null, type = null, createdBy = 'user', createdByName = '' }) {
    title = assertTitle(title);
    if (!VALID_KINDS.has(createdBy)) createdBy = 'user';
    if (parentId) parentId = requireIssue(parentId).id; // parent must exist (accepts #N)
    const id = shortId();
    const at = now();
    const number = nextNumber.get().n;
    const cleanTags = normalizeTags(tags !== null && tags !== undefined ? tags : type);
    // `type` column stays as a mirror of the first label, for older readers.
    insertIssue.run(id, number, title, String(body || ''), 'open', parentId || null, cleanTags[0] ?? null, createdBy, String(createdByName || ''), at, at);
    writeTags(id, cleanTags);
    return { ...issueFrom(selectIssue.get(id)), tags: cleanTags };
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
    // 闭环认可：验收通过（in_review→done）与打回重做（in_review→dispatched）只有
    // 主 Bot 或人能决定——工作者不能自己验收自己，也不能替主 Bot 打回。
    const isReviewer = actor.kind === 'user' || actor.isMain === true;
    if (next !== from && from === 'in_review' && (next === 'done' || next === 'dispatched') && !isReviewer) {
      throw failure('FORBIDDEN_TRANSITION', `只有主 Bot 或用户能「${statusLabel(next)}」（当前是「${statusLabel(from)}」）`);
    }
    // 打回必须带打回意见，意见会写进时间线（kind='reject'），让经办人知道哪里要重做。
    if (next !== from && from === 'in_review' && next === 'dispatched') {
      if (typeof patch.rejection !== 'string' || !patch.rejection.trim()) {
        throw failure('REJECTION_REQUIRED', '打回必须写打回意见');
      }
    }
    // Completing an issue is gated on its dependencies AND its children: a parent
    // can't be done while a sub-issue is still open.
    if (next !== from && next === 'done') {
      const blocking = openDepsOf(id);
      if (blocking.length) {
        throw failure('BLOCKED_BY_DEPS', `前置还没闭环，不能验收通过：${blocking.map(issueRef).join('、')}`);
      }
      const openChildren = selectChildren.all(id).filter(child => !TERMINAL_STATUSES.includes(child.status));
      if (openChildren.length) {
        throw failure('BLOCKED_BY_CHILDREN', `还有 ${openChildren.length} 个子事务没闭环，不能验收通过：${openChildren.map(issueRef).join('、')}`);
      }
      // 验收通过必须写验收意见（result）：只看状态位不算验收。
      if (typeof patch.result !== 'string' || !patch.result.trim()) {
        throw failure('RESULT_REQUIRED', '验收通过必须写验收意见（result）');
      }
    }
    const title = patch.title !== undefined ? assertTitle(patch.title) : row.title;
    const body = patch.body !== undefined ? String(patch.body) : row.body;
    // 重开（done/failed/cancelled → 活跃状态）时清掉旧的 result，避免读到过期结论。
    const reopening = next !== from && TERMINAL_STATUSES.includes(from) && !TERMINAL_STATUSES.includes(next);
    const result = patch.result !== undefined
      ? (patch.result === null ? null : String(patch.result))
      : (reopening ? null : row.result);
    // `tags` (array, replaces everything) wins; `type` is the single-label alias.
    const nextTags = patch.tags !== undefined
      ? normalizeTags(patch.tags)
      : (patch.type !== undefined ? normalizeTags(patch.type) : null);
    const type = nextTags ? (nextTags[0] ?? null) : row.type;
    const closedAt = TERMINAL_STATUSES.includes(next)
      ? (row.closedAt ?? now())
      : (next === 'open' && row.closedAt ? null : row.closedAt);
    db.prepare(`UPDATE issues SET title = ?, body = ?, type = ?, status = ?, result = ?, closedAt = ?, updatedAt = ?, version = version + 1 WHERE id = ?`)
      .run(title, body, type, next, result, closedAt, now(), id);
    if (nextTags) writeTags(id, nextTags);
    const updated = { ...issueFrom(selectIssue.get(id)), tags: nextTags ?? tagsOf(id) };
    if (next !== from) {
      insertComment.run(id, actor.kind || 'system', actor.name || '', `状态：${statusLabel(from)} → ${statusLabel(next)}`, 'status', now());
      if (from === 'in_review' && next === 'dispatched') {
        insertComment.run(id, actor.kind || 'system', actor.name || '', patch.rejection.trim(), 'reject', now());
      }
    }
    return updated;
  }

  /**
   * 指派执行人：记录哪个 Bot 承接了这条事务。只有主 Bot 或人（面板）能指派/改派。
   * 变更时写一条 `assign` 时间线评论，方便追溯「谁在什么时间接的活」。
   */
  function assign(id, { sessionId, name }, actor = {}) {
    const row = requireIssue(id);
    id = row.id; // accept #N
    if (!(actor.kind === 'user' || actor.isMain === true)) throw failure('FORBIDDEN_ASSIGN', '只有主 Bot 或用户能指派执行人');
    if (typeof sessionId !== 'string' || !sessionId.trim()) throw failure('INVALID_ASSIGNEE', '缺少执行人 sessionId');
    const sid = sessionId.trim();
    const label = typeof name === 'string' && name.trim() ? name.trim() : sid;
    const at = now();
    if (row.assigneeSessionId === sid && row.assigneeName === label) return getFull(id); // 没变，no-op
    updateAssignee.run(sid, label, at, now(), id);
    insertComment.run(id, 'system', '', row.assigneeName ? `执行人：${row.assigneeName} → ${label}` : `执行人：${label}`, 'assign', at);
    return getFull(id);
  }

  /**
   * 存一张图：base64 → 文件（按内容 hash 命名，重复上传天然去重）+ 一行元数据。
   * 返回可直接放进 markdown 的 url。
   */
  function addAttachment({ issueId = null, name = '', mime, data }) {
    if (!filesDir) throw failure('NO_ATTACHMENTS_DIR', '这个库没有配置附件目录');
    if (typeof mime !== 'string' || !ATTACHMENT_MIME.test(mime)) throw failure('INVALID_MIME', `只支持图片：${mime || '(空)'}`);
    const base64 = typeof data === 'string' ? data.replace(/^data:[^;]+;base64,/, '') : '';
    if (!base64) throw failure('INVALID_DATA', '图片内容是空的');
    let buffer;
    try { buffer = Buffer.from(base64, 'base64'); } catch { throw failure('INVALID_DATA', '图片内容不是合法的 base64'); }
    if (!buffer.length) throw failure('INVALID_DATA', '图片内容是空的');
    if (buffer.length > ATTACHMENT_MAX_BYTES) throw failure('TOO_LARGE', `图片太大（${(buffer.length / 1024 / 1024).toFixed(1)}MB），上限 ${ATTACHMENT_MAX_BYTES / 1024 / 1024}MB`);
    const id = createHash('sha256').update(buffer).digest('hex').slice(0, 16);
    mkdirSync(filesDir, { recursive: true });
    writeFileSync(path.join(filesDir, id), buffer);
    const owner = issueId ? requireIssue(issueId).id : null;
    insertAttachment.run(id, owner, String(name || '').slice(0, 120), mime, buffer.length, now());
    return { id, url: attachmentUrl(id), name: String(name || ''), mime, bytes: buffer.length };
  }

  /** 附件元数据 + 磁盘路径；文件被删了就当没有。 */
  function getAttachment(id) {
    if (!filesDir) return null;
    const row = selectAttachment.get(String(id || ''));
    if (!row) return null;
    const filePath = path.join(filesDir, row.id);
    if (!existsSync(filePath)) return null;
    return { id: row.id, name: row.name, mime: row.mime, bytes: row.bytes, filePath };
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

  /** 每位执行人在手（进行中/待验收）事务数，负载均衡路由用。 */
  function loads() {
    const map = {};
    for (const row of db.prepare(`
      SELECT assigneeSessionId AS sid, COUNT(*) AS n FROM issues
      WHERE assigneeSessionId IS NOT NULL AND status IN ('dispatched', 'in_review')
      GROUP BY assigneeSessionId`).all()) {
      map[row.sid] = row.n;
    }
    return map;
  }

  /** 所有事务的轻量版本快照（id/编号/版本/更新时间），客户端未读角标用。 */
  function versions() {
    return db.prepare('SELECT id, number, version, updatedAt FROM issues ORDER BY updatedAt DESC, rowid DESC').all()
      .map(row => ({ id: row.id, number: row.number, version: row.version, updatedAt: row.updatedAt }));
  }

  /** 服务端已读版本：{ [issueId]: lastSeenVersion }。 */
  function seen() {
    return Object.fromEntries(selectSeen.all().map(row => [row.issueId, row.version]));
  }

  /** 标记一条事务已读，只前进、不回退，也不修改事务自身的 version。 */
  function markSeen(id, version) {
    const issue = requireIssue(id);
    if (!Number.isSafeInteger(version) || version < 0) throw failure('INVALID_SEEN_VERSION', '已读版本必须是非负整数');
    upsertSeen.run(issue.id, version, now());
    return seen();
  }

  /** 批量迁移浏览器里的旧已读记录；同样只能前进。 */
  function markSeenMany(entries) {
    for (const [id, version] of Object.entries(entries || {})) markSeen(id, version);
    return seen();
  }

  /** The label library, for the picker's chips. */
  function tags() {
    return selectTagLib.all().map(row => row.name);
  }

  /** Add a label to the library (idempotent — an unused chip is still useful). */
  function createTag(name) {
    const clean = normalizeTags(name);
    if (!clean.length) throw failure('INVALID_TAG', '标签名不能为空');
    insertTagLib.run(clean[0], now());
    return tags();
  }

  /**
   * Delete a label from the library and detach it from every issue that used it.
   * Issues are never deleted; their remaining labels are kept.
   */
  function deleteTag(name) {
    const clean = normalizeTags(name);
    if (!clean.length) throw failure('INVALID_TAG', '标签名不能为空');
    const label = clean[0];
    const affected = db.prepare('SELECT DISTINCT issueId FROM issue_tags WHERE tag = ?').all(label).map(row => row.issueId);
    deleteTagFromAll.run(label);
    deleteTagLib.run(label);
    const syncType = db.prepare('UPDATE issues SET type = (SELECT tag FROM issue_tags WHERE issueId = ? ORDER BY rowid ASC LIMIT 1) WHERE id = ?');
    for (const issueId of affected) syncType.run(issueId, issueId);
    return { tags: tags(), detached: affected.length };
  }

  /** Every issue reachable by following `dependsOn` edges from `startId`. */
  function dependsOnIds(startId) {
    const seen = new Set([startId]);
    const stack = [startId];
    while (stack.length) {
      for (const row of selectDependsOnIds.all(stack.pop())) {
        if (seen.has(row.dependsOn)) continue;
        seen.add(row.dependsOn);
        stack.push(row.dependsOn);
      }
    }
    return seen;
  }

  /**
   * `id` depends on `dependsOn` (B must be done before A can be done).
   * Rejects self-links and cycles: A→B is refused when B already reaches A.
   */
  function link(id, dependsOn) {
    const issue = requireIssue(id);
    const dep = requireIssue(dependsOn);
    if (issue.id === dep.id) throw failure('SELF_LINK', '事务不能依赖自己');
    if (dependsOnIds(dep.id).has(issue.id)) {
      throw failure('LINK_CYCLE', `会形成循环依赖：${issueRef(issue)} 依赖 ${issueRef(dep)}，而 ${issueRef(dep)} 已经（间接）依赖 ${issueRef(issue)}`);
    }
    // A closed issue cannot gain an unfinished prerequisite — reopen it first,
    // otherwise the board would claim "done" over work that is not there.
    if (issue.status === 'done' && dep.status !== 'done') {
      throw failure('ISSUE_CLOSED', `${issueRef(issue)} 已闭环，不能再挂没完成的前置 ${issueRef(dep)}；先重开它再加依赖`);
    }
    insertLink.run(issue.id, dep.id, now());
    touch.run(now(), issue.id);
    return getFull(issue.id);
  }

  /** Drop one dependency edge. */
  function unlink(id, dependsOn) {
    const issue = requireIssue(id);
    const dep = requireIssue(dependsOn);
    deleteLink.run(issue.id, dep.id);
    touch.run(now(), issue.id);
    return getFull(issue.id);
  }

  return {
    list, get: getFull, create, update, comment, activeDispatch, syncTask, counts,
    assign, loads, versions, seen, markSeen, markSeenMany,
    addAttachment, getAttachment,
    tags, createTag, deleteTag, link, unlink,
    /** Back-compat: the old name for the label library. */
    types: tags,
    close() { try { db.close(); } catch { /* already closed */ } },
  };
}
