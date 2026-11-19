/**
 * markdown 渲染器测试：解析器只给 AST，真正决定「屏幕上是什么」的是 renderBlocks /
 * renderInline。这里用一个极简的 h 桩把它们跑一遍，断言结构（tag 名、嵌套关系），
 * 不需要真的 React 和 DOM。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const parserFrom = source.indexOf('const HEADING_RE');
const renderFrom = source.indexOf('function renderInline');
const renderTo = source.indexOf('function ErrorBox');
assert.ok(parserFrom > 0 && renderFrom > parserFrom && renderTo > renderFrom, 'client.js 里找不到渲染器片段');

const h = (tag, props, ...children) => ({ tag, props: props || {}, children: children.flat().filter(child => child !== null && child !== undefined && child !== false) });
const React = { Fragment: 'Fragment' };

const factory = new Function('h', 'React', `
${source.slice(parserFrom, renderFrom)}
${source.slice(renderFrom, renderTo)}
return { parseMarkdown, parseInline, renderInline, renderBlocks };
`);
const { parseMarkdown, renderInline, renderBlocks } = factory(h, React);

/** renderBlocks 用 Fragment 给列表包 key，React 里是透明的；测试里直接展开。 */
const flatten = nodes => nodes.flatMap(node => (node && node.tag === React.Fragment ? flatten(node.children) : [node]));
const render = md => flatten(renderBlocks(parseMarkdown(md)));

test('headings render with their level and a stable anchor id', () => {
  const [node] = render('## 第七章：卷积');
  assert.equal(node.tag, 'h2');
  assert.equal(node.props.id, 'eb-sec-0');
  assert.equal(node.children.join(''), '第七章：卷积');
});

test('inline markup becomes strong / code / link elements', () => {
  const nodes = renderInline('**粗** 和 `code` 和 [链接](https://x.y)');
  const tags = nodes.filter(node => typeof node === 'object').map(node => node.tag);
  assert.deepEqual(tags, ['strong', 'code', 'a']);
  const link = nodes.find(node => typeof node === 'object' && node.tag === 'a');
  assert.equal(link.props.href, 'https://x.y');
  assert.equal(link.props.target, '_blank');
});

test('a code block renders as pre > code without inline parsing', () => {
  const [node] = render('```cuda\nint a = 1; // **不是粗体**\n```');
  assert.equal(node.tag, 'pre');
  assert.equal(node.children[0].tag, 'code');
  assert.equal(node.children[0].children[0], 'int a = 1; // **不是粗体**');
});

test('tables render head and body rows', () => {
  const [node] = render('| 指标 | 数值 |\n| --- | --- |\n| 带宽 | 900 |');
  assert.equal(node.tag, 'table');
  const [thead, tbody] = node.children;
  assert.equal(thead.tag, 'thead');
  assert.equal(thead.children[0].children.length, 2);
  assert.equal(tbody.children[0].children[1].children.join(''), '900');
});

test('nested lists keep their structure', () => {
  const [node] = render('- 顶层\n  - 子项\n- 顶层二');
  assert.equal(node.tag, 'ul');
  assert.equal(node.children.length, 2);
  assert.equal(node.children[0].children[1].tag, 'ul');
  assert.equal(node.children[0].children[1].children.length, 1);
});

test('blockquote re-parses its inner markdown', () => {
  const [node] = render('> **📦 配套资源**：见仓库');
  assert.equal(node.tag, 'blockquote');
  assert.equal(node.children[0].tag, 'p');
  assert.equal(node.children[0].children[0].tag, 'strong');
});

test('display math renders as a dedicated block, not inline', () => {
  const [node] = render('$$\nE = mc^2\n$$');
  assert.equal(node.tag, 'div');
  assert.equal(node.props.className, 'eb-math');
  assert.equal(node.children.join(''), 'E = mc^2');
});

test('a whole chapter fragment renders every block type in order', () => {
  const nodes = render([
    '## 内存带宽',
    '',
    '回顾矩阵乘法：',
    '',
    '- 共享内存',
    '  - 分块',
    '',
    '| 版本 | GFLOPS |',
    '| --- | --- |',
    '| naive | 12 |',
    '',
    '---',
    '',
    '```cuda',
    'k();',
    '```',
  ].join('\n'));
  assert.deepEqual(nodes.map(node => node.tag), ['h2', 'p', 'ul', 'table', 'hr', 'pre']);
});
