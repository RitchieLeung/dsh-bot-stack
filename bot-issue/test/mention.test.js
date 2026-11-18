/**
 * 评论框 @同事 补全的纯逻辑测试。
 *
 * client.js 是直接喂给浏览器的单文件脚本（没有模块导出），所以这里从源码里
 * 截出 MENTION_RE / mentionMenuItems 求值——测的是真实实现，改了源码测试跟着变。
 */
import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const from = source.indexOf('const MENTION_RE');
const to = source.indexOf('function ErrorBox');
assert.ok(from > 0 && to > from, 'client.js 里找不到 @ 补全的实现片段');

const factory = new Function(`${source.slice(from, to)}
return { MENTION_RE, mentionMenuItems };`);
const { MENTION_RE, mentionMenuItems } = factory();

/** 模拟 textarea：text 是完整内容，caret 是光标位置。 */
const token = (text, caret = text.length) => {
  const matched = MENTION_RE.exec(text.slice(0, caret));
  return matched ? matched[2] : null;
};

test('行首/空白/标点后的 @ 会弹出候选', () => {
  assert.equal(token('@'), '@');
  assert.equal(token('@玉'), '@玉');
  assert.equal(token('请 @玉'), '@玉');
  assert.equal(token('看下（@玉'), '@玉');
  assert.equal(token('结论：@玉清'), '@玉清');
});

test('邮箱、@ 后带空格、光标不在 token 末尾时不弹', () => {
  assert.equal(token('a@b'), null);
  assert.equal(token('a@b，看下'), null);
  assert.equal(token('@玉清 你好'), null);
  assert.equal(token('@玉清 你好', 2), '@玉');
});

test('候选按子串匹配，前缀命中和短名字排前面', () => {
  const names = ['玉清', '尚锦', 'kiki', '小欣'];
  assert.deepEqual([...mentionMenuItems(names, '')].sort(), [...names].sort());
  assert.deepEqual(mentionMenuItems(names, '清'), ['玉清']);
  assert.deepEqual(mentionMenuItems(names, 'ki'), ['kiki']);
  assert.deepEqual(mentionMenuItems(names, '不存在'), []);
});

test('候选最多 8 条', () => {
  const many = Array.from({ length: 30 }, (_, i) => `bot${i}`);
  assert.equal(mentionMenuItems(many, 'bot').length, 8);
});
