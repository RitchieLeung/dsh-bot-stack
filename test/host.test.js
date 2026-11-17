import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as host from '../lib/host.js';

function makeState(...bots) {
  const dir = mkdtempSync(join(tmpdir(), 'iss-'));
  const file = join(dir, 'state.json');
  writeFileSync(file, JSON.stringify({ bots: Object.fromEntries(bots.map(bot => [bot.id, bot])), mainBotIds: [bots[0].id] }));
  return file;
}

function mockCtx() {
  const routes = [];
  const tools = [];
  const effects = [];
  const prompts = [];
  const ctx = {
    effect(fn, label) { effects.push(label); fn(); },
    connection: { fetch: { register(def) { routes.push(def); } } },
    inject(names, cb) {
      if (names.includes('tools')) cb({ effect(fn) { fn(); }, tools: { register(def) { tools.push(def); } } });
      if (names.includes('sessionController')) cb({ sessionController: { prompt: async payload => { prompts.push(payload); } } });
    },
    get() { return null; },
  };
  return { ctx, routes, tools, effects, prompts };
}

async function post(fetch, body) {
  const response = await fetch(new Request('http://x', { method: 'POST', body: JSON.stringify(body) }));
  return response.json();
}

test('host registers route, 7 tools, writeback, and start prompts the main Bot', async () => {
  const statePath = makeState({ id: 'bot-1', name: '鲸鱼', sessionId: 'session-main' });
  const { ctx, routes, tools, effects, prompts } = mockCtx();
  host.apply(ctx, { dbPath: ':memory:', statePath, nodesRoot: '/tmp/definitely-missing-nodes', writebackIntervalMs: 999_999 });

  assert.equal(routes.length, 1);
  assert.equal(routes[0].path, '/api/bot-issue');
  assert.deepEqual(tools.map(t => t.name), ['issue_create', 'issue_list', 'issue_get', 'issue_update', 'issue_link', 'issue_unlink', 'issue_comment']);
  assert.ok(effects.includes('bot-issue: writeback'));

  const created = await post(routes[0].fetch, { action: 'create', title: '上线', body: '发布到生产' });
  const id = created.value.issue.id;

  const started = await post(routes[0].fetch, { action: 'start', id });
  assert.equal(started.value.dispatched, true);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].sessionId, 'session-main');
  assert.ok(prompts[0].content[0].text.includes(id));
  assert.ok(prompts[0].content[0].text.includes('message_bot'));
  assert.ok(prompts[0].content[0].text.includes('list_bots'));
  // 启动成功即进入「进行中」，不等 worker 真的起来。
  const after = await post(routes[0].fetch, { action: 'get', id });
  assert.equal(after.value.issue.status, 'dispatched');
});

test('start refuses to re-dispatch a dispatched issue', async () => {
  const statePath = makeState({ id: 'bot-1', name: '鲸鱼', sessionId: 'session-main' });
  const { ctx, routes, prompts } = mockCtx();
  host.apply(ctx, { dbPath: ':memory:', statePath, nodesRoot: '/tmp/definitely-missing-nodes' });
  const fetch = routes[0].fetch;
  const created = await post(fetch, { action: 'create', title: 'X' });
  const id = created.value.issue.id;
  // Simulate the poller having already marked the issue dispatched (worker in flight).
  await post(fetch, { action: 'update', id, status: 'dispatched' });
  const started = await post(fetch, { action: 'start', id });
  assert.equal(started.value.dispatched, false);
  assert.equal(prompts.length, 0);
});

test('resolveMainBot reads mainBotIds without hardcoding', () => {
  const statePath = makeState({ id: 'b', name: '小欣', sessionId: 's-xin' });
  const bot = host.resolveMainBot(statePath);
  assert.equal(bot.name, '小欣');
  assert.equal(bot.sessionId, 's-xin');
});

test('a comment that @mentions a bot prompts that bot', async () => {
  const statePath = makeState(
    { id: 'bot-1', name: '鲸鱼', sessionId: 'session-main' },
    { id: 'bot-2', name: '玉清', sessionId: 'session-yu' },
  );
  const { ctx, routes, prompts } = mockCtx();
  host.apply(ctx, { dbPath: ':memory:', statePath, nodesRoot: '/tmp/definitely-missing-nodes' });
  const fetch = routes[0].fetch;
  const created = await post(fetch, { action: 'create', title: 'X' });
  const id = created.value.issue.id;
  await post(fetch, { action: 'comment', id, body: '@玉清 帮忙看下这个', authorKind: 'user' });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].sessionId, 'session-yu');
  assert.ok(prompts[0].content[0].text.includes('玉清'));
  assert.ok(prompts[0].content[0].text.includes('帮忙看下这个'));
});

test('every issue_list field is declared in its output schema', async () => {
  const statePath = makeState({ id: 'bot-1', name: '鲸鱼', sessionId: 'session-main' });
  const { ctx, routes, tools } = mockCtx();
  host.apply(ctx, { dbPath: ':memory:', statePath, nodesRoot: '/tmp/definitely-missing-nodes', writebackIntervalMs: 999_999 });
  const list = tools.find(tool => tool.name === 'issue_list');
  const created = await post(routes[0].fetch, { action: 'create', title: '带父级的事务' });
  await post(routes[0].fetch, { action: 'create', title: '子事务', parentId: created.value.issue.id });
  const rows = await list.execute({});
  assert.ok(rows.length >= 2);
  // 字段必须全部声明：这条工具之前就因为漏了 parentId/updatedAt 而整体报错。
  const declared = Object.keys(list.output.schema.items.properties);
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      assert.ok(declared.includes(key), `issue_list 的 schema 没声明 ${key}`);
    }
  }
});

test('upload via POST then fetch the bytes via GET ?attachment=', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'issue-host-att-'));
  const statePath = makeState({ id: 'bot-1', name: '鲸鱼', sessionId: 'session-main' });
  const { ctx, routes } = mockCtx();
  host.apply(ctx, { dbPath: join(dir, 'issue.sqlite'), statePath, nodesRoot: '/tmp/definitely-missing-nodes', writebackIntervalMs: 999_999 });
  const fetch = routes[0].fetch;

  const issue = await post(fetch, { action: 'create', title: '带图的事务' });
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const uploaded = await post(fetch, {
    action: 'upload', id: issue.value.issue.id, name: '截图.png', mime: 'image/png', data: png.toString('base64'),
  });
  assert.equal(uploaded.ok, true);
  const url = uploaded.value.image.url;
  assert.match(url, /^\/api\/bot-issue\?attachment=/);

  const response = await fetch(new Request(`http://localhost${url}`, { method: 'GET' }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.length, png.length);

  const missing = await fetch(new Request('http://localhost/api/bot-issue?attachment=deadbeef', { method: 'GET' }));
  assert.equal(missing.status, 404);
});

test('upload rejects a non-image mime with a code', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'issue-host-att-'));
  const statePath = makeState({ id: 'bot-1', name: '鲸鱼', sessionId: 'session-main' });
  const { ctx, routes } = mockCtx();
  host.apply(ctx, { dbPath: join(dir, 'issue.sqlite'), statePath, nodesRoot: '/tmp/definitely-missing-nodes' });
  const result = await post(routes[0].fetch, { action: 'upload', name: 'a.pdf', mime: 'application/pdf', data: 'AAAA' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'INVALID_MIME');
});
