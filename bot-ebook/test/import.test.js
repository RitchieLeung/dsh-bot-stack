import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chineseNumber, splitFrontmatter, collectChapters } from '../scripts/import-pmpp.mjs';

test('chineseNumber handles the numerals this book uses', () => {
  assert.equal(chineseNumber('一'), 1);
  assert.equal(chineseNumber('九'), 9);
  assert.equal(chineseNumber('十'), 10);
  assert.equal(chineseNumber('十一'), 11);
  assert.equal(chineseNumber('二十'), 20);
  assert.equal(chineseNumber('二十二'), 22);
  assert.equal(chineseNumber('07'), 7);
  assert.equal(chineseNumber('nope'), null);
});

test('splitFrontmatter strips the YAML block and keeps the body', () => {
  const { meta, body } = splitFrontmatter('---\ntitle: 第七章：卷积\nabbrlink: 10d278b0\n---\n\n## 前言\n正文');
  assert.equal(meta.title, '第七章：卷积');
  assert.equal(meta.abbrlink, '10d278b0');
  assert.match(body, /^## 前言/);
  assert.equal(splitFrontmatter('没有 frontmatter\n').body, '没有 frontmatter');
});

/** 造一个迷你仓库，形状和 psmarter/PMPP-Learning 一致。 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ebook-import-'));
  mkdirSync(join(root, 'Blogs'), { recursive: true });
  mkdirSync(join(root, 'Exercises', 'Chapter02'), { recursive: true });
  mkdirSync(join(root, 'Exercises', 'Chapter10'), { recursive: true });
  writeFileSync(join(root, 'README.md'), '# 仓库说明\n\n> 引用\n\n这是仓库的第一段说明。\n');
  writeFileSync(join(root, 'Blogs', 'PMPP-大规模并行处理器程序设计：导读.md'), '---\ntitle: PMPP-导读\n---\n\n## 全书怎么读\n');
  writeFileSync(join(root, 'Blogs', 'PMPP-第一章：引言.md'), '---\ntitle: PMPP-第一章：引言\n---\n\n## 前言\n第一章正文\n');
  writeFileSync(join(root, 'Blogs', 'PMPP-第十章：归约和最小化发散.md'), '---\ntitle: PMPP-第十章：归约和最小化发散\n---\n\n## 归约\n');
  writeFileSync(join(root, 'Blogs', 'PMPP-第二十二章：高级实践与未来演变.md'), '---\ntitle: PMPP-第二十二章：高级实践与未来演变\n---\n\n## 未来\n');
  writeFileSync(join(root, 'Exercises', 'Chapter02', 'README.md'), '# 第二章：异构数据并行计算\n\n习题解答\n');
  writeFileSync(join(root, 'Exercises', 'Chapter10', 'README.md'), '# 第十章：归约\n\n习题解答\n');
  return root;
}

test('collectChapters orders 导读 → 正文 → 习题 → 附录', () => {
  const chapters = collectChapters(fixture());
  assert.deepEqual(chapters.map(chapter => `${chapter.groupName}/${chapter.title}`), [
    '导读/全书导读',
    '正文/第一章：引言',
    '正文/第十章：归约和最小化发散',
    '正文/第二十二章：高级实践与未来演变',
    '习题/第二章：异构数据并行计算 · 习题解答',
    '习题/第十章：归约 · 习题解答',
    '附录/仓库说明',
  ]);
  // frontmatter 不进正文
  assert.ok(!chapters[1].body.includes('abbrlink'));
  assert.ok(!chapters[1].body.startsWith('---'));
  assert.match(chapters[1].body, /第一章正文/);
});

test('collectChapters refuses a directory without any markdown', () => {
  const empty = mkdtempSync(join(tmpdir(), 'ebook-empty-'));
  assert.throws(() => collectChapters(empty), /没在/);
});
