/**
 * 依赖候选过滤的测试。
 *
 * 这段逻辑之前有 bug：空输入不查、`#` 被当成标题关键词去 LIKE，所以点了「＋ 添加」
 * 一条候选都没有。现在从 client.js 里截出来单测（和 labels/mention 测试一个套路）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const from = source.indexOf('function filterIssueCandidates');
const to = source.indexOf('function DepPicker');
assert.ok(from > 0 && to > from, 'client.js 里找不到 filterIssueCandidates');

const { filterIssueCandidates } = new Function(`${source.slice(from, to)}
return { filterIssueCandidates };`)();

const pool = [
  { id: 'a', number: 1, title: '测试任务', status: 'open' },
  { id: 'b', number: 2, title: '这是一条测试任务', status: 'done' },
  { id: 'c', number: 3, title: '继续测试任务', status: 'done', type: 'bug' },
  { id: 'd', number: 12, title: '发布上线', status: 'in_review' },
  { id: 'e', number: 21, title: '文档补全', status: 'open', type: '文档' },
  { id: 'f', number: 4, title: '联调', status: 'open' },
  { id: 'g', number: 5, title: '压测', status: 'open' },
  { id: 'h', number: 6, title: '回归', status: 'open' },
  { id: 'i', number: 7, title: '验收', status: 'open' },
  { id: 'j', number: 8, title: '复盘', status: 'open' },
];

test('空输入就列候选（不用先打字）', () => {
  const hits = filterIssueCandidates(pool, '');
  assert.equal(hits.length, 8);
  assert.equal(hits[0].number, 1);
  assert.ok(hits.every(item => typeof item.number === 'number'));
});

test('单个 # 也列候选', () => {
  assert.equal(filterIssueCandidates(pool, '#').length, 8);
  assert.equal(filterIssueCandidates(pool, '#  ').length, 8);
});

test('# 加数字按编号前缀过滤', () => {
  assert.deepEqual(filterIssueCandidates(pool, '#3').map(item => item.number), [3]);
  assert.deepEqual(filterIssueCandidates(pool, '#1').map(item => item.number), [1, 12]);
  assert.deepEqual(filterIssueCandidates(pool, '#2').map(item => item.number), [2, 21]);
  assert.deepEqual(filterIssueCandidates(pool, '#99'), []);
});

test('打标题关键词按标题过滤（不区分大小写）', () => {
  assert.deepEqual(filterIssueCandidates(pool, '测试').map(item => item.number), [1, 2, 3]);
  assert.deepEqual(filterIssueCandidates(pool, '发布').map(item => item.number), [12]);
  assert.deepEqual(filterIssueCandidates(pool, '不存在'), []);
});

test('打标签也能搜到', () => {
  assert.deepEqual(filterIssueCandidates(pool, '文档').map(item => item.number), [21]);
  assert.deepEqual(filterIssueCandidates(pool, 'bug').map(item => item.number), [3]);
});

test('已挂上的和本事务会被排除', () => {
  const hits = filterIssueCandidates(pool, '测试', ['a', 'b']);
  assert.deepEqual(hits.map(item => item.number), [3]);
  assert.equal(filterIssueCandidates(pool, '', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']).length, 2);
});

test('最多 8 条', () => {
  const many = Array.from({ length: 30 }, (_, index) => ({ id: `x${index}`, number: index + 1, title: `事务 ${index + 1}` }));
  assert.equal(filterIssueCandidates(many, '').length, 8);
  assert.equal(filterIssueCandidates(many, '事务').length, 8);
});
