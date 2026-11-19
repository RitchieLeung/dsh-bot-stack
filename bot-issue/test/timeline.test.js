/**
 * 时间线评论/系统事件配色逻辑测试：从 client.js 截出配色纯函数来测。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const from = source.indexOf('// ---- 时间线配色（timeline.test.js 从这里截取）----');
const to = source.indexOf('// ---- 时间线配色结束 ----');
assert.ok(from > 0 && to > from, 'client.js 里找不到时间线配色实现片段');

const factory = new Function(`${source.slice(from, to)}
return { SYSTEM_COLOR, USER_COLOR, AUTHOR_PALETTE, buildAuthorColorMap, timelineTone };`);
const { SYSTEM_COLOR, USER_COLOR, AUTHOR_PALETTE, buildAuthorColorMap, timelineTone } = factory();

test('系统事件（status/assign/system）使用独立系统颜色，不与人员混用', () => {
  const colors = buildAuthorColorMap([{ name: '鲸鱼' }, { name: '伟峰' }], []);
  const statusTone = timelineTone({ kind: 'status', authorKind: 'agent', authorName: '鲸鱼' }, colors);
  const assignTone = timelineTone({ kind: 'assign', authorKind: 'system', authorName: '' }, colors);
  const sysTone = timelineTone({ kind: 'comment', authorKind: 'system', authorName: '系统' }, colors);

  assert.equal(statusTone.isSystem, true);
  assert.equal(statusTone.color, SYSTEM_COLOR);
  assert.equal(assignTone.isSystem, true);
  assert.equal(assignTone.color, SYSTEM_COLOR);
  assert.equal(sysTone.isSystem, true);
  assert.equal(sysTone.color, SYSTEM_COLOR);

  assert.notEqual(SYSTEM_COLOR, USER_COLOR);
  assert.ok(!AUTHOR_PALETTE.includes(SYSTEM_COLOR));
});

test('每个人（我与各位同事）分配互不重复的独立颜色，且不受时间线新增发言影响', () => {
  const roster = [{ name: '鲸鱼' }, { name: '伟峰' }, { name: 'kiki' }, { name: '玉清' }];
  const c1 = { kind: 'comment', authorKind: 'agent', authorName: '鲸鱼' };
  const c2 = { kind: 'comment', authorKind: 'agent', authorName: '伟峰' };
  const c3 = { kind: 'result', authorKind: 'agent', authorName: 'kiki' };
  const c4 = { kind: 'reject', authorKind: 'agent', authorName: '玉清' };
  const me = { kind: 'comment', authorKind: 'user', authorName: '' };

  const mapA = buildAuthorColorMap(roster, [c1, c2, c3, c4, me]);
  const mapB = buildAuthorColorMap(roster, [me, c4, { kind: 'comment', authorKind: 'agent', authorName: '临时客串' }]);

  const tones = [c1, c2, c3, c4, me].map(c => timelineTone(c, mapA));
  assert.ok(tones.every(t => !t.isSystem));
  const unique = new Set(tones.map(t => t.color));
  assert.equal(unique.size, 5, '我与 4 位同事应该有 5 种完全不同的颜色');

  assert.equal(timelineTone(me, mapA).color, USER_COLOR);
  // 同一只 roster Bot 即使发言顺序变了或有新人加入，颜色也保持稳定
  assert.equal(timelineTone(c1, mapA).color, timelineTone(c1, mapB).color);
  assert.equal(timelineTone(c4, mapA).color, timelineTone(c4, mapB).color);
  // 临时客串同事也拿到不同于系统与用户的颜色
  const guestTone = timelineTone({ kind: 'comment', authorKind: 'agent', authorName: '临时客串' }, mapB);
  assert.notEqual(guestTone.color, SYSTEM_COLOR);
  assert.notEqual(guestTone.color, USER_COLOR);
});
