/**
 * markdown 解析器测试。
 *
 * 解析器住在 client.js 里（浏览器脚本没有模块导出），所以这里从源码里截出
 * 那一段求值——测的是真实现，改了解析器测试会跟着变。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const from = source.indexOf('const HEADING_RE');
const to = source.indexOf('function renderListNodes');
assert.ok(from > 0 && to > from, 'client.js 里找不到 markdown 解析器片段');

const factory = new Function(`${source.slice(from, to)}
return { parseMarkdown, parseInline, listTree, sectionOutline };`);
const { parseMarkdown, parseInline, listTree, sectionOutline } = factory();

const types = blocks => blocks.map(block => block.type);

test('headings keep their level and text', () => {
  const blocks = parseMarkdown('## 第七章：卷积\n\n### 背景\n');
  assert.deepEqual(types(blocks), ['heading', 'heading']);
  assert.deepEqual(blocks[0], { type: 'heading', level: 2, text: '第七章：卷积' });
  assert.equal(blocks[1].level, 3);
});

test('fenced code keeps blank lines and the language', () => {
  const blocks = parseMarkdown('```cuda\n__global__ void k() {\n\n    int a = 1;\n}\n```\n');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'code');
  assert.equal(blocks[0].lang, 'cuda');
  assert.match(blocks[0].code, /int a = 1;/);
  assert.match(blocks[0].code, /\n\n/);
});

test('paragraphs join wrapped lines and stop at a heading', () => {
  const blocks = parseMarkdown('第一行\n第二行\n\n## 标题\n正文');
  assert.deepEqual(types(blocks), ['para', 'heading', 'para']);
  assert.equal(blocks[0].text, '第一行 第二行');
});

test('unordered lists carry nesting level', () => {
  const blocks = parseMarkdown('- 顶层\n  - 子项\n- 顶层二\n');
  assert.equal(blocks[0].type, 'list');
  assert.equal(blocks[0].ordered, false);
  assert.deepEqual(blocks[0].items.map(item => [item.level, item.text]), [[0, '顶层'], [1, '子项'], [0, '顶层二']]);
});

test('ordered lists are marked ordered', () => {
  const blocks = parseMarkdown('1. 第一步\n2. 第二步\n');
  assert.equal(blocks[0].type, 'list');
  assert.equal(blocks[0].ordered, true);
  assert.deepEqual(blocks[0].items.map(item => item.text), ['第一步', '第二步']);
});

test('tables split header and body rows', () => {
  const blocks = parseMarkdown('| 指标 | 数值 |\n| --- | --- |\n| 带宽 | 900 GB/s |\n');
  assert.equal(blocks[0].type, 'table');
  assert.deepEqual(blocks[0].head, ['指标', '数值']);
  assert.deepEqual(blocks[0].rows, [['带宽', '900 GB/s']]);
});

test('blockquotes, rules and display math are recognised', () => {
  const blocks = parseMarkdown('> 引用第一行\n> 引用第二行\n\n---\n\n$$\nE = mc^2\n$$\n');
  assert.deepEqual(types(blocks), ['quote', 'hr', 'math']);
  assert.equal(blocks[0].text, '引用第一行\n引用第二行');
  assert.equal(blocks[2].text, 'E = mc^2');
});

test('inline: bold, code, link, strike, emphasis', () => {
  assert.deepEqual(parseInline('**粗** 和 `code`'),
    [{ type: 'strong', text: '粗' }, { type: 'text', text: ' 和 ' }, { type: 'code', text: 'code' }]);
  assert.deepEqual(parseInline('看 [博客](https://smarter.xin) 吧'),
    [{ type: 'text', text: '看 ' }, { type: 'link', text: '博客', href: 'https://smarter.xin' }, { type: 'text', text: ' 吧' }]);
  assert.deepEqual(parseInline('~~删掉~~'), [{ type: 'del', text: '删掉' }]);
  assert.deepEqual(parseInline('*斜*'), [{ type: 'em', text: '斜' }]);
  assert.deepEqual(parseInline('没有标记'), [{ type: 'text', text: '没有标记' }]);
});

test('listTree nests children under their parent', () => {
  const tree = listTree([{ level: 0, text: 'a' }, { level: 1, text: 'a1' }, { level: 0, text: 'b' }]);
  assert.deepEqual(tree.map(node => node.text), ['a', 'b']);
  assert.deepEqual(tree[0].children.map(node => node.text), ['a1']);
  assert.equal(tree[1].children.length, 0);
});

test('sectionOutline picks h2/h3 with stable anchors', () => {
  const blocks = parseMarkdown('# 书名\n\n## 小节一\n\n### 细节\n\n正文');
  const outline = sectionOutline(blocks);
  assert.deepEqual(outline.map(item => [item.level, item.text]), [[2, '小节一'], [3, '细节']]);
  assert.equal(outline[0].anchor, 'eb-sec-1');
  assert.equal(outline[1].anchor, 'eb-sec-2');
});

test('a real chapter fragment parses without losing the code block', () => {
  const md = [
    '## 内存带宽：性能的天花板',
    '',
    '回顾矩阵乘法：',
    '',
    '```cuda',
    '__global__ void matMul(float *M, float *N, float *P, int width) {',
    '    int row = blockIdx.y * blockDim.y + threadIdx.y;',
    '}',
    '```',
    '',
    '| 版本 | GFLOPS |',
    '| --- | --- |',
    '| naive | 12 |',
    '',
    '> **📦 配套资源**：[仓库](https://github.com/psmarter/PMPP-Learning)',
  ].join('\n');
  const blocks = parseMarkdown(md);
  assert.deepEqual(types(blocks), ['heading', 'para', 'code', 'table', 'quote']);
  assert.match(blocks[2].code, /blockIdx\.y/);
});
