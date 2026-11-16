import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openIssueStore, STATUSES } from '../lib/store.js';

function fresh() {
  return openIssueStore({ dbPath: ':memory:' });
}

test('create returns an open issue', () => {
  const store = fresh();
  const issue = store.create({ title: '上线发布', body: '把新版本发到生产', createdBy: 'user', createdByName: '我' });
  assert.equal(issue.status, 'open');
  assert.equal(issue.version, 1);
  assert.ok(issue.id.startsWith('I-'));
  assert.equal(issue.title, '上线发布');
  store.close();
});

test('list filters by status', () => {
  const store = fresh();
  const a = store.create({ title: 'A' });
  const b = store.create({ title: 'B' });
  store.update(b.id, { status: 'discussing' });
  const open = store.list({ status: 'open' });
  assert.equal(open.total, 1);
  assert.equal(open.items[0].id, a.id);
  const all = store.list();
  assert.equal(all.total, 2);
  store.close();
});

test('get returns comments and dispatches arrays', () => {
  const store = fresh();
  const issue = store.create({ title: 'X' });
  const full = store.get(issue.id);
  assert.deepEqual(full.comments, []);
  assert.deepEqual(full.dispatches, []);
  store.close();
});

test('state machine rejects illegal transitions', () => {
  const store = fresh();
  const issue = store.create({ title: 'X' });
  assert.throws(() => store.update(issue.id, { status: 'done' }), /不能从「待处理」直接到「已闭环」/);
  const moved = store.update(issue.id, { status: 'discussing' });
  assert.equal(moved.status, 'discussing');
  // a status change is recorded in the timeline
  const full = store.get(issue.id);
  assert.equal(full.comments.length, 1);
  assert.equal(full.comments[0].kind, 'status');
  // 时间线是写给人看的：状态用中文名，不暴露 open/dispatched 这类变量名
  assert.equal(full.comments[0].body, '状态：待处理 → 讨论中');
  store.close();
});

test('dispatched can be pulled back to open (打回)', () => {
  const store = fresh();
  const issue = store.create({ title: 'X' });
  store.update(issue.id, { status: 'dispatched' });
  const back = store.update(issue.id, { status: 'open' });
  assert.equal(back.status, 'open');
  store.close();
});

test('system status writes use Chinese labels too', () => {
  const store = fresh();
  const issue = store.create({ title: 'X' });
  store.syncTask(issue.id, { taskId: 'T-1', status: 'dispatched' });
  store.syncTask(issue.id, { taskId: 'T-1', status: 'done', resultText: '做完了', workerName: '玉清' });
  const full = store.get(issue.id);
  const statusBodies = full.comments.filter(c => c.kind === 'status').map(c => c.body);
  assert.deepEqual(statusBodies, ['状态：待处理 → 进行中', '状态：进行中 → 待验收']);
  store.close();
});

test('old raw-status comments are rewritten to Chinese labels when the board opens', () => {
  const dir = mkdtempSync(join(tmpdir(), 'issue-labels-'));
  const dbPath = join(dir, 'issue.sqlite');
  let store = openIssueStore({ dbPath });
  const issue = store.create({ title: 'X' });
  store.close();
  const db = new DatabaseSync(dbPath);
  db.prepare("INSERT INTO comments (issueId, authorKind, authorName, body, kind, at) VALUES (?, 'system', '', '状态：open → dispatched', 'status', 1)").run(issue.id);
  db.close();
  store = openIssueStore({ dbPath });
  const bodies = store.get(issue.id).comments.filter(c => c.kind === 'status').map(c => c.body);
  assert.deepEqual(bodies, ['状态：待处理 → 进行中']);
  store.close();
  // reopening must not touch it again
  store = openIssueStore({ dbPath });
  assert.deepEqual(store.get(issue.id).comments.filter(c => c.kind === 'status').map(c => c.body), ['状态：待处理 → 进行中']);
  store.close();
});

test('version guard refuses stale writes', () => {
  const store = fresh();
  const issue = store.create({ title: 'X' });
  assert.throws(() => store.update(issue.id, { status: 'discussing', expectedVersion: 99 }), err => err.code === 'VERSION_CONFLICT');
  store.close();
});

test('syncTask records a live task and marks the issue dispatched', () => {
  const store = fresh();
  const issue = store.create({ title: 'X' });
  store.syncTask(issue.id, { taskId: 'T-abc', workerSessionId: 's1', status: 'running' });
  const full = store.get(issue.id);
  assert.equal(full.status, 'dispatched');
  assert.equal(full.dispatches.length, 1);
  assert.equal(full.dispatches[0].taskId, 'T-abc');
  assert.ok(store.activeDispatch(issue.id));
  store.close();
});

test('syncTask done sends issue to in_review with a result comment', () => {
  const store = fresh();
  const issue = store.create({ title: 'X' });
  store.syncTask(issue.id, { taskId: 'T-abc', status: 'running' });
  const full = store.syncTask(issue.id, { taskId: 'T-abc', status: 'done', resultText: '已上线，共 12 台机器。' });
  assert.equal(full.status, 'in_review');
  assert.ok(full.comments.some(c => c.kind === 'result' && /12 台/.test(c.body)));
  assert.equal(full.dispatches[0].status, 'done');
  assert.equal(store.activeDispatch(issue.id), null);
  store.close();
});

test('syncTask is idempotent', () => {
  const store = fresh();
  const issue = store.create({ title: 'X' });
  store.syncTask(issue.id, { taskId: 'T-abc', status: 'done', resultText: '结果' });
  const again = store.syncTask(issue.id, { taskId: 'T-abc', status: 'done', resultText: '重复' });
  assert.equal(again.comments.filter(c => c.kind === 'result').length, 1);
  store.close();
});

test('syncTask failed sends issue to failed', () => {
  const store = fresh();
  const issue = store.create({ title: 'X' });
  store.syncTask(issue.id, { taskId: 'T-abc', status: 'failed', resultText: '做不了' });
  assert.equal(store.get(issue.id).status, 'failed');
  store.close();
});

test('syncTask leaves a human-closed issue alone', () => {
  const store = fresh();
  const issue = store.create({ title: 'X' });
  store.update(issue.id, { status: 'cancelled' });
  const full = store.syncTask(issue.id, { taskId: 'T-abc', status: 'done', resultText: '迟到的结果' });
  assert.equal(full.status, 'cancelled'); // 不覆盖人工关闭
  assert.ok(full.comments.some(c => c.kind === 'result' && /迟到的结果/.test(c.body)));
  store.close();
});

test('sub-issue hangs under a parent', () => {
  const store = fresh();
  const parent = store.create({ title: '父' });
  const child = store.create({ title: '子', parentId: parent.id });
  const kids = store.list({ parentId: parent.id });
  assert.equal(kids.total, 1);
  assert.equal(kids.items[0].id, child.id);
  store.close();
});

test('parentId must exist', () => {
  const store = fresh();
  assert.throws(() => store.create({ title: 'X', parentId: 'I-missing' }), err => err.code === 'NOT_FOUND');
  store.close();
});

test('statuses exported for the UI', () => {
  assert.ok(STATUSES.includes('in_review'));
});

test('counts returns per-status totals', () => {
  const store = fresh();
  store.create({ title: 'A' });
  store.create({ title: 'B' });
  const c = store.create({ title: 'C' });
  store.update(c.id, { status: 'discussing' });
  const counts = store.counts();
  assert.equal(counts.open, 2);
  assert.equal(counts.discussing, 1);
  store.close();
});

test('create stores a custom type and types() lists the distinct ones', () => {
  const store = fresh();
  const a = store.create({ title: 'A', type: 'bug' });
  assert.equal(a.type, 'bug');
  store.create({ title: 'B', type: 'feature' });
  store.create({ title: 'C', type: 'bug' });
  assert.deepEqual(store.types().sort(), ['bug', 'feature']);
  store.close();
});

test('type can be edited', () => {
  const store = fresh();
  const a = store.create({ title: 'A' });
  assert.equal(a.type, null);
  const b = store.update(a.id, { type: '优化' });
  assert.equal(b.type, '优化');
  store.close();
});

test('an old board without the type column gets it on open', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mig-'));
  const dbPath = join(dir, 'old.sqlite');
  const old = new DatabaseSync(dbPath);
  old.exec(`CREATE TABLE issues (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'open', parentId TEXT, createdBy TEXT NOT NULL, createdByName TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, closedAt INTEGER, result TEXT)`);
  old.close();
  const store = openIssueStore({ dbPath });
  const issue = store.create({ title: 'X', type: 'bug' });
  assert.equal(issue.type, 'bug');
  store.close();
});

test('result comment records the actual handler name (not "worker")', () => {
  const store = fresh();
  const issue = store.create({ title: 'X' });
  store.syncTask(issue.id, { taskId: 'T-abc', status: 'done', resultText: '做完了', workerName: '玉清' });
  const full = store.get(issue.id);
  const result = full.comments.find(c => c.kind === 'result');
  assert.equal(result.authorName, '玉清');
  store.close();
});

test('issues get sequential #numbers starting at 1', () => {
  const store = fresh();
  const a = store.create({ title: 'A' });
  const b = store.create({ title: 'B' });
  const c = store.create({ title: 'C' });
  assert.equal(a.number, 1);
  assert.equal(b.number, 2);
  assert.equal(c.number, 3);
  store.close();
});

test('a #N reference resolves to the issue for get/update/comment', () => {
  const store = fresh();
  const a = store.create({ title: 'A' });
  store.create({ title: 'B' });
  assert.equal(store.get(`#${a.number}`).id, a.id);
  assert.equal(store.get(String(a.number)).id, a.id);
  assert.equal(store.update(`#${a.number}`, { status: 'discussing' }).status, 'discussing');
  assert.equal(store.comment(`#${a.number}`, { body: 'hi', authorKind: 'user' }).issueId, a.id);
  assert.throws(() => store.get('#999'), err => err.code === 'NOT_FOUND');
  store.close();
});

test('an old board backfills #numbers in creation order', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mig2-'));
  const dbPath = join(dir, 'old.sqlite');
  const old = new DatabaseSync(dbPath);
  old.exec(`CREATE TABLE issues (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'open', parentId TEXT, createdBy TEXT NOT NULL, createdByName TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, closedAt INTEGER, result TEXT)`);
  const insert = old.prepare('INSERT INTO issues (id, title, body, status, createdBy, version, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  insert.run('I-old1', '老一', '', 'open', 'user', 1, 1000, 1000);
  insert.run('I-old2', '老二', '', 'open', 'user', 1, 2000, 2000);
  old.close();
  const store = openIssueStore({ dbPath });
  const byId = Object.fromEntries(store.list().items.map(issue => [issue.id, issue.number]));
  assert.equal(byId['I-old1'], 1);
  assert.equal(byId['I-old2'], 2);
  store.close();
});

// ---- 标签（tag）：多选、可新建、可删除 ----

test('tags: create stores several labels and the library knows them', () => {
  const store = fresh();
  const issue = store.create({ title: 'X', tags: ['bug', 'P0'] });
  assert.deepEqual(issue.tags, ['bug', 'P0']);
  assert.equal(issue.type, 'bug'); // legacy mirror = first label
  assert.deepEqual(store.tags(), ['bug', 'P0']);
  store.close();
});

test('tags: the library keeps an unused label and delete detaches it from issues', () => {
  const store = fresh();
  const issue = store.create({ title: 'X', tags: ['bug', 'P0'] });
  store.createTag('调研');
  assert.deepEqual(store.tags(), ['bug', 'P0', '调研']);

  const removed = store.deleteTag('bug');
  assert.equal(removed.detached, 1);
  assert.deepEqual(removed.tags, ['P0', '调研']);
  const after = store.get(issue.id);
  assert.deepEqual(after.tags, ['P0']);
  assert.equal(after.type, 'P0'); // mirror follows the remaining first label
  store.close();
});

test('tags: update replaces the whole set, and an empty array clears it', () => {
  const store = fresh();
  const issue = store.create({ title: 'X', tags: ['bug'] });
  assert.deepEqual(store.update(issue.id, { tags: ['优化', '文档'] }).tags, ['优化', '文档']);
  assert.equal(store.get(issue.id).type, '优化');
  assert.deepEqual(store.update(issue.id, { tags: [] }).tags, []);
  assert.equal(store.get(issue.id).type, null);
  store.close();
});

test('tags: list filters by tag and carries the label list', () => {
  const store = fresh();
  const a = store.create({ title: 'A', tags: ['bug'] });
  store.create({ title: 'B', tags: ['优化'] });
  const filtered = store.list({ type: 'bug' });
  assert.equal(filtered.total, 1);
  assert.deepEqual(filtered.items[0].tags, ['bug']);
  assert.equal(filtered.items[0].id, a.id);
  store.close();
});

test('tags: an old board with only issues.type migrates its labels', () => {
  const dir = mkdtempSync(join(tmpdir(), 'issue-tags-'));
  const dbPath = join(dir, 'issue.sqlite');
  let store = openIssueStore({ dbPath });
  const issue = store.create({ title: 'X' });
  store.close();
  const db = new DatabaseSync(dbPath);
  db.prepare("UPDATE issues SET type = 'bug' WHERE id = ?").run(issue.id);
  db.close();
  store = openIssueStore({ dbPath });
  assert.deepEqual(store.get(issue.id).tags, ['bug']);
  assert.deepEqual(store.tags(), ['bug']);
  store.close();
});

// ---- 依赖（A 依赖 B：B 完成 A 才能完成）----

test('deps: link shows up on both sides', () => {
  const store = fresh();
  const a = store.create({ title: 'A' });
  const b = store.create({ title: 'B' });
  const linked = store.link(a.id, b.id);
  assert.deepEqual(linked.dependsOn.map(d => d.title), ['B']);
  assert.equal(linked.depsOpen, 1);
  const reverse = store.get(b.id);
  assert.deepEqual(reverse.blocks.map(d => d.title), ['A']);
  store.close();
});

test('deps: self link and cycles are refused', () => {
  const store = fresh();
  const a = store.create({ title: 'A' });
  const b = store.create({ title: 'B' });
  const c = store.create({ title: 'C' });
  assert.throws(() => store.link(a.id, a.id), err => err.code === 'SELF_LINK');
  store.link(a.id, b.id);
  store.link(b.id, c.id);
  assert.throws(() => store.link(c.id, a.id), err => err.code === 'LINK_CYCLE');
  store.close();
});

test('deps: done is blocked while a dependency is unfinished', () => {
  const store = fresh();
  const a = store.create({ title: 'A' });
  const b = store.create({ title: 'B' });
  store.link(a.id, b.id);
  store.update(a.id, { status: 'dispatched' });
  store.update(a.id, { status: 'in_review' });
  assert.throws(() => store.update(a.id, { status: 'done' }), err => {
    assert.equal(err.code, 'BLOCKED_BY_DEPS');
    assert.match(err.message, /#2「B」/);
    return true;
  });
  // B closes its loop, then A can complete.
  store.update(b.id, { status: 'dispatched' });
  store.update(b.id, { status: 'in_review' });
  store.update(b.id, { status: 'done' });
  assert.equal(store.update(a.id, { status: 'done' }).status, 'done');
  store.close();
});

test('deps: a cancelled dependency still blocks completion (not a back door)', () => {
  const store = fresh();
  const a = store.create({ title: 'A' });
  const b = store.create({ title: 'B' });
  store.link(a.id, b.id);
  store.update(b.id, { status: 'cancelled' });
  store.update(a.id, { status: 'dispatched' });
  store.update(a.id, { status: 'in_review' });
  assert.throws(() => store.update(a.id, { status: 'done' }), err => err.code === 'BLOCKED_BY_DEPS');
  store.close();
});

test('deps: unlink frees the issue and list carries depsOpen', () => {
  const store = fresh();
  const a = store.create({ title: 'A' });
  const b = store.create({ title: 'B' });
  store.link(a.id, b.id);
  assert.equal(store.list().items.find(i => i.id === a.id).depsOpen, 1);
  store.unlink(a.id, b.id);
  assert.equal(store.list().items.find(i => i.id === a.id).depsOpen, 0);
  store.update(a.id, { status: 'dispatched' });
  store.update(a.id, { status: 'in_review' });
  assert.equal(store.update(a.id, { status: 'done' }).status, 'done');
  store.close();
});

test('deps: a closed issue cannot gain an unfinished prerequisite', () => {
  const store = fresh();
  const a = store.create({ title: 'A' });
  const b = store.create({ title: 'B' });
  store.update(a.id, { status: 'dispatched' });
  store.update(a.id, { status: 'in_review' });
  store.update(a.id, { status: 'done' });
  assert.throws(() => store.link(a.id, b.id), err => err.code === 'ISSUE_CLOSED');
  // a finished prerequisite is fine
  store.update(b.id, { status: 'cancelled' });
  assert.throws(() => store.link(a.id, b.id), err => err.code === 'ISSUE_CLOSED');
  store.close();
});
