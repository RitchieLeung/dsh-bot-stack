import test from 'node:test';
import assert from 'node:assert/strict';
import { openIssueStore } from '../lib/store.js';
import { createIssueHandler } from '../lib/handler.js';

function handler({ start, mainBot, notify, rosterOf } = {}) {
  const store = openIssueStore({ dbPath: ':memory:' });
  return { handle: createIssueHandler({ store, start, mainBot, notify, rosterOf }), store };
}

test('comment invokes notify and meta exposes the roster', async () => {
  const seen = [];
  const { handle } = handler({
    notify: (issue, comment, sessionId) => { seen.push({ issue, comment, sessionId }); },
    rosterOf: () => [{ id: 'b1', name: '玉清', sessionId: 's-yu' }],
  });
  const created = await handle({ action: 'create', title: 'X' });
  const id = created.value.issue.id;
  await handle({ action: 'comment', id, body: '@玉清 看下', authorKind: 'user' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].comment.body, '@玉清 看下');
  const meta = await handle({ action: 'meta' });
  assert.deepEqual(meta.value.roster, [{ id: 'b1', name: '玉清', sessionId: 's-yu' }]);
});

test('meta returns statuses and main bot', async () => {
  const { handle } = handler({ mainBot: { id: 'b1', name: '鲸鱼' } });
  const result = await handle({ action: 'meta' });
  assert.equal(result.ok, true);
  assert.ok(result.value.statuses.includes('in_review'));
  assert.equal(result.value.mainBot.name, '鲸鱼');
});

test('create/list/get round-trip', async () => {
  const { handle } = handler();
  const created = await handle({ action: 'create', title: '发布', body: '细节', authorKind: 'user', authorName: '我' });
  assert.equal(created.ok, true);
  const id = created.value.issue.id;
  const listed = await handle({ action: 'list', status: 'open' });
  assert.equal(listed.value.total, 1);
  const got = await handle({ action: 'get', id });
  assert.equal(got.value.issue.title, '发布');
  assert.equal(got.value.issue.comments.length, 0);
});

test('create stores type and meta reports the types in use', async () => {
  const { handle } = handler();
  const created = await handle({ action: 'create', title: 'X', type: 'bug' });
  assert.equal(created.value.issue.type, 'bug');
  const meta = await handle({ action: 'meta' });
  assert.ok(meta.value.types.includes('bug'));
});

test('update applies a valid transition', async () => {
  const { handle } = handler();
  const { value: { issue } } = await handle({ action: 'create', title: 'X' });
  const result = await handle({ action: 'update', id: issue.id, status: 'discussing' });
  assert.equal(result.value.issue.status, 'discussing');
});

test('update rejects an illegal transition', async () => {
  const { handle } = handler();
  const { value: { issue } } = await handle({ action: 'create', title: 'X' });
  const result = await handle({ action: 'update', id: issue.id, status: 'done' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'FORBIDDEN_TRANSITION');
});

test('comment appends', async () => {
  const { handle } = handler();
  const { value: { issue } } = await handle({ action: 'create', title: 'X' });
  const result = await handle({ action: 'comment', id: issue.id, body: '我的评论', authorKind: 'user', authorName: '我' });
  assert.equal(result.ok, true);
  const got = await handle({ action: 'get', id: issue.id });
  assert.equal(got.value.issue.comments.length, 1);
  assert.equal(got.value.issue.comments[0].body, '我的评论');
});

test('start without bridge reports unavailable', async () => {
  const { handle } = handler();
  const { value: { issue } } = await handle({ action: 'create', title: 'X' });
  const result = await handle({ action: 'start', id: issue.id });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'DISPATCH_UNAVAILABLE');
});

test('start with a bridge returns the dispatch result', async () => {
  const { handle } = handler({ start: async issue => ({ dispatched: true, taskId: 'T-1', issueId: issue.id }) });
  const { value: { issue } } = await handle({ action: 'create', title: 'X' });
  const result = await handle({ action: 'start', id: issue.id });
  assert.equal(result.ok, true);
  assert.equal(result.value.taskId, 'T-1');
  assert.equal(result.value.dispatched, true);
});

test('unknown action and invalid body', async () => {
  const { handle } = handler();
  assert.equal((await handle({ action: 'nope' })).error.code, 'UNKNOWN_ACTION');
  assert.equal((await handle('garbage')).error.code, 'INVALID_BODY');
});

test('missing id is rejected', async () => {
  const { handle } = handler();
  assert.equal((await handle({ action: 'get' })).error.code, 'INVALID_ID');
});
