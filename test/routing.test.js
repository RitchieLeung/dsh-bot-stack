import test from 'node:test';
import assert from 'node:assert/strict';
import { imageTask } from '../lib/routing.js';

test('imageTask 识别附件与图片 markdown', () => {
  assert.equal(imageTask('![截图](/api/bot-issue?attachment=abc)'), true);
  assert.equal(imageTask('看这个 /api/bot-issue?attachment=abc 就行'), true);
  assert.equal(imageTask('普通文字，没有图'), false);
  assert.equal(imageTask(''), false);
  assert.equal(imageTask(undefined), false);
});
