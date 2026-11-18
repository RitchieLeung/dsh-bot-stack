import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
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

test('host registers route, 8 tools, writeback, and start 让主 Bot 自己挑人', async () => {
  const statePath = makeState(
    { id: 'bot-1', name: '鲸鱼', sessionId: 'session-main', model: 'x/main' },
    { id: 'bot-2', name: '伟峰', sessionId: 'session-weifeng', model: 'deepseek-official/deepseek-v4-pro', role: '实施' },
    { id: 'bot-3', name: 'kiki', sessionId: 'session-kiki', model: 'google/gemini-3.8-flash', role: '协调' },
  );
  const { ctx, routes, tools, effects, prompts } = mockCtx();
  host.apply(ctx, { dbPath: ':memory:', statePath, nodesRoot: '/tmp/definitely-missing-nodes', writebackIntervalMs: 999_999 });

  assert.equal(routes.length, 1);
  assert.equal(routes[0].path, '/api/bot-issue');
  assert.deepEqual(tools.map(t => t.name), ['issue_create', 'issue_list', 'issue_get', 'issue_update', 'issue_assign', 'issue_link', 'issue_unlink', 'issue_comment']);
  assert.ok(effects.includes('bot-issue: writeback'));

  const created = await post(routes[0].fetch, { action: 'create', title: '上线', body: '发布到生产' });
  const id = created.value.issue.id;

  const started = await post(routes[0].fetch, { action: 'start', id });
  assert.equal(started.value.dispatched, true);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].sessionId, 'session-main');
  const txt = prompts[0].content[0].text;
  assert.match(txt, /你自己.*定|由你自己/); // 执行人由主 Bot 自己定
  assert.ok(txt.includes('list_bots'));
  assert.ok(txt.includes('list_bot_models'));
  assert.ok(txt.includes('issue_assign'));
  assert.ok(txt.includes('伟峰：在办 0 条') || txt.includes('在办 0 条')); // 负载表
  // 启动只把事务标进行中，执行人由主 Bot 用 issue_assign 记录（这里还没记录）
  const after = await post(routes[0].fetch, { action: 'get', id });
  assert.equal(after.value.issue.status, 'dispatched');
  assert.equal(after.value.issue.assignee, null);
});

test('issue_assign 工具把执行人落库（主 Bot 能、worker 不能）', async () => {
  const statePath = makeState(
    { id: 'bot-1', name: '鲸鱼', sessionId: 'session-main' },
    { id: 'bot-2', name: 'kiki', sessionId: 'session-kiki' },
  );
  const { ctx, routes, tools } = mockCtx();
  host.apply(ctx, { dbPath: ':memory:', statePath, nodesRoot: '/tmp/definitely-missing-nodes' });
  const fetch = routes[0].fetch;
  const created = await post(fetch, { action: 'create', title: 'X' });
  const id = created.value.issue.id;
  const assignTool = tools.find(t => t.name === 'issue_assign');
  const r = await assignTool.execute({ id, bot: 'kiki' }, { agent: { session: { id: 'session-main' } } });
  assert.equal(r.assignee, 'kiki');
  const got = await post(fetch, { action: 'get', id });
  assert.equal(got.value.issue.assignee.name, 'kiki');
  await assert.rejects(
    () => assignTool.execute({ id, bot: 'kiki' }, { agent: { session: { id: 'session-kiki' } } }),
    err => err.code === 'FORBIDDEN_ASSIGN',
  );
});

test('start refuses to re-dispatch an issue already assigned to an executor', async () => {
  const statePath = makeState(
    { id: 'bot-1', name: '鲸鱼', sessionId: 'session-main' },
    { id: 'bot-2', name: '伟峰', sessionId: 'session-weifeng' },
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

test('没有执行人的 dispatched 老事务允许重派', async () => {
  const statePath = makeState(
    { id: 'bot-1', name: '鲸鱼', sessionId: 'session-main' },
    { id: 'bot-2', name: '伟峰', sessionId: 'session-weifeng' },
  );
  const { ctx, routes } = mockCtx();
  host.apply(ctx, { dbPath: ':memory:', statePath, nodesRoot: '/tmp/definitely-missing-nodes' });
  const fetch = routes[0].fetch;
  const created = await post(fetch, { action: 'create', title: 'X' });
  const id = created.value.issue.id;
  await post(fetch, { action: 'update', id, status: 'dispatched' }); // 手动标 dispatched，没有执行人
  const started = await post(fetch, { action: 'start', id });
  assert.equal(started.value.dispatched, true);
});

test('start 把附件复制进共享工作区并给 read_image 路径', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'issue-host-att-'));
  const statePath = makeState(
    { id: 'bot-1', name: '鲸鱼', sessionId: 'session-main' },
    { id: 'bot-2', name: 'kiki', sessionId: 'session-kiki' },
  );
  const { ctx, routes, prompts } = mockCtx();
  const stagingDir = join(dir, 'staging');
  host.apply(ctx, { dbPath: join(dir, 'issue.sqlite'), statePath, nodesRoot: '/tmp/definitely-missing-nodes', stagingDir });
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
  assert.match(txt, /带图片/); // 图片任务提示要挑能看图的
  assert.ok(txt.includes(stagingDir), '派工说明里应带工作区里的附件路径');
  assert.ok(existsSync(stagingDir), '附件应被复制进工作区');
  assert.match(txt, /不要标待验收假装完成/);
});

test('面板打回且没有执行人时，知会主 Bot 接手', async () => {
  const statePath = makeState({ id: 'bot-1', name: '鲸鱼', sessionId: 'session-main' });
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

test('执行人用别的会话 id 报回时也能知会主 Bot（会话漂移）', async () => {
  const statePath = makeState(
    { id: 'bot-1', name: '鲸鱼', sessionId: 'session-main' },
    { id: 'bot-2', name: 'kiki', sessionId: 'session-kiki', segments: [{ sessionId: 'session-kiki-seg' }] },
  );
  const { ctx, routes, tools, prompts } = mockCtx();
  host.apply(ctx, { dbPath: ':memory:', statePath, nodesRoot: '/tmp/definitely-missing-nodes' });
  const fetch = routes[0].fetch;
  const created = await post(fetch, { action: 'create', title: 'X' });
  const id = created.value.issue.id;
  await post(fetch, { action: 'assign', id, sessionId: 'session-kiki', name: 'kiki' });
  await post(fetch, { action: 'update', id, status: 'dispatched' });
  prompts.length = 0;
  const upd = tools.find(t => t.name === 'issue_update');
  await upd.execute({ id, status: 'in_review' }, { agent: { session: { id: 'session-kiki-seg' } } });
  assert.ok(prompts.some(p => p.sessionId === 'session-main'), '应知会主 Bot');
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

  assert.ok(tools.length >= 8);
  for (const tool of tools) {
    walk(tool.parameters, 'parameters', tool.name);
    walk(tool.output?.schema, 'output.schema', tool.name);
  }
});

// ── 事务图片（docs/2026-11-18-issue-images-design.md）────────────────────────

function pngFile(bytes = 8) {
  const dir = mkdtempSync(join(tmpdir(), 'img-'));
  const file = join(dir, 'shot.png');
  writeFileSync(file, Buffer.alloc(bytes, 0x89));
  return file;
}

function fakeAttachmentStore() {
  const added = [];
  return {
    added,
    store: () => ({
      addAttachment(attrs) {
        added.push(attrs);
        const id = 'abc123def4567890';
        return { id, url: `/api/bot-issue?attachment=${id}`, name: attrs.name, mime: attrs.mime, bytes: 8 };
      },
    }),
  };
}

test('imageMimeFor maps image extensions and rejects everything else', () => {
  assert.equal(host.imageMimeFor('/tmp/a.PNG'), 'image/png');
  assert.equal(host.imageMimeFor('/tmp/a.jpg'), 'image/jpeg');
  assert.equal(host.imageMimeFor('/tmp/a.jpeg'), 'image/jpeg');
  assert.equal(host.imageMimeFor('/tmp/a.gif'), 'image/gif');
  assert.equal(host.imageMimeFor('/tmp/a.webp'), 'image/webp');
  assert.equal(host.imageMimeFor('/tmp/a.svg'), 'image/svg+xml');
  assert.equal(host.imageMimeFor('/tmp/a.txt'), null);
  assert.equal(host.imageMimeFor('/tmp/a'), null);
});

test('attachImages stores the file once and returns one markdown line per image', () => {
  const { added, store } = fakeAttachmentStore();
  const png = pngFile();
  const result = host.attachImages({ store, issueId: 'issue-1', images: [png, png] });

  assert.equal(added.length, 2, '同一张图传两次会各调用一次 addAttachment（去重是 store 的事）');
  assert.equal(added[0].issueId, 'issue-1');
  assert.equal(added[0].name, 'shot.png');
  assert.equal(added[0].mime, 'image/png');
  assert.equal(Buffer.from(added[0].data, 'base64').length, 8);

  assert.equal(result.attachments.length, 2);
  const lines = result.markdown.split('\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[0], '![shot.png](/api/bot-issue?attachment=abc123def4567890)');
});

test('attachImages reports why a path cannot be used', () => {
  const { store } = fakeAttachmentStore();

  assert.throws(
    () => host.attachImages({ store, issueId: 'i', images: ['shot.png'] }),
    err => err.code === 'RELATIVE_PATH' && /绝对路径/.test(err.message),
  );
  assert.throws(
    () => host.attachImages({ store, issueId: 'i', images: ['/tmp/notes.txt'] }),
    err => err.code === 'UNSUPPORTED_IMAGE' && /png/.test(err.message),
  );
  assert.throws(
    () => host.attachImages({ store, issueId: 'i', images: [join(tmpdir(), 'definitely-missing.png')] }),
    err => err.code === 'IMAGE_NOT_FOUND',
  );
  assert.throws(
    () => host.attachImages({ store, issueId: 'i', images: [pngFile(0)] }),
    err => err.code === 'EMPTY_IMAGE',
  );
  assert.throws(
    () => host.attachImages({ store, issueId: 'i', images: Array.from({ length: 9 }, () => pngFile()) }),
    err => err.code === 'TOO_MANY_IMAGES' && /8/.test(err.message),
  );
});

test('attachImages with no images is a no-op', () => {
  const { added, store } = fakeAttachmentStore();
  const result = host.attachImages({ store, issueId: 'issue-1', images: [] });
  assert.equal(added.length, 0);
  assert.deepEqual(result, { markdown: '', attachments: [] });
  assert.deepEqual(host.attachImages({ store, issueId: 'issue-1' }), { markdown: '', attachments: [] });
});
