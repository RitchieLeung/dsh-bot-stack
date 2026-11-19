import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openEbookStore } from '../lib/store.js';

function fresh() {
  return openEbookStore({ dbPath: ':memory:' });
}

const book = (chapters = 3) => ({
  id: 'demo',
  title: '演示书',
  author: '某人',
  source: 'https://example.com',
  description: '说明',
});

const chapters = count => Array.from({ length: count }, (_, index) => ({
  groupName: index === 0 ? '导读' : '正文',
  title: `第 ${index + 1} 节`,
  body: `# 第 ${index + 1} 节\n\n这是第 ${index + 1} 节的内容，里面有**归约**两个字。`,
}));

test('replaceBook stores chapters in order and listBooks reports counts', () => {
  const store = fresh();
  store.replaceBook(book(), chapters(3));
  const books = store.listBooks();
  assert.equal(books.length, 1);
  assert.equal(books[0].id, 'demo');
  assert.equal(books[0].chapterCount, 3);
  assert.ok(books[0].chars > 0);
  const detail = store.getBook('demo');
  assert.deepEqual(detail.chapters.map(chapter => chapter.idx), [0, 1, 2]);
  assert.equal(detail.chapters[0].groupName, '导读');
  assert.equal(detail.chapters[1].groupName, '正文');
  store.close();
});

test('getChapter returns neighbours for 上一章/下一章', () => {
  const store = fresh();
  store.replaceBook(book(), chapters(3));
  const first = store.getChapter('demo', 0);
  assert.equal(first.prev, null);
  assert.equal(first.next.idx, 1);
  assert.equal(first.position.index, 0);
  assert.equal(first.position.total, 3);
  const middle = store.getChapter('demo', 1);
  assert.equal(middle.prev.idx, 0);
  assert.equal(middle.next.idx, 2);
  assert.match(middle.chapter.body, /归约/);
  store.close();
});

test('unknown book and chapter are NOT_FOUND', () => {
  const store = fresh();
  assert.throws(() => store.getBook('nope'), err => err.code === 'NOT_FOUND');
  store.replaceBook(book(), chapters(2));
  assert.throws(() => store.getChapter('demo', 9), err => err.code === 'NOT_FOUND');
  store.close();
});

test('replaceBook is idempotent and keeps the reading position (clamped)', () => {
  const store = fresh();
  store.replaceBook(book(), chapters(5));
  store.saveProgress('demo', 3, 480);
  const again = store.replaceBook(book(), chapters(5));
  assert.equal(again.chapterCount, 5);
  assert.deepEqual({ idx: again.progress.idx, offset: again.progress.offset }, { idx: 3, offset: 480 });
  // 书变短了，位置要夹到最后一章而不是丢失
  const shorter = store.replaceBook(book(), chapters(2));
  assert.equal(shorter.progress.idx, 1);
  store.close();
});

test('progress saves and clamps out-of-range chapters', () => {
  const store = fresh();
  store.replaceBook(book(), chapters(3));
  assert.deepEqual(store.saveProgress('demo', 99, 100).idx, 2);
  assert.deepEqual(store.saveProgress('demo', -5, -9).idx, 0);
  const saved = store.listBooks()[0].progress;
  assert.equal(saved.offset, 0);
  store.close();
});

test('search finds chapters by body and reports a snippet', () => {
  const store = fresh();
  store.replaceBook(book(), chapters(3));
  const result = store.search('归约');
  assert.equal(result.total, 3);
  assert.equal(result.hits[0].bookId, 'demo');
  assert.match(result.hits[0].snippet, /归约/);
  assert.deepEqual(store.search('不存在的词').hits, []);
  assert.deepEqual(store.search('   ').hits, []);
  store.close();
});

test('search escapes LIKE wildcards', () => {
  const store = fresh();
  store.replaceBook(book(), [{ groupName: '正文', title: '百分比', body: '命中 50% 的样本' }]);
  assert.equal(store.search('50%').total, 1);
  assert.equal(store.search('%').total, 1);
  store.close();
});

test('two books coexist and search can be scoped to one', () => {
  const store = fresh();
  store.replaceBook(book(), chapters(2));
  store.replaceBook({ ...book(), id: 'other', title: '另一本' }, [{ groupName: '正文', title: '别的章', body: '归约在这里也出现' }]);
  assert.equal(store.listBooks().length, 2);
  assert.equal(store.search('归约').total, 3);
  assert.equal(store.search('归约', { bookId: 'other' }).total, 1);
  store.close();
});

test('deleteBook removes the book, its chapters and its progress', () => {
  const store = fresh();
  store.replaceBook(book(), chapters(2));
  store.saveProgress('demo', 1, 10);
  store.deleteBook('demo');
  assert.equal(store.listBooks().length, 0);
  assert.deepEqual(store.stats(), { books: 0, chapters: 0, chars: 0 });
  store.close();
});

test('the store opens a fresh file path and creates the directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ebook-store-'));
  const dbPath = join(dir, 'nested', 'ebook.sqlite');
  const store = openEbookStore({ dbPath });
  store.replaceBook(book(), chapters(1));
  store.close();
  const reopened = openEbookStore({ dbPath });
  assert.equal(reopened.listBooks()[0].chapterCount, 1);
  reopened.close();
});
