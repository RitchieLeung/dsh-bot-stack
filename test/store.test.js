import test from 'node:test';
import assert from 'node:assert/strict';
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
  assert.throws(() => store.update(issue.id, { status: 'done' }), /不能从 open 直接到 done/);
  const moved = store.update(issue.id, { status: 'discussing' });
  assert.equal(moved.status, 'discussing');
  // a status change is recorded in the timeline
  const full = store.get(issue.id);
  assert.equal(full.comments.length, 1);
  assert.equal(full.comments[0].kind, 'status');
  store.close();
});

test('version guard refuses stale writes', () => {
  const store = fresh();
  const issue = store.create({ title: 'X' });
  assert.throws(() => store.update(issue.id, { status: 'discussing', expectedVersion: 99 }), err => err.code === 'VERSION_CONFLICT');
  store.close();
});

test('recordDispatch blocks double dispatch of a WIP issue', () => {
  const store = fresh();
  const issue = store.create({ title: 'X' });
  const d = store.recordDispatch(issue.id, { taskId: 'T-abc', workerSessionId: 's1' });
  assert.equal(d.taskId, 'T-abc');
  assert.equal(store.get(issue.id).status, 'dispatched');
  assert.throws(() => store.recordDispatch(issue.id, { taskId: 'T-def' }), /不能重复派工/);
  store.close();
});

test('settleDispatch done sends issue to in_review with a result comment', () => {
  const store = fresh();
  const issue = store.create({ title: 'X' });
  store.recordDispatch(issue.id, { taskId: 'T-abc' });
  const full = store.settleDispatch(issue.id, { taskId: 'T-abc', status: 'done', resultText: '已上线，共 12 台机器。' });
  assert.equal(full.status, 'in_review');
  assert.ok(full.comments.some(c => c.kind === 'result' && /12 台/.test(c.body)));
  assert.equal(full.dispatches[0].status, 'done');
  store.close();
});

test('settleDispatch is idempotent', () => {
  const store = fresh();
  const issue = store.create({ title: 'X' });
  store.recordDispatch(issue.id, { taskId: 'T-abc' });
  store.settleDispatch(issue.id, { taskId: 'T-abc', status: 'done', resultText: '结果' });
  const again = store.settleDispatch(issue.id, { taskId: 'T-abc', status: 'done', resultText: '重复' });
  assert.equal(again.comments.filter(c => c.kind === 'result').length, 1);
  store.close();
});

test('settleDispatch failed sends issue to failed', () => {
  const store = fresh();
  const issue = store.create({ title: 'X' });
  store.recordDispatch(issue.id, { taskId: 'T-abc' });
  const full = store.settleDispatch(issue.id, { taskId: 'T-abc', status: 'failed', resultText: '做不了' });
  assert.equal(full.status, 'failed');
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
