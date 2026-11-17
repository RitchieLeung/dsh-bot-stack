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

function mockCtx({ llm } = {}) {
  const routes = [];
  const tools = [];
  const effects = [];
  const prompts = [];
  const llmService = llm || { resolveModelInfo: async () => ({ inputModalities: ['text'] }) };
  const ctx = {
    effect(fn, label) { effects.push(label); fn(); },
    connection: { fetch: { register(def) { routes.push(def); } } },
    inject(names, cb) {
      if (names.includes('tools')) cb({ effect(fn) { fn(); }, tools: { register(def) { tools.push(def); } } });
      if (names.includes('sessionController')) cb({ sessionController: { prompt: async payload => { prompts.push(payload); } } });
      if (names.includes('llm')) cb({ llm: llmService });
      if (names.includes('skills')) cb({ skills: { registerProvider: () => () => {} } });
    },
    get() { return null; },
  };
  return { ctx, routes, tools, effects, prompts };
}

async function post(fetch, body) {
  const response = await fetch(new Request('http://x', { method: 'POST', body: JSON.stringify(body) }));
  return response.json();
}

test('host registers route, 7 tools, writeback, and start routes to a colleague', async () => {
  const statePath = makeState(
    { id: 'bot-1', name: '鲸鱼', sessionId: 'session-main', model: 'x/main' },
    { id: 'bot-2', name: '伟峰', sessionId: 'session-weifeng', model: 'deepseek-official/deepseek-v4-pro', role: '实施', instructions: '后端' },
  );
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
  assert.equal(started.value.assignee.name, '伟峰');
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].sessionId, 'session-main');
  assert.ok(prompts[0].content[0].text.includes('伟峰'));
  assert.ok(prompts[0].content[0].text.includes('message_bot'));
  assert.ok(!prompts[0].content[0].text.includes('list_bots')); // 不再让主 bot 自由挑人
  // 启动成功即进入「进行中」，且执行人已落库，不等 worker 真的起来。
  const after = await post(routes[0].fetch, { action: 'get', id });
  assert.equal(after.value.issue.status, 'dispatched');
  assert.equal(after.value.issue.assignee.name, '伟峰');
});

test('start refuses an image task when no colleague can view images', async () => {
  const statePath = makeState(
    { id: 'bot-1', name: '鲸鱼', sessionId: 'session-main', model: 'x/main' },
    { id: 'bot-2', name: '伟峰', sessionId: 'session-weifeng', model: 'deepseek-official/deepseek-v4-pro', role: '实施' },
  );
  const { ctx, routes, prompts } = mockCtx(); // llm 默认 text-only
  host.apply(ctx, { dbPath: ':memory:', statePath, nodesRoot: '/tmp/definitely-missing-nodes' });
  const fetch = routes[0].fetch;
  const created = await post(fetch, { action: 'create', title: '看图', body: '![图](/api/bot-issue?attachment=abc)' });
  const started = await post(fetch, { action: 'start', id: created.value.issue.id });
  assert.equal(started.value.dispatched, false);
  assert.match(started.value.reason, /看图|vision/);
  assert.equal(prompts.length, 0);
});

test('start routes an image task to a vision-capable colleague', async () => {
  const statePath = makeState(
    { id: 'bot-1', name: '鲸鱼', sessionId: 'session-main', model: 'x/main' },
    { id: 'bot-2', name: '伟峰', sessionId: 'session-weifeng', model: 'deepseek-official/deepseek-v4-pro', role: '实施' },
    { id: 'bot-3', name: 'kiki', sessionId: 'session-kiki', model: 'google/gemini-3.8-flash', role: '协调' },
  );
  const { ctx, routes } = mockCtx({
    llm: { resolveModelInfo: async (_p, model) => ({ inputModalities: model.includes('gemini') ? ['text', 'image'] : ['text'] }) },
  });
  host.apply(ctx, { dbPath: ':memory:', statePath, nodesRoot: '/tmp/definitely-missing-nodes' });
  const fetch = routes[0].fetch;
  const created = await post(fetch, { action: 'create', title: '看图', body: '![图](/api/bot-issue?attachment=abc)' });
  const started = await post(fetch, { action: 'start', id: created.value.issue.id });
  assert.equal(started.value.dispatched, true);
  assert.equal(started.value.assignee.name, 'kiki');
});


test('start refuses to re-dispatch an issue already assigned to an executor', async () => {
  const statePath = makeState(
    { id: 'bot-1', name: '鲸鱼', sessionId: 'session-main', model: 'x/main' },
    { id: 'bot-2', name: '伟峰', sessionId: 'session-weifeng', model: 'deepseek-official/deepseek-v4-pro', role: '实施' },
  );
  const { ctx, routes, prompts } = mockCtx();
  host.apply(ctx, { dbPath: ':memory:', statePath, nodesRoot: '/tmp/definitely-missing-nodes' });
  const fetch = routes[0].fetch;
  const created = await post(fetch, { action: 'create', title: 'X' });
  const id = created.value.issue.id;
  await post(fetch, { action: 'assign', id, sessionId: 'session-weifeng', name: '伟峰' });
  await post(fetch, { action: 'update', id, status: 'dispatched' });
  prompts.length = 0;
  const started = await post(fetch, { action: 'start', id });
  assert.equal(started.value.dispatched, false);
  assert.match(started.value.reason, /执行人/);
  assert.equal(prompts.length, 0);
});

test('没有执行人的 dispatched 老事务允许重派（#7 那种）', async () => {
  const statePath = makeState(
    { id: 'bot-1', name: '鲸鱼', sessionId: 'session-main', model: 'x/main' },
    { id: 'bot-2', name: '伟峰', sessionId: 'session-weifeng', model: 'deepseek-official/deepseek-v4-pro', role: '实施' },
  );
  const { ctx, routes, prompts } = mockCtx({
    llm: { resolveModelInfo: async (_p, model) => ({ inputModalities: model.includes('gemini') ? ['text', 'image'] : ['text'] }) },
  });
  host.apply(ctx, { dbPath: ':memory:', statePath, nodesRoot: '/tmp/definitely-missing-nodes' });
  const fetch = routes[0].fetch;
  const created = await post(fetch, { action: 'create', title: 'X' });
  const id = created.value.issue.id;
  await post(fetch, { action: 'update', id, status: 'dispatched' }); // 手动标 dispatched，没有执行人
  prompts.length = 0;
  const started = await post(fetch, { action: 'start', id });
  assert.equal(started.value.dispatched, true);
  assert.equal(started.value.assignee.name, '伟峰');
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
  // additionalProperties:true 时多出的字段会被放行；声明了的字段必须类型正确。
  const schema = list.output.schema.items;
  assert.equal(schema.additionalProperties, true);
  const declared = Object.keys(schema.properties);
  for (const row of rows) {
    assert.ok(declared.includes('id'));
    assert.ok(declared.includes('title'));
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

test('tool schemas only use single type strings (dsh rejects type arrays like [\'string\',\'null\'])', async () => {
  const statePath = makeState({ id: 'bot-1', name: '鲸鱼', sessionId: 'session-main' });
  const { ctx, tools } = mockCtx();
  host.apply(ctx, { dbPath: ':memory:', statePath, nodesRoot: '/tmp/definitely-missing-nodes', writebackIntervalMs: 999_999 });

  const walk = (node, path, toolName) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.type)) {
      assert.fail(`${toolName} 的 ${path} 用了 type 数组 ${JSON.stringify(node.type)}——dsh 会拒绝，整条工具注册失败`);
    }
    if (node.type !== undefined) assert.equal(typeof node.type, 'string', `${toolName} 的 ${path}.type 必须是字符串`);
    for (const [key, value] of Object.entries(node)) {
      if (key === 'properties') {
        for (const [name, child] of Object.entries(value || {})) walk(child, `${path}.properties.${name}`, toolName);
      } else if (key === 'items') {
        walk(value, `${path}.items`, toolName);
      } else if (key === 'output') {
        walk(value, `${path}.output`, toolName);
      }
    }
  };

  assert.ok(tools.length >= 7);
  for (const tool of tools) {
    walk(tool.parameters, 'parameters', tool.name);
    walk(tool.output?.schema, 'output.schema', tool.name);
  }
});

test('面板打回且没有执行人时，知会主 Bot 接手', async () => {
  const statePath = makeState({ id: 'bot-1', name: '鲸鱼', sessionId: 'session-main', model: 'x/main' });
  const { ctx, routes, prompts } = mockCtx();
  host.apply(ctx, { dbPath: ':memory:', statePath, nodesRoot: '/tmp/definitely-missing-nodes' });
  const fetch = routes[0].fetch;
  const created = await post(fetch, { action: 'create', title: '看图' });
  const id = created.value.issue.id;
  await post(fetch, { action: 'update', id, status: 'dispatched' });
  await post(fetch, { action: 'update', id, status: 'in_review' });
  prompts.length = 0;
  await post(fetch, { action: 'update', id, status: 'dispatched', rejection: '事情没完成' });
  assert.ok(prompts.length >= 1);
  const hit = prompts.find(p => p.sessionId === 'session-main');
  assert.ok(hit && hit.content[0].text.includes('事情没完成'));
});

test('start 把附件本机路径写进派工说明，worker 才能 read_image 看到图', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'issue-host-att-'));
  const statePath = makeState(
    { id: 'bot-1', name: '鲸鱼', sessionId: 'session-main', model: 'x/main' },
    { id: 'bot-2', name: 'kiki', sessionId: 'session-kiki', model: 'google/gemini-3.8-flash', role: '协调' },
  );
  const { ctx, routes, prompts } = mockCtx({
    llm: { resolveModelInfo: async (_p, model) => ({ inputModalities: model.includes('gemini') ? ['text', 'image'] : ['text'] }) },
  });
  host.apply(ctx, { dbPath: join(dir, 'issue.sqlite'), statePath, nodesRoot: '/tmp/definitely-missing-nodes' });
  const fetch = routes[0].fetch;
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const created = await post(fetch, { action: 'create', title: '看图', body: '' });
  const id = created.value.issue.id;
  const uploaded = await post(fetch, { action: 'upload', id, name: 'cover.png', mime: 'image/png', data: png.toString('base64') });
  const url = uploaded.value.image.url;
  await post(fetch, { action: 'update', id, body: `![cover](${url})` });
  const started = await post(fetch, { action: 'start', id });
  assert.equal(started.value.dispatched, true);
  const prompt = prompts.find(p => p.sessionId === 'session-main');
  const txt = prompt.content[0].text;
  assert.match(txt, /read_image/);
  assert.ok(txt.includes(join(dir, 'attachments')), '派工说明里应带附件本机路径');
  assert.match(txt, /不要标待验收假装完成|不要标「待验收」/);
});
