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
