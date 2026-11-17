import test from 'node:test';
import assert from 'node:assert/strict';
import { imageTask, specialtyScore, chooseAssignee } from '../lib/routing.js';

test('imageTask 识别附件与图片 markdown', () => {
  assert.equal(imageTask('![截图](/api/bot-issue?attachment=abc)'), true);
  assert.equal(imageTask('看这个 /api/bot-issue?attachment=abc 就行'), true);
  assert.equal(imageTask('普通文字，没有图'), false);
  assert.equal(imageTask(''), false);
  assert.equal(imageTask(undefined), false);
});

test('specialtyScore 命中双方共有的岗位关键词才加分', () => {
  const bot = { role: '全栈工程师', instructions: '研发工程师，主攻前端研发' };
  assert.equal(specialtyScore(bot, { tags: ['bug'], body: '前端页面坏了' }), 1); // 前端
  assert.equal(specialtyScore(bot, { tags: [], body: '数据库慢' }), 0);
  const bot2 = { role: '实施工程师', instructions: '前端后端都能做' };
  assert.equal(specialtyScore(bot2, { tags: [], body: '后端接口 + 前端页面' }), 2);
});

test('图任务没有 vision 候选时拒绝，不瞎派', () => {
  const r = chooseAssignee({ candidates: [{ sessionId: 's1', name: '伟峰', vision: false, load: 0, specialty: 0 }], needVision: true });
  assert.equal(r.assignee, null);
  assert.match(r.reason, /看图|vision/);
});

test('负载低者优先；负载相同看 specialty', () => {
  const r = chooseAssignee({ candidates: [
    { sessionId: 'a', name: 'A', vision: true, load: 2, specialty: 0 },
    { sessionId: 'b', name: 'B', vision: true, load: 0, specialty: 1 },
    { sessionId: 'c', name: 'C', vision: true, load: 0, specialty: 3 },
  ], needVision: true });
  assert.equal(r.assignee.sessionId, 'c');
});

test('非图任务不过滤 vision，但仍按负载+specialty 排序', () => {
  const r = chooseAssignee({ candidates: [
    { sessionId: 'a', name: 'A', vision: false, load: 0, specialty: 2 },
    { sessionId: 'b', name: 'B', vision: true, load: 1, specialty: 5 },
  ], needVision: false });
  assert.equal(r.assignee.sessionId, 'a');
});

test('候选为空返回 reason', () => {
  const r = chooseAssignee({ candidates: [], needVision: false });
  assert.equal(r.assignee, null);
  assert.ok(r.reason);
});
