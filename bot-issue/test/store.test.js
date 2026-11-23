import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
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
  store.update(b.id, { status: 'discussing', note: '先讨论' });
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
  assert.throws(() => store.update(issue.id, { status: 'done', result: '验收通过' }), /不能从「待处理」直接到「已闭环」/);
  const moved = store.update(issue.id, { status: 'discussing', note: '先对齐方案' });
  assert.equal(moved.status, 'discussing');
  // a status change and its opinion are recorded in the timeline
  const full = store.get(issue.id);
  assert.equal(full.comments.length, 2);
  assert.equal(full.comments[0].kind, 'status');
  // 时间线是写给人看的：状态用中文名，不暴露 open/dispatched 这类变量名
  assert.equal(full.comments[0].body, '状态：待处理 → 讨论中');
  assert.equal(full.comments[1].kind, 'comment');
  assert.equal(full.comments[1].body, '先对齐方案');
  store.close();
});

test('dispatched can be pulled back to open (打回)', () => {
  const store = fresh();
  const issue = store.create({ title: 'X' });
  store.update(issue.id, { status: 'dispatched', note: '开始执行' }, { kind: 'user' });
  const back = store.update(issue.id, { status: 'open', note: '退回待处理' });
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
  assert.throws(() => store.update(issue.id, { status: 'discussing', note: '先讨论', expectedVersion: 99 }), err => err.code === 'VERSION_CONFLICT');
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
  store.update(issue.id, { status: 'cancelled', note: '人工取消' });
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
  store.update(c.id, { status: 'discussing', note: '先讨论' });
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
  assert.equal(store.update(`#${a.number}`, { status: 'discussing', note: '讨论' }).status, 'discussing');
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
  store.update(a.id, { status: 'dispatched', note: '开始执行' });
  store.update(a.id, { status: 'in_review', note: '提交验收' });
  assert.throws(() => store.update(a.id, { status: 'done', result: '验收通过' }, { kind: 'user' }), err => {
    assert.equal(err.code, 'BLOCKED_BY_DEPS');
    assert.match(err.message, /#2「B」/);
    return true;
  });
  // B closes its loop, then A can complete.
  store.update(b.id, { status: 'dispatched', note: '开始执行' });
  store.update(b.id, { status: 'in_review', note: '提交验收' });
  store.update(b.id, { status: 'done', result: '验收通过' }, { kind: 'user' });
  assert.equal(store.update(a.id, { status: 'done', result: '验收通过' }, { kind: 'user' }).status, 'done');
  store.close();
});

test('deps: a cancelled dependency still blocks completion (not a back door)', () => {
  const store = fresh();
  const a = store.create({ title: 'A' });
  const b = store.create({ title: 'B' });
  store.link(a.id, b.id);
  store.update(b.id, { status: 'cancelled', note: '取消前置' });
  store.update(a.id, { status: 'dispatched', note: '开始执行' });
  store.update(a.id, { status: 'in_review', note: '提交验收' });
  assert.throws(() => store.update(a.id, { status: 'done', result: '验收通过' }, { kind: 'user' }), err => err.code === 'BLOCKED_BY_DEPS');
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
  store.update(a.id, { status: 'dispatched', note: '开始执行' });
  store.update(a.id, { status: 'in_review', note: '提交验收' });
  assert.equal(store.update(a.id, { status: 'done', result: '验收通过' }, { kind: 'user' }).status, 'done');
  store.close();
});

test('deps: a closed issue cannot gain an unfinished prerequisite', () => {
  const store = fresh();
  const a = store.create({ title: 'A' });
  const b = store.create({ title: 'B' });
  store.update(a.id, { status: 'dispatched', note: '开始执行' });
  store.update(a.id, { status: 'in_review', note: '提交验收' });
  store.update(a.id, { status: 'done', result: '验收通过' }, { kind: 'user' });
  assert.throws(() => store.link(a.id, b.id), err => err.code === 'ISSUE_CLOSED');
  // a finished prerequisite is fine
  store.update(b.id, { status: 'cancelled', note: '取消' });
  assert.throws(() => store.link(a.id, b.id), err => err.code === 'ISSUE_CLOSED');
  store.close();
});

// ---- 附件（图片）----

test('attachments: 存图落到文件、返回可用的 url、按内容去重', () => {
  const dir = mkdtempSync(join(tmpdir(), 'issue-att-'));
  const store = openIssueStore({ dbPath: join(dir, 'issue.sqlite'), attachmentsDir: join(dir, 'attachments') });
  const issue = store.create({ title: 'X' });
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const first = store.addAttachment({ issueId: issue.id, name: '截图.png', mime: 'image/png', data: png.toString('base64') });
  assert.match(first.url, /^\/api\/bot-issue\?attachment=[0-9a-f]{16}$/);
  assert.equal(first.bytes, png.length);
  const file = store.getAttachment(first.id);
  assert.ok(file);
  assert.equal(file.mime, 'image/png');
  assert.equal(readFileSync(file.filePath).length, png.length);
  // 同一张图再传一次：同一个 id，不会写两份
  const again = store.addAttachment({ name: '再来一张', mime: 'image/png', data: png.toString('base64') });
  assert.equal(again.id, first.id);
  store.close();
});

test('attachments: 只收图片、空内容/超大内容会被拒', () => {
  const dir = mkdtempSync(join(tmpdir(), 'issue-att-'));
  const store = openIssueStore({ dbPath: join(dir, 'issue.sqlite'), attachmentsDir: join(dir, 'attachments') });
  assert.throws(() => store.addAttachment({ mime: 'application/pdf', data: 'AAAA' }), err => err.code === 'INVALID_MIME');
  assert.throws(() => store.addAttachment({ mime: 'image/png', data: '' }), err => err.code === 'INVALID_DATA');
  assert.throws(() => store.addAttachment({ mime: 'image/png', data: Buffer.alloc(11 * 1024 * 1024).toString('base64') }), err => err.code === 'TOO_LARGE');
  assert.equal(store.getAttachment('nope'), null);
  store.close();
});

// ---- 执行人 / 负载 / versions（Task 1）----

test('assign 把执行人落到事务上并可通过 get 读回', () => {
  const store = fresh();
  const issue = store.create({ title: '看图' });
  store.assign(issue.id, { sessionId: 's-1', name: '伟峰' }, { kind: 'user', name: '用户' });
  const full = store.get(issue.id);
  assert.equal(full.assignee.sessionId, 's-1');
  assert.equal(full.assignee.name, '伟峰');
  assert.equal(typeof full.assignee.at, 'number');
  // 指派写进时间线
  assert.ok(full.comments.some(c => c.kind === 'assign' && c.body.includes('伟峰')));
  store.close();
});

test('assign 非主 Bot/人 抛 FORBIDDEN_ASSIGN', () => {
  const store = fresh();
  const issue = store.create({ title: 'X' });
  assert.throws(() => store.assign(issue.id, { sessionId: 's-1', name: '伟峰' }, { kind: 'agent', name: '玉清', isMain: false }), err => err.code === 'FORBIDDEN_ASSIGN');
  assert.throws(() => store.assign(issue.id, { sessionId: 's-1', name: '伟峰' }, { kind: 'system', name: '' }), err => err.code === 'FORBIDDEN_ASSIGN');
  store.close();
});

test('assign 缺 sessionId 抛 INVALID_ASSIGNEE', () => {
  const store = fresh();
  const issue = store.create({ title: 'X' });
  assert.throws(() => store.assign(issue.id, { sessionId: '', name: 'x' }, { kind: 'user' }), err => err.code === 'INVALID_ASSIGNEE');
  store.close();
});

test('loads 只统计进行中/待验收的指派事务', () => {
  const store = fresh();
  const a = store.create({ title: 'A' });
  const b = store.create({ title: 'B' });
  const c = store.create({ title: 'C' });
  const d = store.create({ title: 'D' });
  store.assign(a.id, { sessionId: 's-1', name: '伟峰' }, { kind: 'user' });
  store.update(a.id, { status: 'dispatched', note: '开始执行' }, { kind: 'user' });
  store.assign(b.id, { sessionId: 's-1', name: '伟峰' }, { kind: 'user' });
  store.update(b.id, { status: 'dispatched', note: '开始执行' }, { kind: 'user' });
  store.update(b.id, { status: 'in_review', note: '提交验收' }, { kind: 'user' });
  store.assign(c.id, { sessionId: 's-2', name: '玉清' }, { kind: 'user' });
  store.update(c.id, { status: 'dispatched', note: '开始执行' }, { kind: 'user' });
  store.update(c.id, { status: 'in_review', note: '提交验收' }, { kind: 'user' });
  store.update(c.id, { status: 'done', result: '验收通过' }, { kind: 'user' }); // 已闭环不算
  // d 无 assignee，不算
  assert.deepEqual(store.loads(), { 's-1': 2 });
  store.close();
});

test('versions 返回 id/number/version/updatedAt', () => {
  const store = fresh();
  const issue = store.create({ title: 'X' });
  const rows = store.versions();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, issue.id);
  assert.equal(rows[0].version, 1);
  assert.equal(typeof rows[0].updatedAt, 'number');
  store.close();
});

// ---- 打回 + actor 门（Task 2）----

/** 把一条事务推到「待验收」并指派给伟峰，返回 {store, id}。 */
function toInReview() {
  const store = fresh();
  const issue = store.create({ title: 'X' });
  store.assign(issue.id, { sessionId: 's-1', name: '伟峰' }, { kind: 'user' });
  store.update(issue.id, { status: 'dispatched', note: '开始执行' }, { kind: 'user' });
  store.update(issue.id, { status: 'in_review', note: '提交验收' }, { kind: 'agent', name: '伟峰', isMain: false });
  return { store, id: issue.id };
}

test('in_review→dispatched 打回重做，必须带意见', () => {
  const { store, id } = toInReview();
  assert.throws(() => store.update(id, { status: 'dispatched' }, { kind: 'agent', name: '鲸鱼', isMain: true }), err => err.code === 'REJECTION_REQUIRED');
  const done = store.update(id, { status: 'dispatched', rejection: '结论不对，重做' }, { kind: 'agent', name: '鲸鱼', isMain: true });
  assert.equal(done.status, 'dispatched');
  const full = store.get(id);
  assert.ok(full.comments.some(c => c.kind === 'reject' && c.body === '结论不对，重做'));
  store.close();
});

test('验收通过（in_review→done）只有用户能做，主 Bot 也不能点', () => {
  const { store, id } = toInReview();
  assert.throws(() => store.update(id, { status: 'done', result: '验收通过' }, { kind: 'agent', name: '伟峰', isMain: false }), err => err.code === 'FORBIDDEN_TRANSITION');
  assert.throws(() => store.update(id, { status: 'done', result: '验收通过' }, { kind: 'agent', name: '鲸鱼', isMain: true }), err => err.code === 'FORBIDDEN_TRANSITION');
  const done = store.update(id, { status: 'done', result: '验收通过' }, { kind: 'user' });
  assert.equal(done.status, 'done');
  store.close();
});

test('打回（in_review→dispatched）也只有主 Bot 或人能做', () => {
  const { store, id } = toInReview();
  assert.throws(() => store.update(id, { status: 'dispatched', rejection: 'x' }, { kind: 'agent', name: '伟峰', isMain: false }), err => err.code === 'FORBIDDEN_TRANSITION');
  store.close();
});

test('worker 可把自己那单 进行中→待验收（交结果）', () => {
  const { store, id } = toInReview();
  // toInReview 里已经由 worker（isMain:false）推进到 in_review，这里再开一单验证 dispatched→in_review
  const issue = store.create({ title: 'Y' });
  store.assign(issue.id, { sessionId: 's-1', name: '伟峰' }, { kind: 'user' });
  store.update(issue.id, { status: 'dispatched', note: '开始执行' }, { kind: 'user' });
  const reported = store.update(issue.id, { status: 'in_review', note: '已完成交付' }, { kind: 'agent', name: '伟峰', isMain: false });
  assert.equal(reported.status, 'in_review');
  store.close();
});

// ---- 验收意见 + 父子闭环门禁 ----

test('验收通过（done）必须写验收意见 result', () => {
  const { store, id } = toInReview();
  assert.throws(() => store.update(id, { status: 'done' }, { kind: 'user' }), err => err.code === 'RESULT_REQUIRED');
  const done = store.update(id, { status: 'done', result: '已验证产出' }, { kind: 'user' });
  assert.equal(done.status, 'done');
  assert.equal(store.get(id).result, '已验证产出');
  store.close();
});

test('父事务有未闭环子事务时不能验收通过（BLOCKED_BY_CHILDREN）', () => {
  const store = fresh();
  const parent = store.create({ title: '父' });
  store.update(parent.id, { status: 'dispatched', note: '开始执行' }, { kind: 'user' });
  store.update(parent.id, { status: 'in_review', note: '提交验收' }, { kind: 'user' });
  const child = store.create({ title: '子', parentId: parent.id });
  // 子事务还 open，父不能 done
  assert.throws(() => store.update(parent.id, { status: 'done', result: '验收' }, { kind: 'user' }), err => err.code === 'BLOCKED_BY_CHILDREN');
  // 子事务闭环后，父可验收
  store.update(child.id, { status: 'dispatched', note: '开始执行' }, { kind: 'user' });
  store.update(child.id, { status: 'in_review', note: '提交验收' }, { kind: 'user' });
  store.update(child.id, { status: 'done', result: '子完成' }, { kind: 'user' });
  const done = store.update(parent.id, { status: 'done', result: '父完成' }, { kind: 'user' });
  assert.equal(done.status, 'done');
  store.close();
});

test('重开（done→open）后清掉旧的 result', () => {
  const store = fresh();
  const issue = store.create({ title: 'X' });
  store.update(issue.id, { status: 'dispatched', note: '开始执行' }, { kind: 'user' });
  store.update(issue.id, { status: 'in_review', note: '提交验收' }, { kind: 'user' });
  store.update(issue.id, { status: 'done', result: '已验收' }, { kind: 'user' });
  assert.equal(store.get(issue.id).result, '已验收');
  store.update(issue.id, { status: 'open', note: '重新打开' }, { kind: 'user' });
  assert.equal(store.get(issue.id).result, null);
  store.close();
});

test('seen persists across reopen, only advances, and does not touch issue version', () => {
  const dir = mkdtempSync(join(tmpdir(), 'issue-seen-'));
  const dbPath = join(dir, 'issue.sqlite');
  let store = openIssueStore({ dbPath });
  const a = store.create({ title: 'A' });
  const b = store.create({ title: 'B' });

  assert.deepEqual(store.markSeen(a.id, 3), { [a.id]: 3 });
  store.markSeen(a.id, 2);
  store.markSeenMany({ [b.id]: 4 });
  assert.equal(store.get(a.id).version, 1, '已读不能给事务制造未读更新');
  assert.equal(store.get(b.id).version, 1);
  assert.throws(() => store.markSeen('missing', 1), /找不到/);
  store.close();

  store = openIssueStore({ dbPath });
  assert.deepEqual(store.seen(), { [a.id]: 3, [b.id]: 4 });
  store.markSeenMany({ [a.id]: 1, [b.id]: 2 });
  assert.deepEqual(store.seen(), { [a.id]: 3, [b.id]: 4 }, '批量迁移也不能覆盖更高的已读版本');
  store.close();
});

// ---- 引用回复 + 状态/回复摘要 ----

test('comment supports replyToId and attaches replyTo summary on get/comment', () => {
  const store = fresh();
  const issue = store.create({ title: '核对接口' });
  const first = store.comment(issue.id, {
    body: '先看这张图 ![shot.png](/api/bot-issue?attachment=abcdef1234567890)\n第二行说明',
    authorKind: 'agent',
    authorName: '玉清',
    authorSessionId: 's-yu',
  });
  const reply = store.comment(issue.id, {
    body: '收到，已经按这个改好了',
    authorKind: 'user',
    replyToId: first.id,
  });

  assert.equal(reply.replyToId, first.id);
  assert.equal(reply.replyTo.id, first.id);
  assert.equal(reply.replyTo.authorKind, 'agent');
  assert.equal(reply.replyTo.authorName, '玉清');
  assert.equal(reply.replyTo.authorSessionId, 's-yu');
  assert.equal(reply.replyTo.preview, '先看这张图 [图片] 第二行说明');

  const full = store.get(issue.id);
  assert.equal(full.comments.length, 2);
  assert.equal(full.comments[0].replyToId, null);
  assert.equal(full.comments[0].replyTo, null);
  assert.equal(full.comments[1].replyToId, first.id);
  assert.equal(full.comments[1].replyTo.id, first.id);
  assert.equal(full.comments[1].replyTo.authorName, '玉清');
  store.close();
});

test('comment rejects cross-issue or missing replyToId', () => {
  const store = fresh();
  const a = store.create({ title: 'A' });
  const b = store.create({ title: 'B' });
  const bComment = store.comment(b.id, { body: 'B 的评论', authorKind: 'user' });

  assert.throws(
    () => store.comment(a.id, { body: '跨事务回复', authorKind: 'user', replyToId: bComment.id }),
    err => err.code === 'INVALID_REPLY_TO',
  );
  assert.throws(
    () => store.comment(a.id, { body: '不存在的评论', authorKind: 'user', replyToId: 99999 }),
    err => err.code === 'INVALID_REPLY_TO',
  );
  assert.throws(
    () => store.comment(a.id, { body: '非法编号', authorKind: 'user', replyToId: 'abc' }),
    err => err.code === 'INVALID_REPLY_TO',
  );
  store.close();
});

test('comment refuses replying to status or assign entries, while allowing result and reject', () => {
  const store = fresh();
  const issue = store.create({ title: '不可回复系统变更' });
  store.assign(issue.id, { sessionId: 's-1', name: '伟峰' }, { kind: 'user' });
  store.update(issue.id, { status: 'dispatched', note: '开始执行' }, { kind: 'user' });
  store.update(issue.id, { status: 'in_review', note: '提交验收' }, { kind: 'agent', name: '伟峰', isMain: false });
  store.comment(issue.id, { body: '任务完成总结', authorKind: 'agent', authorName: '伟峰', kind: 'result' });
  store.update(issue.id, { status: 'dispatched', rejection: '请再补一组用例' }, { kind: 'user' });

  const full = store.get(issue.id);
  const assignEntry = full.comments.find(c => c.kind === 'assign');
  const statusEntry = full.comments.find(c => c.kind === 'status');
  const resultEntry = full.comments.find(c => c.kind === 'result');
  const rejectEntry = full.comments.find(c => c.kind === 'reject');

  assert.throws(
    () => store.comment(issue.id, { body: '回复状态变更', authorKind: 'user', replyToId: statusEntry.id }),
    err => err.code === 'INVALID_REPLY_TO',
  );
  assert.throws(
    () => store.comment(issue.id, { body: '回复指派记录', authorKind: 'user', replyToId: assignEntry.id }),
    err => err.code === 'INVALID_REPLY_TO',
  );
  assert.equal(store.comment(issue.id, { body: '回复结果', authorKind: 'user', replyToId: resultEntry.id }).replyToId, resultEntry.id);
  assert.equal(store.comment(issue.id, { body: '回复打回意见', authorKind: 'agent', authorName: '伟峰', replyToId: rejectEntry.id }).replyToId, rejectEntry.id);
  store.close();
});

test('legacy comments table without replyToId and authorSessionId migrates cleanly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'issue-legacy-comments-'));
  const dbPath = join(dir, 'issue.sqlite');
  const raw = new DatabaseSync(dbPath);
  raw.exec(`
    CREATE TABLE issues (
      id TEXT PRIMARY KEY, number INTEGER, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open', parentId TEXT, type TEXT,
      createdBy TEXT NOT NULL, createdByName TEXT NOT NULL DEFAULT '',
      version INTEGER NOT NULL DEFAULT 1, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
      closedAt INTEGER, result TEXT
    );
    CREATE TABLE comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, issueId TEXT NOT NULL,
      authorKind TEXT NOT NULL DEFAULT 'user', authorName TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'comment', at INTEGER NOT NULL
    );
    INSERT INTO issues (id, number, title, body, status, createdBy, createdAt, updatedAt)
    VALUES ('I-old1', 1, '老事务', '', 'open', 'user', 1000, 1000);
    INSERT INTO comments (issueId, authorKind, authorName, body, kind, at)
    VALUES ('I-old1', 'agent', '伟峰', '老评论', 'comment', 1001);
  `);
  raw.close();

  const store = openIssueStore({ dbPath });
  const full = store.get('I-old1');
  assert.equal(full.comments.length, 1);
  assert.equal(full.comments[0].replyToId, null);
  assert.equal(full.comments[0].authorSessionId, null);

  const reply = store.comment('I-old1', { body: '续回复老评论', authorKind: 'user', replyToId: full.comments[0].id });
  assert.equal(reply.replyToId, full.comments[0].id);
  assert.equal(reply.replyTo.authorName, '伟峰');
  store.close();
});

test('versions returns title and status and userReplies lists only non-user replies to user comments', () => {
  const store = fresh();
  const issue = store.create({ title: '浏览器提醒测试' });
  store.update(issue.id, { status: 'dispatched', note: '开始执行' }, { kind: 'user' });
  store.update(issue.id, { status: 'in_review', note: '提交验收' }, { kind: 'agent', name: '伟峰', isMain: false });

  const versions = store.versions();
  assert.equal(versions.length, 1);
  assert.equal(versions[0].title, '浏览器提醒测试');
  assert.equal(versions[0].status, 'in_review');

  const uComment = store.comment(issue.id, { body: '请看第三行', authorKind: 'user' });
  const aComment = store.comment(issue.id, { body: '已看过', authorKind: 'agent', authorName: '伟峰' });
  // 用户自回自己、或 Bot 回复 Bot 都不进 userReplies
  store.comment(issue.id, { body: '我补充一下', authorKind: 'user', replyToId: uComment.id });
  store.comment(issue.id, { body: '赞同', authorKind: 'agent', authorName: 'kiki', replyToId: aComment.id });
  // Bot 回复用户的评论 → 应进 userReplies
  const replyToUser = store.comment(issue.id, {
    body: '第三行已经按你的要求改完',
    authorKind: 'agent',
    authorName: '伟峰',
    replyToId: uComment.id,
  });

  const replies = store.userReplies();
  assert.equal(replies.length, 1);
  assert.equal(replies[0].id, replyToUser.id);
  assert.equal(replies[0].issueId, issue.id);
  assert.equal(replies[0].issueNumber, issue.number);
  assert.equal(replies[0].issueTitle, '浏览器提醒测试');
  assert.equal(replies[0].authorName, '伟峰');
  assert.equal(replies[0].preview, '第三行已经按你的要求改完');
  store.close();
});

// ---- 需求紧急程度（P0 ~ P3） ----

test('priority defaults to P2, normalizes case, validates, and updates', () => {
  const store = fresh();
  const def = store.create({ title: '默认中优' });
  assert.equal(def.priority, 'P2');

  const urgent = store.create({ title: '线上故障', priority: 'p0' });
  assert.equal(urgent.priority, 'P0');
  assert.equal(store.get(urgent.id).priority, 'P0');

  assert.throws(
    () => store.create({ title: '非法优先级', priority: 'P9' }),
    err => err.code === 'INVALID_PRIORITY',
  );
  assert.throws(
    () => store.update(def.id, { priority: 'urgent' }),
    err => err.code === 'INVALID_PRIORITY',
  );

  const promoted = store.update(def.id, { priority: 'P1' });
  assert.equal(promoted.priority, 'P1');
  assert.equal(store.get(def.id).priority, 'P1');
  assert.equal(store.versions().find(v => v.id === def.id).priority, 'P1');
  store.close();
});

test('priority can only be adjusted in open or discussing, locked once dispatched', () => {
  const store = fresh();
  const issue = store.create({ title: '优先级锁定测试', priority: 'P2' });
  store.update(issue.id, { status: 'discussing', note: '进入讨论' });
  assert.equal(store.update(issue.id, { priority: 'P1' }).priority, 'P1');

  store.update(issue.id, { status: 'dispatched', note: '开始执行' }, { kind: 'user' });
  assert.throws(
    () => store.update(issue.id, { priority: 'P0' }),
    err => err.code === 'PRIORITY_LOCKED',
  );
  // 未实际改值时不报错
  assert.equal(store.update(issue.id, { priority: 'P1', title: '改个标题' }).priority, 'P1');

  store.update(issue.id, { status: 'in_review', note: '提交验收' }, { kind: 'agent', name: '伟峰', isMain: false });
  assert.throws(() => store.update(issue.id, { priority: 'P0' }), err => err.code === 'PRIORITY_LOCKED');

  store.update(issue.id, { status: 'done', result: '验收完成' }, { kind: 'user' });
  assert.throws(() => store.update(issue.id, { priority: 'P3' }), err => err.code === 'PRIORITY_LOCKED');

  // 重开回待处理后，恢复可调
  store.update(issue.id, { status: 'open', note: '重开调整' }, { kind: 'user' });
  assert.equal(store.update(issue.id, { priority: 'P0' }).priority, 'P0');
  store.close();
});

test('list sorts P0 to P3 first and supports filtering by priority', () => {
  const store = fresh();
  const low = store.create({ title: '低优', priority: 'P3' });
  const mid = store.create({ title: '中优' });
  const high = store.create({ title: '高优', priority: 'P1' });
  const crit = store.create({ title: '紧急', priority: 'P0' });

  const all = store.list();
  assert.deepEqual(all.items.map(item => item.id), [crit.id, high.id, mid.id, low.id]);

  const onlyP1 = store.list({ priority: 'p1' });
  assert.equal(onlyP1.total, 1);
  assert.equal(onlyP1.items[0].id, high.id);
  store.close();
});

test('legacy issues table without priority column migrates to P2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'issue-legacy-prio-'));
  const dbPath = join(dir, 'issue.sqlite');
  const raw = new DatabaseSync(dbPath);
  raw.exec(`
    CREATE TABLE issues (
      id TEXT PRIMARY KEY, number INTEGER, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open', parentId TEXT, type TEXT,
      createdBy TEXT NOT NULL, createdByName TEXT NOT NULL DEFAULT '',
      version INTEGER NOT NULL DEFAULT 1, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
      closedAt INTEGER, result TEXT
    );
    INSERT INTO issues (id, number, title, body, status, createdBy, createdAt, updatedAt)
    VALUES ('I-oldp', 1, '老事务', '', 'open', 'user', 1000, 1000);
  `);
  raw.close();

  const store = openIssueStore({ dbPath });
  const got = store.get('I-oldp');
  assert.equal(got.priority, 'P2');
  assert.equal(store.list({ priority: 'P2' }).total, 1);
  store.close();
});

test('all status transitions require a non-empty processing opinion and record it in timeline', () => {
  const store = fresh();
  const issue = store.create({ title: '全状态流转意见必填' });

  // open -> discussing without opinion fails
  assert.throws(
    () => store.update(issue.id, { status: 'discussing' }),
    err => err.code === 'OPINION_REQUIRED',
  );
  // open -> cancelled without opinion fails
  assert.throws(
    () => store.update(issue.id, { status: 'cancelled' }),
    err => err.code === 'OPINION_REQUIRED',
  );
  // open -> discussing with note succeeds and writes comment
  store.update(issue.id, { status: 'discussing', note: '先拉相关同事对齐口径' }, { kind: 'user', name: '用户' });
  let full = store.get(issue.id);
  assert.equal(full.status, 'discussing');
  assert.ok(full.comments.some(c => c.kind === 'comment' && c.body === '先拉相关同事对齐口径'));

  // discussing -> dispatched with note by user succeeds
  store.update(issue.id, { status: 'dispatched', note: '方案已定，指派开始开发' }, { kind: 'user', name: '用户' });
  // dispatched -> in_review without opinion fails
  assert.throws(
    () => store.update(issue.id, { status: 'in_review' }, { kind: 'agent', name: '怡丹' }),
    err => err.code === 'OPINION_REQUIRED',
  );
  // dispatched -> in_review with note records kind='result' comment
  store.update(issue.id, { status: 'in_review', note: '已完成代码修改与单测验证' }, { kind: 'agent', name: '怡丹' });
  full = store.get(issue.id);
  assert.equal(full.status, 'in_review');
  assert.ok(full.comments.some(c => c.kind === 'result' && c.body === '已完成代码修改与单测验证'));

  // in_review -> cancelled with note succeeds and writes comment
  store.update(issue.id, { status: 'cancelled', note: '需求已合并到新单，本单取消' }, { kind: 'user', name: '用户' });
  full = store.get(issue.id);
  assert.equal(full.status, 'cancelled');
  assert.ok(full.comments.some(c => c.body === '需求已合并到新单，本单取消'));

  // cancelled -> open without opinion fails, with note succeeds
  assert.throws(
    () => store.update(issue.id, { status: 'open' }, { kind: 'user' }),
    err => err.code === 'OPINION_REQUIRED',
  );
  store.update(issue.id, { status: 'open', note: '重新恢复此单跟进' }, { kind: 'user', name: '用户' });
  assert.equal(store.get(issue.id).status, 'open');
  store.close();
});

test('in_review→open (验收不通过) requires rejection opinion, restricts to user/main, and records reject timeline', () => {
  const { store, id } = toInReview();
  assert.equal(STATUSES.includes('rejected'), false);
  // 非主 Bot/用户不能标记验收不通过
  assert.throws(
    () => store.update(id, { status: 'open', rejection: '不通过' }, { kind: 'agent', name: '伟峰', isMain: false }),
    err => err.code === 'FORBIDDEN_TRANSITION',
  );
  // 不写原因被拒绝
  assert.throws(
    () => store.update(id, { status: 'open' }, { kind: 'user' }),
    err => err.code === 'REJECTION_REQUIRED',
  );
  // 写明原因退回待处理并记录「验收不通过」状态与 reject 评论
  const returned = store.update(id, { status: 'open', rejection: '接口返回缺少分页字段，请整改' }, { kind: 'user', name: '用户' });
  assert.equal(returned.status, 'open');
  const full = store.get(id);
  assert.ok(full.comments.some(c => c.kind === 'status' && c.body === '状态：待验收 → 待处理（验收不通过）'));
  assert.ok(full.comments.some(c => c.kind === 'reject' && c.body === '接口返回缺少分页字段，请整改'));
  store.close();
});

test('discussing→dispatched enforces consensus gate (user-only by default, multi-party agree when autoStart)', () => {
  const store = fresh();
  const issue = store.create({ title: '新需求对齐' });
  store.update(issue.id, { status: 'discussing', note: '先拉团队对齐方案' }, { kind: 'user' });

  // 1. 默认档（discussionAutoStart=false）：主 Bot 无法单方面推进到进行中
  assert.throws(
    () => store.update(issue.id, { status: 'dispatched', note: '我觉得行了' }, { kind: 'agent', id: 's-main', name: '小欣', isMain: true }),
    err => err.code === 'CONSENSUS_USER_REQUIRED',
  );

  // 2. 授权档（discussionAutoStart=true）：未收到实现方签字前，主 Bot 仍被拦截
  store.setDiscussionRoom(issue.id, { roomId: 'room-1', roomName: '讨论 · #1 新需求对齐', autoStart: true });
  assert.throws(
    () => store.update(issue.id, { status: 'dispatched', note: '主 Bot 单方面拍板' }, { kind: 'agent', id: 's-main', name: '小欣', isMain: true }),
    err => err.code === 'CONSENSUS_REQUIRED',
  );

  // 3. 主 Bot 自己签字不算实现方签字
  store.comment(issue.id, { body: '主 Bot 同意', authorKind: 'agent', authorName: '小欣', authorSessionId: 's-main', kind: 'agree' });
  assert.throws(
    () => store.update(issue.id, { status: 'dispatched', note: '仍缺实现方签字' }, { kind: 'agent', id: 's-main', name: '小欣', isMain: true }),
    err => err.code === 'CONSENSUS_REQUIRED',
  );

  // 4. 非主 Bot 实现方显式签字（kind='agree'）后，主 Bot 方可推进到进行中
  store.comment(issue.id, { body: '已理解需求，确认按方案 B 可落地', authorKind: 'agent', authorName: '鹤鸣', authorSessionId: 's-heming', kind: 'agree' });
  const before = store.get(issue.id);
  assert.equal(before.consensus.agreed.length, 2);
  assert.equal(before.discussionRoom.id, 'room-1');

  // 非主 Bot 本身仍不能推进状态
  assert.throws(
    () => store.update(issue.id, { status: 'dispatched', note: '我自己开工' }, { kind: 'agent', id: 's-heming', name: '鹤鸣', isMain: false }),
    err => err.code === 'FORBIDDEN_TRANSITION',
  );

  const started = store.update(issue.id, { status: 'dispatched', note: '主 Bot 与鹤鸣已达成共识，按方案 B 启动' }, { kind: 'agent', id: 's-main', name: '小欣', isMain: true });
  assert.equal(started.status, 'dispatched');

  // 5. 清空讨论群并记录销毁痕迹
  const cleared = store.clearDiscussionRoom(issue.id, '临时讨论群已自动销毁');
  assert.equal(cleared.discussionRoom, null);
  assert.ok(cleared.comments.some(c => c.body === '临时讨论群已自动销毁'));
  store.close();
});
