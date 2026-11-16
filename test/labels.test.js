/**
 * 状态的「人话名字」一致性测试。
 *
 * 状态评论、错误提示在 host 侧写成中文（store.js 的 STATUS_LABELS），面板另有一份
 * 显示用的 STATUS_LABEL（浏览器脚本无法 import host 模块）。两份必须一致，否则
 * 同一个状态在评论里和徽章上会不一样；这里就是那道闸门。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { STATUS_LABELS, STATUSES, statusLabel } from '../lib/store.js';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const from = source.indexOf('const STATUS_LABEL = {');
const to = source.indexOf('function ErrorBox');
assert.ok(from > 0 && to > from, 'client.js 里找不到状态标签片段');

const factory = new Function(`${source.slice(from, to)}
return { STATUS_LABEL, localizeStatusText };`);
const { STATUS_LABEL, localizeStatusText } = factory();

test('面板与 store 的状态名字一致', () => {
  assert.deepEqual(STATUS_LABEL, STATUS_LABELS);
});

test('每个状态都有中文名', () => {
  for (const status of STATUSES) {
    assert.equal(typeof STATUS_LABELS[status], 'string');
    assert.ok(STATUS_LABELS[status].length > 0);
    assert.notEqual(STATUS_LABELS[status], status);
  }
  assert.equal(statusLabel('nope'), 'nope');
});

test('历史评论里的变量名会翻成中文', () => {
  assert.equal(localizeStatusText('状态：dispatched → in_review'), '状态：进行中 → 待验收');
  assert.equal(localizeStatusText('状态：open → cancelled'), '状态：待处理 → 已取消');
  assert.equal(localizeStatusText('没有状态词'), '没有状态词');
  assert.equal(localizeStatusText(''), '');
  assert.equal(localizeStatusText(undefined), undefined);
});

test('只在整词处替换，不碰更长的单词', () => {
  assert.equal(localizeStatusText('opens 与 doneFlag'), 'opens 与 doneFlag');
});
