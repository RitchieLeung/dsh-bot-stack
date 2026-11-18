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
