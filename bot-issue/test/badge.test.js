/**
 * 未读角标的纯逻辑测试：从 client.js 截出 unreadOf/markSeen 来测。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const from = source.indexOf('const UNREAD_KEY');
const to = source.indexOf('function Icon');
assert.ok(from > 0 && to > from, 'client.js 里找不到未读角标实现片段');

const factory = new Function(`${source.slice(from, to)}
return { unreadOf, markSeen };`);
const { unreadOf, markSeen } = factory();

test('unreadOf 统计 version 大于已读的条数', () => {
  const versions = [{ id: 'a', version: 3 }, { id: 'b', version: 1 }];
  assert.equal(unreadOf(versions, { a: 2 }), 2); // a 3>2 未读, b 1>0 未读
  assert.equal(unreadOf(versions, { a: 3, b: 1 }), 0);
  assert.equal(unreadOf([], {}), 0);
  assert.equal(unreadOf(undefined, {}), 0);
});

test('markSeen 只升不降', () => {
  assert.deepEqual(markSeen({ a: 5 }, 'a', 3), { a: 5 });
  assert.deepEqual(markSeen({ a: 2 }, 'a', 4), { a: 4 });
  assert.deepEqual(markSeen(undefined, 'a', 4), { a: 4 });
  assert.deepEqual(markSeen({ a: 2 }, 'a', 2), { a: 2 });
});

function runtime({ versions, serverSeen = {}, legacy = {}, failSeen = false }) {
  const calls = [];
  const storage = { ...legacy };
  const localStorage = {
    getItem: key => storage[key] ?? null,
    setItem: (key, value) => { storage[key] = value; },
  };
  const call = async (action, payload) => {
    calls.push({ action, payload });
    if (action === 'meta') return { versions, seen: serverSeen };
    if (action === 'seen') {
      if (failSeen) throw new Error('老后端没有 seen action');
      if (payload.seen) serverSeen = { ...payload.seen };
      else serverSeen = { ...serverSeen, [payload.id]: payload.version };
      return { seen: serverSeen };
    }
    throw new Error(`未知 action ${action}`);
  };
  const factory = new Function('call', 'localStorage', `${source.slice(from, to)}
  return { refreshUnread, markIssueSeen, unreadStore };`);
  return { ...factory(call, localStorage), calls, storage };
}

test('角标读取服务端已读，换 origin 后也不依赖 localStorage', async () => {
  const rt = runtime({ versions: [{ id: 'a', version: 3 }], serverSeen: { a: 3 } });
  await rt.refreshUnread();
  assert.equal(rt.unreadStore.count, 0);

  await rt.markIssueSeen({ id: 'a', version: 4 });
  assert.ok(rt.calls.some(call => call.action === 'seen' && call.payload.id === 'a'));
  assert.equal(rt.storage['bot-issue:seen'], undefined, '成功后端已读不再依赖浏览器存储');
});

test('旧 localStorage 只迁移一次且不会制造重复未读', async () => {
  const rt = runtime({ versions: [{ id: 'a', version: 3 }], serverSeen: {}, legacy: { 'bot-issue:seen': '{"a":2}' } });
  await rt.refreshUnread();
  assert.equal(rt.unreadStore.count, 1);
  assert.equal(rt.calls.filter(call => call.action === 'seen' && call.payload.seen).length, 1);
  await rt.refreshUnread();
  assert.equal(rt.calls.filter(call => call.action === 'seen' && call.payload.seen).length, 1, '轮询不能重复迁移');
});

test('老后端没有 seen action 时回退到本地已读', async () => {
  const rt = runtime({ versions: [{ id: 'a', version: 4 }], serverSeen: null, legacy: { 'bot-issue:seen': '{"a":4}' }, failSeen: true });
  await rt.refreshUnread();
  assert.equal(rt.unreadStore.count, 0);
  await rt.markIssueSeen({ id: 'a', version: 4 });
  assert.equal(rt.storage['bot-issue:seen'], '{"a":4}');
});

function notifyRuntime({ permission = 'granted', isSecureContext = true } = {}) {
  let versions = [];
  let userReplies = [];
  const serverSeen = {};
  const storage = {};
  const notices = [];
  const dispatched = [];
  let focused = 0;

  class MockNotification {
    constructor(title, options) {
      this.title = title;
      this.options = options;
      this.onclick = null;
      this.closed = false;
      notices.push(this);
    }
    close() { this.closed = true; }
  }
  MockNotification.permission = permission;
  MockNotification.requestPermission = async () => {
    MockNotification.permission = 'granted';
    return 'granted';
  };

  const localStorage = {
    getItem: key => storage[key] ?? null,
    setItem: (key, value) => { storage[key] = value; },
  };
  const window = {
    isSecureContext,
    focus: () => { focused += 1; },
    dispatchEvent: (event) => { dispatched.push(event); },
  };
  class MockCustomEvent {
    constructor(type, init) { this.type = type; this.detail = init?.detail; }
  }
  const call = async (action) => {
    if (action === 'meta') return { versions, userReplies, seen: serverSeen };
    return {};
  };
  const factory = new Function('call', 'localStorage', 'window', 'Notification', 'CustomEvent', `${source.slice(from, to)}
  return { refreshUnread, toggleNotify, notifyState };`);
  const api = factory(call, localStorage, window, MockNotification, MockCustomEvent);
  return {
    ...api,
    notices,
    dispatched,
    getFocused: () => focused,
    setMeta(next) {
      if (next.versions) versions = next.versions;
      if (next.userReplies) userReplies = next.userReplies;
    },
    MockNotification,
  };
}

test('首次轮询不弹窗，后续事务进入待验收时触发浏览器通知，点击聚焦并打开事务', async () => {
  const rt = notifyRuntime({ permission: 'granted' });
  rt.setMeta({
    versions: [
      { id: 'I-1', number: 1, title: '已有待验收', status: 'in_review', version: 2 },
      { id: 'I-2', number: 2, title: '开发中的任务', status: 'dispatched', version: 2 },
    ],
  });
  await rt.refreshUnread();
  assert.equal(rt.notices.length, 0, '首轮加载已有待验收不应重复弹窗');

  // I-1 在待验收期间新加评论（version 变但状态没变）不应再弹待验收通知
  // I-2 从 进行中 → 待验收（P0 高优应带 [P0] 标识），应弹窗
  rt.setMeta({
    versions: [
      { id: 'I-1', number: 1, title: '已有待验收', status: 'in_review', priority: 'P2', version: 3 },
      { id: 'I-2', number: 2, title: '开发中的任务', status: 'in_review', priority: 'P0', version: 3 },
    ],
  });
  await rt.refreshUnread();
  assert.equal(rt.notices.length, 1);
  assert.match(rt.notices[0].title, /待验收.*\[P0\].*#2.*开发中的任务/);

  // 点击通知应聚焦窗口并派发 bot-issue:open
  rt.notices[0].onclick();
  assert.equal(rt.getFocused(), 1);
  assert.equal(rt.dispatched.length, 1);
  assert.equal(rt.dispatched[0].type, 'bot-issue:open');
  assert.deepEqual(rt.dispatched[0].detail, { id: 'I-2', number: 2 });
  assert.equal(rt.notices[0].closed, true);

  // 打回重做后再一次提交待验收，应能再次通知
  rt.setMeta({
    versions: [
      { id: 'I-2', number: 2, title: '开发中的任务', status: 'dispatched', version: 4 },
    ],
  });
  await rt.refreshUnread();
  rt.setMeta({
    versions: [
      { id: 'I-2', number: 2, title: '开发中的任务', status: 'in_review', version: 5 },
    ],
  });
  await rt.refreshUnread();
  assert.equal(rt.notices.length, 2);
});

test('收到针对用户评论的新回复时触发浏览器通知，并在未授权时允许按钮申请授权', async () => {
  const rt = notifyRuntime({ permission: 'default' });
  rt.setMeta({
    versions: [{ id: 'I-1', number: 1, title: '核对', status: 'open', version: 1 }],
    userReplies: [{ id: 10, issueId: 'I-1', issueNumber: 1, issueTitle: '核对', authorKind: 'agent', authorName: '伟峰', preview: '历史回复' }],
  });
  await rt.refreshUnread();
  assert.equal(rt.notifyState.status, 'default');
  assert.equal(rt.notices.length, 0);

  const afterGrant = await rt.toggleNotify();
  assert.equal(afterGrant, 'enabled');

  rt.setMeta({
    userReplies: [
      { id: 11, issueId: 'I-1', issueNumber: 1, issueTitle: '核对', authorKind: 'agent', authorName: '伟峰', preview: '最新回复内容' },
      { id: 10, issueId: 'I-1', issueNumber: 1, issueTitle: '核对', authorKind: 'agent', authorName: '伟峰', preview: '历史回复' },
    ],
  });
  await rt.refreshUnread();
  assert.equal(rt.notices.length, 1);
  assert.match(rt.notices[0].title, /伟峰.*回复/);
  assert.match(rt.notices[0].options.body, /最新回复内容/);
});

test('通知支持暂停/恢复，且在非安全上下文中安全降级', async () => {
  const rt = notifyRuntime({ permission: 'granted' });
  rt.setMeta({ versions: [{ id: 'I-1', number: 1, title: 'A', status: 'dispatched', version: 1 }] });
  await rt.refreshUnread();
  assert.equal(await rt.toggleNotify(), 'muted');

  rt.setMeta({ versions: [{ id: 'I-1', number: 1, title: 'A', status: 'in_review', version: 2 }] });
  await rt.refreshUnread();
  assert.equal(rt.notices.length, 0, '暂停期间不应弹窗');

  assert.equal(await rt.toggleNotify(), 'enabled');
  rt.setMeta({ versions: [{ id: 'I-2', number: 2, title: 'B', status: 'in_review', version: 1 }] });
  await rt.refreshUnread();
  assert.equal(rt.notices.length, 1, '恢复后新进入待验收应弹窗');

  const insecure = notifyRuntime({ permission: 'granted', isSecureContext: false });
  assert.equal(insecure.notifyState.status, 'insecure');
  assert.equal(await insecure.toggleNotify(), 'insecure');
});
