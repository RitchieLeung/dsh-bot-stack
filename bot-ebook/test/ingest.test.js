import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chunkText,
  splitMarkdownChapters,
  extractWebBody,
  buildConversionPrompt,
  convertToBook,
} from '../lib/ingest.js';

test('chunkText 切块不丢内容且每块不超限', () => {
  const text = Array.from({ length: 500 }, (_v, i) => `第${i}段 内容`).join('\n\n');
  const chunks = chunkText(text, 2000);
  assert.ok(chunks.length > 1, '长文应当切成多块');
  assert.ok(chunks.every(c => c.length <= 2000), '每块不超过上限');
  const strip = s => s.replace(/\s+/g, '');
  assert.equal(strip(chunks.join('')), strip(text), '切块不丢内容');
});

test('chunkText 短文本原样返回单块', () => {
  assert.deepEqual(chunkText('hello world'), ['hello world']);
  assert.deepEqual(chunkText(''), []);
});

test('splitMarkdownChapters 只有一级标题分章，## 归入章内', () => {
  const md = '# 第一章\n\n开头\n\n## 1.1 小节\n\n内容\n\n# 第二章\n\n结尾';
  const chapters = splitMarkdownChapters(md);
  assert.equal(chapters.length, 2);
  assert.equal(chapters[0].title, '第一章');
  assert.match(chapters[0].body, /## 1\.1 小节/);
  assert.match(chapters[0].body, /内容/);
  assert.equal(chapters[1].title, '第二章');
});

test('splitMarkdownChapters 无标题时整篇一章', () => {
  const chapters = splitMarkdownChapters('就是一段话');
  assert.equal(chapters.length, 1);
  assert.equal(chapters[0].title, '正文');
});

test('extractWebBody 去掉脚本样式导航，取 article/main，标题转 markdown', () => {
  const html = `
    <html><head><style>.x{color:red}</style><script>var a=1;</script></head>
    <body><nav>菜单菜单</nav>
    <article><h1>标题一</h1><p>正文第一段。</p><p>正文第二段。</p></article>
    <footer>版权</footer></body></html>`;
  const text = extractWebBody(html);
  assert.doesNotMatch(text, /菜单菜单/);
  assert.doesNotMatch(text, /color:red/);
  assert.doesNotMatch(text, /版权/);
  assert.match(text, /# 标题一/);
  assert.match(text, /正文第一段/);
  assert.match(text, /正文第二段/);
});

test('buildConversionPrompt 带书名/块序/还原要求', () => {
  const prompt = buildConversionPrompt('原文内容', { index: 1, total: 3, title: '测试书' });
  assert.match(prompt, /《测试书》/);
  assert.match(prompt, /第 2\/3 块/);
  assert.match(prompt, /表格/);
  assert.match(prompt, /原文内容/);
});

test('convertToBook 逐块调模型、拼起来拆章、生成书对象', async () => {
  const calls = [];
  const stream = async (prompt) => {
    calls.push(prompt);
    return calls.length === 1 ? '# 第一章\n\n甲' : '# 第二章\n\n乙';
  };
  const { book, chapters } = await convertToBook(['块一', '块二'], {
    stream,
    meta: { id: 'b1', title: '书', author: '作者', source: 'src' },
  });
  assert.equal(calls.length, 2);
  assert.equal(chapters.length, 2);
  assert.equal(chapters[0].title, '第一章');
  assert.equal(chapters[1].title, '第二章');
  assert.equal(book.id, 'b1');
  assert.equal(book.author, '作者');
});
