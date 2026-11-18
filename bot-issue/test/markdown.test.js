/**
 * 事务正文/评论的 markdown 解析测试（从 client.js 截出实现来测）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const from = source.indexOf('const HEADING_RE');
const to = source.indexOf('const MENTION_SPLIT');
assert.ok(from > 0 && to > from, 'client.js 里找不到 markdown 解析器');

const factory = new Function(`${source.slice(from, to)}
return { parseMarkdown, parseInline, listTree };`);
const { parseMarkdown, parseInline, listTree } = factory();
const types = blocks => blocks.map(block => block.type);

test('标题、段落、代码块、表格、引用、列表、分割线都能识别', () => {
  const md = [
    '## 目标',
    '',
    '把 **上传** 做出来，`curl` 能跑。',
    '',
    '```bash',
    'curl -X POST /api/bot-issue',
    '```',
    '',
    '| 项 | 值 |',
    '| --- | --- |',
    '| 大小 | 10MB |',
    '',
    '> 备注：只收图片',
    '',
    '- 前端',
    '  - 粘贴上传',
    '- 后端',
    '',
    '---',
  ].join('\n');
  assert.deepEqual(types(parseMarkdown(md)), ['heading', 'para', 'code', 'table', 'quote', 'list', 'hr']);
});

test('行内：粗体、行内代码、链接、删除线', () => {
  assert.deepEqual(parseInline('**粗**'), [{ type: 'strong', text: '粗' }]);
  assert.deepEqual(parseInline('`code`'), [{ type: 'code', text: 'code' }]);
  assert.deepEqual(parseInline('[文档](https://x.y)'), [{ type: 'link', text: '文档', href: 'https://x.y' }]);
  assert.deepEqual(parseInline('~~删~~'), [{ type: 'del', text: '删' }]);
});

test('图片：行内和独占一行两种', () => {
  const inline = parseInline('看这个 ![截图](/api/bot-issue?attachment=abc) 效果');
  assert.deepEqual(inline[1], { type: 'image', alt: '截图', href: '/api/bot-issue?attachment=abc' });

  const blocks = parseMarkdown('![截图](/api/bot-issue?attachment=abc)');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'image');
  assert.equal(blocks[0].href, '/api/bot-issue?attachment=abc');
});

test('列表层级', () => {
  const tree = listTree([{ level: 0, text: 'a' }, { level: 1, text: 'a1' }, { level: 0, text: 'b' }]);
  assert.deepEqual(tree.map(node => node.text), ['a', 'b']);
  assert.deepEqual(tree[0].children.map(node => node.text), ['a1']);
});

test('代码块保留空行和缩进', () => {
  const [block] = parseMarkdown('```cuda\nint a = 1;\n\n    int b = 2;\n```');
  assert.equal(block.lang, 'cuda');
  assert.match(block.code, /int a = 1;\n\n    int b = 2;/);
});
