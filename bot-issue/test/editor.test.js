/**
 * Markdown 编辑器工具栏纯函数测试：从 client.js 截出 applyMarkdownFormat 来测。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const from = source.indexOf('// ---- 编辑器工具栏格式化（editor.test.js 从这里截取）----');
const to = source.indexOf('// ---- 编辑器工具栏格式化结束 ----');
assert.ok(from > 0 && to > from, 'client.js 里找不到编辑器格式化实现片段');

const factory = new Function(`${source.slice(from, to)}
return { applyMarkdownFormat };`);
const { applyMarkdownFormat } = factory();

test('行内格式（加粗/斜体/删除线/链接）正确包裹选区或插入占位', () => {
  const boldSelected = applyMarkdownFormat('hello world', 6, 11, 'bold');
  assert.equal(boldSelected.text, 'hello **world**');
  assert.equal(boldSelected.start, 8);
  assert.equal(boldSelected.end, 13);

  const boldEmpty = applyMarkdownFormat('abc', 3, 3, 'bold');
  assert.equal(boldEmpty.text, 'abc**粗体**');
  assert.equal(boldEmpty.text.slice(boldEmpty.start, boldEmpty.end), '粗体');

  const strike = applyMarkdownFormat('旧文案', 0, 3, 'strike');
  assert.equal(strike.text, '~~旧文案~~');

  const link = applyMarkdownFormat('点这里', 0, 3, 'link');
  assert.equal(link.text, '[点这里](https://)');
  assert.equal(link.text.slice(link.start, link.end), 'https://');
});

test('代码格式区分单行行内代码与多行/空选区代码块', () => {
  const inline = applyMarkdownFormat('run npm test now', 4, 12, 'code');
  assert.equal(inline.text, 'run `npm test` now');

  const block = applyMarkdownFormat('a\nb', 0, 3, 'code');
  assert.equal(block.text, '```\na\nb\n```');

  const emptyBlock = applyMarkdownFormat('', 0, 0, 'code');
  assert.equal(emptyBlock.text, '```\n代码\n```');
});

test('行级格式（标题/引用/列表/待办/表格/分割线）按行首补齐格式', () => {
  assert.equal(applyMarkdownFormat('标题', 0, 2, 'h2').text, '## 标题');
  assert.equal(applyMarkdownFormat('第一行\n第二行', 0, 7, 'ul').text, '- 第一行\n- 第二行');
  assert.equal(applyMarkdownFormat('第一项\n第二项', 0, 7, 'ol').text, '1. 第一项\n2. 第二项');
  assert.equal(applyMarkdownFormat('待验证', 0, 3, 'task').text, '- [ ] 待验证');
  assert.equal(applyMarkdownFormat('引用句', 0, 3, 'quote').text, '> 引用句');
  assert.match(applyMarkdownFormat('正文', 2, 2, 'table').text, /\| 列1 \| 列2 \|/);
  assert.match(applyMarkdownFormat('正文', 2, 2, 'hr').text, /---/);
});
