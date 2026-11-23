import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as host from '../lib/host.js';
import { openEbookStore } from '../lib/store.js';

function mockCtx() {
  const routes = [];
  const tools = [];
  const effects = [];
  const ctx = {
    effect(fn, label) { effects.push(label); const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {}; },
    inject(names, callback) {
      if (names.includes('tools')) {
        callback({ effect(fn) { effects.push('tool-effect'); const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {}; }, tools: { register(def) { tools.push(def); return () => {}; } } });
      }
    },
    connection: { fetch: { register(def) { routes.push(def); return () => {}; } } },
    llm: { stream: async function* () {} },
    web: { fetch: async () => ({ body: { kind: 'text', content: '' }, statusCode: 200 }) },
    agents: { create: async (options) => ({ agent: { id: options.sessionId }, dispose: async () => {} }) },
    sessionController: {
      modelCatalog: async () => ({ groups: [] }),
      prompt: async () => ({ accepted: true }),
      wait: async () => ({ reason: 'idle', state: { cursor: 0 }, output: { records: [] } }),
    },
  };
  return { ctx, routes, tools, effects };
}

async function post(fetch, body) {
  const request = new Request('http://localhost/api/bot-ebook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const response = await fetch(request);
  return response.json();
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'ebook-host-'));
  const dbPath = join(dir, 'ebook.sqlite');
  const seed = openEbookStore({ dbPath });
  seed.replaceBook({ id: 'demo', title: '演示书', author: '某人' }, [
    { groupName: '导读', title: '导读', body: '# 导读\n\n开篇。' },
    { groupName: '正文', title: '第七章：卷积', body: '# 第七章：卷积\n\n卷积是**归约**的近亲。' },
  ]);
  seed.close();
  const { ctx, routes, tools, effects } = mockCtx();
  host.apply(ctx, { dbPath });
  return { routes, tools, effects, dbPath };
}

test('declares the connection injection (without it a cold boot fails to activate)', async () => {
  const module = await import('../lib/host.js');
  assert.ok(Array.isArray(module.inject), 'host.js 必须导出 inject 数组');
  assert.ok(module.inject.includes('connection'), "inject 必须包含 'connection'");
  for (const key of ['llm', 'web', 'agents', 'sessionController']) {
    assert.ok(module.inject.includes(key), `inject 必须包含 '${key}'（采集/助手依赖）`);
  }
});

test('host registers the HTTP route and does NOT pollute global tools', () => {
  const { routes, tools, effects } = setup();
  assert.equal(routes.length, 1);
  assert.equal(routes[0].path, '/api/bot-ebook');
  assert.deepEqual(tools, [], 'ebook_* 工具只应挂到电子书阅读助手会话，不应全局注册给所有 Bot');
  assert.ok(effects.includes('bot-ebook: HTTP route'));
});

test('the route answers meta and chapter requests', async () => {
  const { routes } = setup();
  const fetch = routes[0].fetch;
  const meta = await post(fetch, { action: 'meta' });
  assert.equal(meta.ok, true);
  assert.equal(meta.value.books[0].title, '演示书');

  const chapter = await post(fetch, { action: 'chapter', bookId: 'demo', idx: 1 });
  assert.match(chapter.value.chapter.body, /归约/);
  assert.equal(chapter.value.prev.idx, 0);
});

test('ebook_list returns the shelf, then the chapters of one book', async () => {
  const { dbPath } = setup();
  const store = openEbookStore({ dbPath });
  try {
    const tools = host.createEbookTools(() => store);
    const list = tools.find(tool => tool.name === 'ebook_list');
    const shelf = await list.execute({});
    assert.equal(shelf.length, 1);
    assert.match(shelf[0].text, /演示书/);
    const chapters = await list.execute({ bookId: 'demo' });
    assert.equal(chapters.length, 2);
    assert.match(chapters[1].text, /第七章：卷积/);
  } finally { store.close(); }
});

test('ebook_read returns the body and flags truncation', async () => {
  const { dbPath } = setup();
  const store = openEbookStore({ dbPath });
  try {
    const tools = host.createEbookTools(() => store);
    const read = tools.find(tool => tool.name === 'ebook_read');
    const value = await read.execute({ bookId: 'demo', idx: 1 });
    assert.match(value.title, /卷积/);
    assert.match(value.body, /归约/);
    assert.equal(value.truncated, false);
    const rendered = read.output.render({}, value);
    assert.match(rendered[0].text, /# 第七章：卷积/);
  } finally { store.close(); }
});

test('ebook_search returns hits with snippets', async () => {
  const { dbPath } = setup();
  const store = openEbookStore({ dbPath });
  try {
    const tools = host.createEbookTools(() => store);
    const search = tools.find(tool => tool.name === 'ebook_search');
    const hits = await search.execute({ query: '归约' });
    assert.equal(hits.length, 1);
    assert.match(hits[0].snippet, /归约/);
    const rendered = search.output.render({}, hits);
    assert.match(rendered[0].text, /\[1\]/);
  } finally { store.close(); }
});

test('ebookPaths honours config and DSH_HOME', () => {
  const withConfig = host.ebookPaths({ dbPath: '/tmp/x/ebook.sqlite' });
  assert.equal(withConfig.dbPath, '/tmp/x/ebook.sqlite');
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = '/tmp/fake-home';
  try {
    assert.equal(host.ebookPaths().dbPath, '/tmp/fake-home/bot/ebook/ebook.sqlite');
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
});
