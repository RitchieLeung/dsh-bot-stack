import test from 'node:test';
import assert from 'node:assert/strict';
import { openEbookStore } from '../lib/store.js';
import { createEbookHandler } from '../lib/handler.js';

function make() {
  const store = openEbookStore({ dbPath: ':memory:' });
  store.replaceBook({ id: 'demo', title: '演示书', author: '某人' }, [
    { groupName: '导读', title: '导读', body: '# 导读\n\n开始。' },
    { groupName: '正文', title: '第一章', body: '# 第一章\n\n归约和前缀和。' },
  ]);
  return { handle: createEbookHandler({ store }), store };
}

test('meta lists books with chapter counts', async () => {
  const { handle, store } = make();
  const meta = await handle({ action: 'meta' });
  assert.equal(meta.ok, true);
  assert.equal(meta.value.books.length, 1);
  assert.equal(meta.value.books[0].chapterCount, 2);
  assert.equal(meta.value.stats.chapters, 2);
  store.close();
});

test('book returns the chapter index without bodies', async () => {
  const { handle, store } = make();
  const value = (await handle({ action: 'book', id: 'demo' })).value;
  assert.equal(value.book.title, '演示书');
  assert.deepEqual(value.chapters.map(chapter => chapter.title), ['导读', '第一章']);
  assert.equal(value.chapters[0].body, undefined);
  store.close();
});

test('chapter returns the markdown body and neighbours', async () => {
  const { handle, store } = make();
  const value = (await handle({ action: 'chapter', bookId: 'demo', idx: 1 })).value;
  assert.match(value.chapter.body, /归约/);
  assert.equal(value.prev.idx, 0);
  assert.equal(value.next, null);
  store.close();
});

test('search returns snippets, progress round-trips', async () => {
  const { handle, store } = make();
  const search = (await handle({ action: 'search', query: '归约' })).value;
  assert.equal(search.total, 1);
  assert.match(search.hits[0].snippet, /归约/);

  const saved = (await handle({ action: 'progress', bookId: 'demo', idx: 1, offset: 320 })).value;
  assert.deepEqual({ idx: saved.progress.idx, offset: saved.progress.offset }, { idx: 1, offset: 320 });
  const meta = (await handle({ action: 'meta' })).value;
  assert.equal(meta.books[0].progress.idx, 1);
  store.close();
});

test('bad requests are rejected with codes', async () => {
  const { handle, store } = make();
  assert.equal((await handle('garbage')).error.code, 'INVALID_BODY');
  assert.equal((await handle({ action: 'nope' })).error.code, 'UNKNOWN_ACTION');
  assert.equal((await handle({ action: 'book' })).error.code, 'INVALID_ID');
  assert.equal((await handle({ action: 'chapter', bookId: 'demo' })).error.code, 'INVALID_ID');
  assert.equal((await handle({ action: 'book', id: 'nope' })).error.code, 'NOT_FOUND');
  assert.equal((await handle({ action: 'progress', bookId: 'nope', idx: 0 })).error.code, 'NOT_FOUND');
  store.close();
});

test('models / import_file / import_url / import_commit / ask 路由到注入依赖', async () => {
  const { handle, store } = make();
  const calls = [];
  const preview = { book: { id: 'x', title: '新书' }, chapters: [{ title: '一', body: 'b' }] };
  const handle2 = createEbookHandler({
    store,
    models: async () => ({ groups: [{ id: 'deepseek-official', models: [{ id: 'deepseek-flash' }] }] }),
    ingest: {
      importFile: async (body) => { calls.push(['file', body.name]); return { preview }; },
      importUrl: async (body) => { calls.push(['url', body.url]); return { preview }; },
      commit: (p) => { calls.push(['commit', p.book?.title]); return { book: p.book }; },
    },
    assistant: {
      ask: async (bookId, question) => { calls.push(['ask', bookId, question]); return { answer: '答' }; },
    },
  });

  const models = (await handle2({ action: 'models' })).value;
  assert.equal(models.groups[0].id, 'deepseek-official');
  assert.equal(models.groups[0].models[0].id, 'deepseek-flash');

  assert.equal((await handle2({ action: 'import_file', name: 'a.pdf' })).value.preview, preview);
  assert.equal((await handle2({ action: 'import_url', url: 'https://x' })).value.preview, preview);
  assert.equal((await handle2({ action: 'import_commit', preview })).value.book.title, '新书');
  assert.equal((await handle2({ action: 'ask', bookId: 'demo', question: '讲了啥' })).value.answer, '答');

  assert.deepEqual(calls, [
    ['file', 'a.pdf'],
    ['url', 'https://x'],
    ['commit', '新书'],
    ['ask', 'demo', '讲了啥'],
  ]);
  store.close();
});

test('采集/助手缺失时返回 UNSUPPORTED', async () => {
  const { handle, store } = make();
  assert.equal((await handle({ action: 'models' })).value.groups.length, 0);
  assert.equal((await handle({ action: 'import_url', url: 'https://x' })).error.code, 'UNSUPPORTED');
  assert.equal((await handle({ action: 'ask', bookId: 'demo', question: 'q' })).error.code, 'UNSUPPORTED');
  store.close();
});
