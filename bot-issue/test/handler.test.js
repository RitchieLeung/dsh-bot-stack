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

test('create notifies the同事 mentioned in the body (same as a comment)', async () => {
  const seen = [];
  const { handle } = handler({ notify: (issue, payload) => { seen.push({ issue, body: payload.body }); } });
  await handle({ action: 'create', title: 'X', body: '请 @玉清 跟进', authorKind: 'user' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].body, '请 @玉清 跟进');
  assert.equal(seen[0].issue.title, 'X');
});

test('create without an @ does not notify', async () => {
  const seen = [];
  const { handle } = handler({ notify: (issue, payload) => { seen.push(payload); } });
  await handle({ action: 'create', title: 'X', body: '没有提到人' });
  assert.equal(seen.length, 0);
});

test('meta returns statuses and main bot', async () => {  const { handle } = handler({ mainBot: { id: 'b1', name: '鲸鱼' } });
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
  const result = await handle({ action: 'update', id: issue.id, status: 'discussing', note: '开始讨论' });
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

test('tags flow through meta, create, tag_create and tag_delete', async () => {
  const { handle } = handler();
  const created = await handle({ action: 'create', title: 'X', tags: ['bug', 'P0'] });
  assert.deepEqual(created.value.issue.tags, ['bug', 'P0']);
  assert.deepEqual((await handle({ action: 'meta' })).value.tags, ['bug', 'P0']);

  const added = await handle({ action: 'tag_create', name: '调研' });
  assert.deepEqual(added.value.tags, ['bug', 'P0', '调研']);

  const removed = await handle({ action: 'tag_delete', name: 'bug' });
  assert.deepEqual(removed.value.tags, ['P0', '调研']);
  assert.equal(removed.value.detached, 1);
  assert.deepEqual((await handle({ action: 'get', id: created.value.issue.id })).value.issue.tags, ['P0']);
});

test('tag actions reject an empty name', async () => {
  const { handle } = handler();
  assert.equal((await handle({ action: 'tag_create', name: '  ' })).error.code, 'INVALID_TAG');
  assert.equal((await handle({ action: 'tag_delete' })).error.code, 'INVALID_TAG');
});

test('link and unlink move a dependency both ways', async () => {
  const { handle } = handler();
  const a = (await handle({ action: 'create', title: 'A' })).value.issue;
  const b = (await handle({ action: 'create', title: 'B' })).value.issue;

  const linked = await handle({ action: 'link', id: a.id, dependsOn: b.id });
  assert.deepEqual(linked.value.issue.dependsOn.map(d => d.title), ['B']);
  const reverse = await handle({ action: 'get', id: b.id });
  assert.deepEqual(reverse.value.issue.blocks.map(d => d.title), ['A']);

  const unlinked = await handle({ action: 'unlink', id: a.id, dependsOn: b.id });
  assert.deepEqual(unlinked.value.issue.dependsOn, []);
  assert.equal((await handle({ action: 'unlink', id: 'nope', dependsOn: b.id })).error.code, 'NOT_FOUND');
});

test('done is refused over the HTTP contract when a dependency is open', async () => {
  const { handle } = handler();
  const a = (await handle({ action: 'create', title: 'A' })).value.issue;
  const b = (await handle({ action: 'create', title: 'B' })).value.issue;
  await handle({ action: 'link', id: a.id, dependsOn: b.id });
  await handle({ action: 'update', id: a.id, status: 'dispatched', note: '开始执行' });
  await handle({ action: 'update', id: a.id, status: 'in_review', note: '提交验收' });
  const refused = await handle({ action: 'update', id: a.id, status: 'done', result: '验收通过' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, 'BLOCKED_BY_DEPS');
  assert.match(refused.error.message, /#2「B」/);
});

test('assign action sets the executor', async () => {
  const { handle } = handler();
  const { value: { issue } } = await handle({ action: 'create', title: 'X' });
  const result = await handle({ action: 'assign', id: issue.id, sessionId: 's-1', name: '伟峰' });
  assert.equal(result.ok, true);
  assert.equal(result.value.issue.assignee.name, '伟峰');
  const got = await handle({ action: 'get', id: issue.id });
  assert.equal(got.value.issue.assignee.sessionId, 's-1');
});

test('assign rejects a missing sessionId', async () => {
  const { handle } = handler();
  const { value: { issue } } = await handle({ action: 'create', title: 'X' });
  const result = await handle({ action: 'assign', id: issue.id });
  assert.equal(result.error.code, 'INVALID_ID');
});

test('meta returns versions', async () => {
  const { handle } = handler();
  await handle({ action: 'create', title: 'X' });
  const meta = await handle({ action: 'meta' });
  assert.ok(Array.isArray(meta.value.versions));
  assert.equal(meta.value.versions.length, 1);
  assert.equal(typeof meta.value.versions[0].version, 'number');
});

test('update forwards a rejection when打回重做', async () => {
  const { handle } = handler();
  const { value: { issue } } = await handle({ action: 'create', title: 'X' });
  await handle({ action: 'assign', id: issue.id, sessionId: 's-1', name: '伟峰' });
  await handle({ action: 'update', id: issue.id, status: 'dispatched', note: '开始执行' });
  await handle({ action: 'update', id: issue.id, status: 'in_review', note: '提交验收' });
  // 打回不带意见 → 拒绝
  const noOpinion = await handle({ action: 'update', id: issue.id, status: 'dispatched' });
  assert.equal(noOpinion.error.code, 'REJECTION_REQUIRED');
  // 带意见 → 成功 + reject 评论
  const rejected = await handle({ action: 'update', id: issue.id, status: 'dispatched', rejection: '结论不对，重做' });
  assert.equal(rejected.value.issue.status, 'dispatched');
  const got = await handle({ action: 'get', id: issue.id });
  assert.ok(got.value.issue.comments.some(c => c.kind === 'reject' && c.body === '结论不对，重做'));
});

test('面板打回（in_review→dispatched）会知会对侧', async () => {
  const seen = [];
  const { handle } = handler({ notify: (issue, payload) => { seen.push(payload.body); } });
  const { value: { issue } } = await handle({ action: 'create', title: 'X' });
  await handle({ action: 'update', id: issue.id, status: 'dispatched', note: '开始执行' });
  await handle({ action: 'update', id: issue.id, status: 'in_review', note: '提交验收' });
  seen.length = 0;
  const rejected = await handle({ action: 'update', id: issue.id, status: 'dispatched', rejection: '事情没完成' });
  assert.equal(rejected.ok, true);
  assert.ok(seen.some(body => body.includes('被打回重做') && body.includes('事情没完成')));
});

test('普通状态变更（open→discussing）不打扰对侧', async () => {
  const seen = [];
  const { handle } = handler({ notify: (issue, payload) => { seen.push(payload.body); } });
  const { value: { issue } } = await handle({ action: 'create', title: 'X' });
  await handle({ action: 'update', id: issue.id, status: 'discussing', note: '开始讨论' });
  assert.equal(seen.length, 0);
});

test('seen action stores read versions and meta returns them', async () => {
  const { handle } = handler();
  const created = await handle({ action: 'create', title: 'X' });
  const id = created.value.issue.id;

  const marked = await handle({ action: 'seen', id, version: 2 });
  assert.equal(marked.ok, true);
  assert.deepEqual(marked.value.seen, { [id]: 2 });
  const meta = await handle({ action: 'meta' });
  assert.deepEqual(meta.value.seen, { [id]: 2 });
  assert.equal(meta.value.versions.find(v => v.id === id).version, 1);

  const migrated = await handle({ action: 'seen', seen: { [id]: 1 } });
  assert.deepEqual(migrated.value.seen, { [id]: 2 }, '老浏览器记录不能覆盖更高版本');
});

test('comment action supports replyToId, forwards replyTo to notify, and meta exposes userReplies', async () => {
  const seen = [];
  const { handle } = handler({ notify: (issue, comment) => { seen.push({ issue, comment }); } });
  const { value: { issue } } = await handle({ action: 'create', title: '核对通知' });

  const c1 = await handle({ action: 'comment', id: issue.id, body: '我先写个疑问', authorKind: 'user' });
  assert.equal(c1.ok, true);
  assert.equal(c1.value.comment.replyToId, null);

  const c2 = await handle({
    action: 'comment',
    id: issue.id,
    body: '这个问题我改掉了',
    authorKind: 'agent',
    authorName: '伟峰',
    replyToId: c1.value.comment.id,
  });
  assert.equal(c2.ok, true);
  assert.equal(c2.value.comment.replyToId, c1.value.comment.id);
  assert.equal(c2.value.comment.replyTo.authorKind, 'user');
  assert.equal(c2.value.comment.replyTo.preview, '我先写个疑问');
  assert.equal(seen.at(-1).comment.replyTo.id, c1.value.comment.id);

  const bad = await handle({ action: 'comment', id: issue.id, body: '无效引用', replyToId: 99999 });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'INVALID_REPLY_TO');

  const meta = await handle({ action: 'meta' });
  assert.equal(meta.value.versions[0].title, '核对通知');
  assert.equal(meta.value.versions[0].status, 'open');
  assert.equal(meta.value.userReplies.length, 1);
  assert.equal(meta.value.userReplies[0].id, c2.value.comment.id);
  assert.equal(meta.value.userReplies[0].authorName, '伟峰');
});

test('priority flows through meta, create, update, and list', async () => {
  const { handle } = handler();
  const meta = await handle({ action: 'meta' });
  assert.deepEqual(meta.value.priorities, ['P0', 'P1', 'P2', 'P3']);

  const p2 = await handle({ action: 'create', title: '常规任务' });
  const p0 = await handle({ action: 'create', title: '紧急修线', priority: 'p0' });
  assert.equal(p2.value.issue.priority, 'P2');
  assert.equal(p0.value.issue.priority, 'P0');

  const bad = await handle({ action: 'create', title: '错的', priority: 'P5' });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'INVALID_PRIORITY');

  const updated = await handle({ action: 'update', id: p2.value.issue.id, priority: 'P1' });
  assert.equal(updated.value.issue.priority, 'P1');

  const listed = await handle({ action: 'list', priority: 'P0' });
  assert.equal(listed.value.total, 1);
  assert.equal(listed.value.items[0].id, p0.value.issue.id);

  await handle({ action: 'update', id: p2.value.issue.id, status: 'dispatched', note: '开始处理' });
  const locked = await handle({ action: 'update', id: p2.value.issue.id, priority: 'P0' });
  assert.equal(locked.ok, false);
  assert.equal(locked.error.code, 'PRIORITY_LOCKED');
});

test('update requires opinion (note) for every status transition over HTTP', async () => {
  const { handle } = handler();
  const { value: { issue } } = await handle({ action: 'create', title: '取消需写意见' });
  const missing = await handle({ action: 'update', id: issue.id, status: 'cancelled' });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, 'OPINION_REQUIRED');

  const ok = await handle({ action: 'update', id: issue.id, status: 'cancelled', note: '用户决定取消' });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.issue.status, 'cancelled');
  const got = await handle({ action: 'get', id: issue.id });
  assert.ok(got.value.issue.comments.some(c => c.body === '用户决定取消'));
});
