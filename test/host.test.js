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

test('host registers route, 5 tools, writeback, and start prompts the main Bot', async () => {
  const statePath = makeState({ id: 'bot-1', name: '鲸鱼', sessionId: 'session-main' });
  const { ctx, routes, tools, effects, prompts } = mockCtx();
  host.apply(ctx, { dbPath: ':memory:', statePath, nodesRoot: '/tmp/definitely-missing-nodes', writebackIntervalMs: 999_999 });

  assert.equal(routes.length, 1);
  assert.equal(routes[0].path, '/api/bot-issue');
  assert.deepEqual(tools.map(t => t.name), ['issue_create', 'issue_list', 'issue_get', 'issue_update', 'issue_comment']);
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
