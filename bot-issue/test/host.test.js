import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
  const rpcPrompts = [];
  const messages = [];
  const flushed = [];
  const ctx = {
    effect(fn, label) { effects.push(label); fn(); },
    connection: { fetch: { register(def) { routes.push(def); } } },
    inject(names, cb) {
      if (names.includes('tools')) cb({ effect(fn) { fn(); }, tools: { register(def) { tools.push(def); } } });
      if (names.includes('sessions')) cb({ sessions: { flush: async session => { flushed.push(session.id); } } });
      if (names.includes('sessionController')) {
        cb({
          sessionController: {
            resolveAgent: async sessionId => ({
              agent: {
                id: sessionId,
                session: { id: sessionId },
                followup: msg => {
                  prompts.push({ sessionId, ...msg });
                  messages.push({ sessionId, raw: msg, ...msg });
                },
              },
            }),
            prompt: async payload => {
              rpcPrompts.push(payload);
              prompts.push(payload);
            },
          },
        });
      }
      if (names.includes('skills')) cb({ skills: { registerProvider: () => () => {} } });
    },
    get() { return null; },
  };
  return { ctx, routes, tools, effects, prompts, rpcPrompts, messages, flushed };
}

async function post(fetch, body) {
  const response = await fetch(new Request('http://x', { method: 'POST', body: JSON.stringify(body) }));
  return response.json();
}

test('host registers route, 8 tools, writeback, and start 以系统事件 + system-reminder 交给主 Bot', async () => {
  const statePath = makeState(
    { id: 'bot-1', name: '鲸鱼', sessionId: 'session-main', model: 'x/main' },
    { id: 'bot-2', name: '伟峰', sessionId: 'session-weifeng', model: 'deepseek-official/deepseek-v4-pro', role: '实施' },
    { id: 'bot-3', name: 'kiki', sessionId: 'session-kiki', model: 'google/gemini-3.8-flash', role: '协调' },
  );
  const { ctx, routes, tools, effects, rpcPrompts, messages, flushed } = mockCtx();
  host.apply(ctx, { dbPath: ':memory:', statePath, nodesRoot: '/tmp/definitely-missing-nodes', writebackIntervalMs: 999_999 });

  assert.equal(routes.length, 1);
  assert.equal(routes[0].path, '/api/bot-issue');
  assert.deepEqual(tools.map(t => t.name), ['issue_create', 'issue_list', 'issue_get', 'issue_update', 'issue_assign', 'issue_link', 'issue_unlink', 'issue_comment']);
  assert.ok(effects.includes('bot-issue: writeback'));

  const created = await post(routes[0].fetch, { action: 'create', title: '上线', body: '发布到生产' });
  const id = created.value.issue.id;

  const started = await post(routes[0].fetch, { action: 'start', id });
  assert.equal(started.value.dispatched, true);
  assert.doesNotMatch(started.value.note || '', /message_bot|issue_assign/, '返回给 UI 的提示不暴露内部工具名');
  assert.equal(rpcPrompts.length, 0, '不能走普通用户 RPC prompt');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].sessionId, 'session-main');
  assert.equal(messages[0].source?.kind, 'bot-issue', '必须是非 user 来源，才能在聊天里呈现为事件折叠卡而非普通用户气泡');
  assert.equal(messages[0].source?.form, 'notice');
  assert.ok(typeof messages[0].source?.summary === 'string' && messages[0].source.summary.length > 0);
  assert.ok(Object.isFrozen(messages[0].raw) && Object.isFrozen(messages[0].source));
  assert.ok(flushed.includes('session-main'));

  const txt = messages[0].content[0].text;
  assert.match(txt, /^<system-reminder>[\s\S]*<\/system-reminder>/, '应使用 <system-reminder> 承载原则提示');
  assert.match(txt, /issue-workflow/, '详细规则交由 skill 承载');
  assert.doesNotMatch(txt, /步骤：\s*\n1\./, '不再在通知正文里硬编码长篇步骤清单');
  assert.doesNotMatch(txt, /不要说「你指定的」/, '不再硬写话术说教');
  assert.ok(txt.includes('伟峰：在办 0 条') || txt.includes('在办 0 条')); // 运行时负载快照仍需保留
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
  assert.match(txt, /^<system-reminder>[\s\S]*<\/system-reminder>/);
  assert.match(txt, /read_image/);
  assert.match(txt, /含图片|带图片/); // 图片任务提示要确认看图能力
  assert.ok(txt.includes(stagingDir), '派工说明里应带工作区里的附件路径');
  assert.ok(existsSync(stagingDir), '附件应被复制进工作区');
  assert.doesNotMatch(txt, /不要标待验收假装完成/);
});

test('面板打回且没有执行人时，以事件卡片和 system-reminder 知会主 Bot（不含冗余口语 hint）', async () => {
  const statePath = makeState({ id: 'bot-1', name: '鲸鱼', sessionId: 'session-main' });
  const { ctx, routes, messages } = mockCtx();
  host.apply(ctx, { dbPath: ':memory:', statePath, nodesRoot: '/tmp/definitely-missing-nodes' });
  const fetch = routes[0].fetch;
  const created = await post(fetch, { action: 'create', title: '看图' });
  const id = created.value.issue.id;
  await post(fetch, { action: 'update', id, status: 'dispatched' });
  await post(fetch, { action: 'update', id, status: 'in_review' });
  messages.length = 0;
  await post(fetch, { action: 'update', id, status: 'dispatched', rejection: '事情没完成' });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(messages.length >= 1);
  const hit = messages.find(p => p.sessionId === 'session-main');
  assert.ok(hit && hit.content[0].text.includes('事情没完成'));
  assert.equal(hit.source?.kind, 'bot-issue');
  assert.equal(hit.source?.form, 'notice');
  assert.match(hit.content[0].text, /^<system-reminder>[\s\S]*<\/system-reminder>/);
  assert.doesNotMatch(hit.content[0].text, /这条还没有执行人，需要你来派工/);
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

/** 图片相关测试要真实文件库：:memory: 的 store 没有附件目录。 */
function tempDb() {
  return join(mkdtempSync(join(tmpdir(), 'iss-db-')), 'issue.sqlite');
}

/** 真正的 1x1 PNG —— 现在按文件头嗅探，假字节会被 NOT_AN_IMAGE 挡掉。 */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

function pngFile() {
  const dir = mkdtempSync(join(tmpdir(), 'img-'));
  const file = join(dir, 'shot.png');
  writeFileSync(file, PNG_BYTES);
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
  assert.equal(host.imageMimeFor('/tmp/a.txt'), null);
  assert.equal(host.imageMimeFor('/tmp/a.svg'), null, 'svg 不在 Bot 白名单里（设计非目标）');
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
  assert.equal(Buffer.from(added[0].data, 'base64').length, PNG_BYTES.length);

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
  const emptyDir = mkdtempSync(join(tmpdir(), 'empty-'));
  const empty = join(emptyDir, 'empty.png');
  writeFileSync(empty, Buffer.alloc(0));
  assert.throws(
    () => host.attachImages({ store, issueId: 'i', images: [empty] }),
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

test('issue_comment appends image markdown and stores the attachment', async () => {
  const statePath = makeState({ id: 'bot-1', name: '鲸鱼', sessionId: 'session-main' });
  const { ctx, routes, tools } = mockCtx();
  host.apply(ctx, { dbPath: tempDb(), statePath, nodesRoot: '/tmp/definitely-missing-nodes', writebackIntervalMs: 999_999 });
  const fetch = routes[0].fetch;
  const created = await post(fetch, { action: 'create', title: '登录页', body: '看看' });
  const id = created.value.issue.id;
  const exec = { agent: { session: { id: 'session-main' } } };

  const comment = tools.find(t => t.name === 'issue_comment');
  const out = await comment.execute({ id, body: '登录页改好了', images: [pngFile()] }, exec);
  assert.equal(out.images, 1);

  const got = await tools.find(t => t.name === 'issue_get').execute({ id }, exec);
  const last = got.comments.at(-1);
  assert.match(last, /登录页改好了/);
  assert.match(last, /!\[shot\.png\]\(\/api\/bot-issue\?attachment=[0-9a-f]+\)/);
});

test('issue_comment allows an images-only comment but still rejects an empty one', async () => {
  const statePath = makeState({ id: 'bot-1', name: '鲸鱼', sessionId: 'session-main' });
  const { ctx, routes, tools } = mockCtx();
  host.apply(ctx, { dbPath: tempDb(), statePath, nodesRoot: '/tmp/definitely-missing-nodes', writebackIntervalMs: 999_999 });
  const created = await post(routes[0].fetch, { action: 'create', title: 'X' });
  const id = created.value.issue.id;
  const exec = { agent: { session: { id: 'session-main' } } };
  const comment = tools.find(t => t.name === 'issue_comment');

  const only = await comment.execute({ id, body: '', images: [pngFile()] }, exec);
  assert.equal(only.images, 1);

  await assert.rejects(
    () => comment.execute({ id, body: '   ' }, exec),
    err => /评论不能为空/.test(err.message),
  );
});

test('issue_create appends image markdown to the new body', async () => {
  const statePath = makeState({ id: 'bot-1', name: '鲸鱼', sessionId: 'session-main' });
  const { ctx, tools } = mockCtx();
  host.apply(ctx, { dbPath: tempDb(), statePath, nodesRoot: '/tmp/definitely-missing-nodes', writebackIntervalMs: 999_999 });
  const exec = { agent: { session: { id: 'session-main' } } };

  const created = await tools.find(t => t.name === 'issue_create')
    .execute({ title: '看图', body: '对比一下这两版', images: [pngFile()] }, exec);
  const got = await tools.find(t => t.name === 'issue_get').execute({ id: created.id }, exec);
  assert.match(got.body, /对比一下这两版/);
  assert.match(got.body, /!\[shot\.png\]\(\/api\/bot-issue\?attachment=[0-9a-f]+\)/);
});

test('issue_update with images only appends to the existing body', async () => {
  const statePath = makeState({ id: 'bot-1', name: '鲸鱼', sessionId: 'session-main' });
  const { ctx, tools } = mockCtx();
  host.apply(ctx, { dbPath: tempDb(), statePath, nodesRoot: '/tmp/definitely-missing-nodes', writebackIntervalMs: 999_999 });
  const exec = { agent: { session: { id: 'session-main' } } };
  const create = tools.find(t => t.name === 'issue_create');
  const update = tools.find(t => t.name === 'issue_update');
  const get = tools.find(t => t.name === 'issue_get');

  const created = await create.execute({ title: '原文', body: '原始正文' }, exec);
  const png = pngFile();

  await update.execute({ id: created.id, images: [png] }, exec);
  let got = await get.execute({ id: created.id }, exec);
  assert.match(got.body, /原始正文/, '只带图不能把正文清空');
  assert.equal((got.body.match(/!\[shot\.png\]/g) || []).length, 1);

  // 再贴一次：追加（同图去重是 store 的事，正文里允许两行）
  await update.execute({ id: created.id, images: [png] }, exec);
  got = await get.execute({ id: created.id }, exec);
  assert.equal((got.body.match(/!\[shot\.png\]/g) || []).length, 2);
  assert.match(got.body, /原始正文/);
});

test('issue_get stages comment images and returns a readable local path', async () => {
  const statePath = makeState({ id: 'bot-1', name: '鲸鱼', sessionId: 'session-main' });
  const stagingDir = join(mkdtempSync(join(tmpdir(), 'stage-')), 'issue-attachments');
  const { ctx, tools } = mockCtx();
  host.apply(ctx, { dbPath: tempDb(), statePath, stagingDir, nodesRoot: '/tmp/definitely-missing-nodes', writebackIntervalMs: 999_999 });
  const exec = { agent: { session: { id: 'session-main' } } };
  const create = tools.find(t => t.name === 'issue_create');
  const comment = tools.find(t => t.name === 'issue_comment');
  const get = tools.find(t => t.name === 'issue_get');

  const created = await create.execute({ title: '带图的评论', body: '正文没有图' }, exec);
  await comment.execute({ id: created.id, body: '截图在这', images: [pngFile()] }, exec);

  const got = await get.execute({ id: created.id }, exec);
  assert.equal(got.attachments.length, 1);
  const [att] = got.attachments;
  assert.match(att.where, /^comment:\d+$/);
  assert.equal(att.name, 'shot.png');
  assert.equal(att.mime, 'image/png');
  assert.ok(att.path && existsSync(att.path), 'path 必须真实存在，Bot 才能 read_image');
  assert.equal(readFileSync(att.path).length, PNG_BYTES.length);
});

test('issue_get dedupes the same attachment and staging is idempotent', async () => {
  const statePath = makeState({ id: 'bot-1', name: '鲸鱼', sessionId: 'session-main' });
  const stagingDir = join(mkdtempSync(join(tmpdir(), 'stage-')), 'issue-attachments');
  const { ctx, tools } = mockCtx();
  host.apply(ctx, { dbPath: tempDb(), statePath, stagingDir, nodesRoot: '/tmp/definitely-missing-nodes', writebackIntervalMs: 999_999 });
  const exec = { agent: { session: { id: 'session-main' } } };
  const create = tools.find(t => t.name === 'issue_create');
  const comment = tools.find(t => t.name === 'issue_comment');
  const get = tools.find(t => t.name === 'issue_get');
  const png = pngFile();

  // 同一张图：正文一次、评论一次
  const created = await create.execute({ title: '同一张图', body: '先看这张', images: [png] }, exec);
  await comment.execute({ id: created.id, body: '再贴一次同一张', images: [png] }, exec);

  const first = await get.execute({ id: created.id }, exec);
  assert.equal(first.attachments.length, 1, '同一个附件 id 只返回一条');

  const second = await get.execute({ id: created.id }, exec);
  assert.equal(second.attachments[0].path, first.attachments[0].path, '两次调用落到同一个文件');
  const files = readdirSync(dirname(first.attachments[0].path));
  assert.equal(files.length, 1, 'stage 目录里只有一个文件，不会无限增长');
});

// ── 复审轮：缺陷复现（自审发现）────────────────────────────────────────────

let lastDbPath = null;
function countAttachmentFiles() {
  const dir = join(dirname(lastDbPath), 'attachments');
  return existsSync(dir) ? readdirSync(dir).length : 0;
}

function applyHost(extra = {}) {
  const statePath = makeState({ id: 'bot-1', name: '鲸鱼', sessionId: 'session-main' });
  const stagingDir = join(mkdtempSync(join(tmpdir(), 'stage-')), 'issue-attachments');
  const { ctx, routes, tools } = mockCtx();
  lastDbPath = tempDb();
  host.apply(ctx, { dbPath: lastDbPath, statePath, stagingDir, nodesRoot: '/tmp/definitely-missing-nodes', writebackIntervalMs: 999_999, ...extra });
  return { tools, fetch: routes[0].fetch, stagingDir };
}

test('issue_create with a bad image does not leave a half-created issue', async () => {
  const { tools } = applyHost();
  const exec = { agent: { session: { id: 'session-main' } } };
  const create = tools.find(t => t.name === 'issue_create');

  await assert.rejects(
    () => create.execute({ title: '半成品', body: '正文', images: [pngFile(), join(tmpdir(), 'definitely-missing.png')] }, exec),
    err => err.code === 'IMAGE_NOT_FOUND',
  );

  const list = await tools.find(t => t.name === 'issue_list').execute({}, exec);
  assert.deepEqual(list.map(item => item.title), [], '校验失败时不该留下任何事务');
});

test('issue_update with a bad image stores no attachment at all', async () => {
  const { tools } = applyHost();
  const exec = { agent: { session: { id: 'session-main' } } };
  const created = await tools.find(t => t.name === 'issue_create').execute({ title: 'X', body: '正文' }, exec);
  const before = await tools.find(t => t.name === 'issue_get').execute({ id: created.id }, exec);

  await assert.rejects(
    () => tools.find(t => t.name === 'issue_update').execute({ id: created.id, images: [pngFile(), join(tmpdir(), 'definitely-missing.png')] }, exec),
    err => err.code === 'IMAGE_NOT_FOUND',
  );

  const files = countAttachmentFiles();
  assert.equal(files, 0, `失败的那次不该留下孤儿附件（附件目录里有 ${files} 个文件）`);
});

test('attachImages rejects bytes that are not an image, even when named .png', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fake-'));
  const fake = join(dir, 'sneaky.png');
  writeFileSync(fake, 'TOP-SECRET');
  const { added, store } = fakeAttachmentStore();

  assert.throws(
    () => host.attachImages({ store, issueId: 'i', images: [fake] }),
    err => err.code === 'NOT_AN_IMAGE',
  );
  assert.equal(added.length, 0, '不该把非图片内容存进附件库');
});

test('oversize image error names the offending file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'big-'));
  const big = join(dir, 'huge.png');
  writeFileSync(big, Buffer.alloc(10 * 1024 * 1024 + 1, 0x89));
  const { added, store } = fakeAttachmentStore();

  assert.throws(
    () => host.attachImages({ store, issueId: 'i', images: [big] }),
    err => err.code === 'TOO_LARGE' && err.message.includes('huge.png'),
  );
  assert.equal(added.length, 0, '超限时不该先读进内存再失败');
});

test('svg is not in the bot whitelist (design non-goal: png/jpeg/webp/gif)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'svg-'));
  const svg = join(dir, 'x.svg');
  writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  const { added, store } = fakeAttachmentStore();
  assert.throws(
    () => host.attachImages({ store, issueId: 'i', images: [svg] }),
    err => err.code === 'UNSUPPORTED_IMAGE',
  );
  assert.equal(added.length, 0);
});

test('staging caps at MAX_STAGED_ATTACHMENTS and reports how many were skipped', () => {
  const ids = Array.from({ length: 21 }, (_, i) => `${i.toString(16)}`.padStart(16, 'a'));
  const texts = ids.map((id, i) => ({ where: `comment:${i}`, text: `![x](/api/bot-issue?attachment=${id})` }));
  const store = () => ({ getAttachment: id => ({ id, name: `${id}.png`, mime: 'image/png', bytes: 8, filePath: '/tmp/definitely-missing-file' }) });
  const stagingDir = mkdtempSync(join(tmpdir(), 'stagecap-'));

  const result = host.stageIssueAttachments({ store, stagingDir, issueNumber: 1, texts });
  assert.equal(result.attachments.length, host.MAX_STAGED_ATTACHMENTS);
  assert.equal(result.skipped, 1);
});

// ── 引用回复 + 被回复者通知 ────────────────────────────────────────────────

test('replying to a third-party bot comment from UI notifies that bot without @mention', async () => {
  const statePath = makeState(
    { id: 'bot-1', name: '鲸鱼', sessionId: 'session-main' },
    { id: 'bot-2', name: '伟峰', sessionId: 'session-weifeng' },
    { id: 'bot-3', name: 'kiki', sessionId: 'session-kiki', segments: [{ sessionId: 'session-kiki-seg' }] },
  );
  const { ctx, routes, tools, prompts } = mockCtx();
  host.apply(ctx, { dbPath: tempDb(), statePath, nodesRoot: '/tmp/definitely-missing-nodes', writebackIntervalMs: 999_999 });
  const fetch = routes[0].fetch;

  const created = await post(fetch, { action: 'create', title: '跨同事回复测试' });
  const id = created.value.issue.id;
  await post(fetch, { action: 'assign', id, sessionId: 'session-weifeng', name: '伟峰' });
  // kiki 用旧段会话发了一条评论
  const kikiComment = await tools.find(t => t.name === 'issue_comment')
    .execute({ id, body: '我查了一下端口在 3082' }, { agent: { session: { id: 'session-kiki-seg' } } });

  prompts.length = 0;
  // 用户从面板点击回复 kiki（没有打 @kiki）
  const reply = await post(fetch, {
    action: 'comment',
    id,
    body: '收到，请再顺手确认下超时配置',
    authorKind: 'user',
    replyToId: kikiComment.id,
  });
  assert.equal(reply.ok, true);
  await new Promise(resolve => setTimeout(resolve, 0));

  const kikiPrompts = prompts.filter(p => p.sessionId === 'session-kiki');
  assert.equal(kikiPrompts.length, 1, '被回复的第三位同事应该收到活跃会话通知');
  assert.match(kikiPrompts[0].content[0].text, /我查了一下端口在 3082/);
  assert.match(kikiPrompts[0].content[0].text, /收到，请再顺手确认下超时配置/);
});

test('reply notification deduplicates when target bot is also @mentioned and is the assignee', async () => {
  const statePath = makeState(
    { id: 'bot-1', name: '鲸鱼', sessionId: 'session-main' },
    { id: 'bot-2', name: '伟峰', sessionId: 'session-weifeng' },
  );
  const { ctx, routes, tools, prompts } = mockCtx();
  host.apply(ctx, { dbPath: tempDb(), statePath, nodesRoot: '/tmp/definitely-missing-nodes', writebackIntervalMs: 999_999 });
  const fetch = routes[0].fetch;

  const created = await post(fetch, { action: 'create', title: '去重测试' });
  const id = created.value.issue.id;
  await post(fetch, { action: 'assign', id, sessionId: 'session-weifeng', name: '伟峰' });
  const weifengComment = await tools.find(t => t.name === 'issue_comment')
    .execute({ id, body: '初版已完成' }, { agent: { session: { id: 'session-weifeng' } } });

  prompts.length = 0;
  await post(fetch, {
    action: 'comment',
    id,
    body: '@伟峰 看一下这里',
    authorKind: 'user',
    replyToId: weifengComment.id,
  });
  await new Promise(resolve => setTimeout(resolve, 0));

  const wfPrompts = prompts.filter(p => p.sessionId === 'session-weifeng');
  assert.equal(wfPrompts.length, 1, '同一只 Bot 既是执行人、又被回复、又被 @，只应发一次通知');
});

test('bot replying to its own comment does not notify itself, and issue_get / issue_comment work with replyTo', async () => {
  const statePath = makeState(
    { id: 'bot-1', name: '鲸鱼', sessionId: 'session-main' },
    { id: 'bot-2', name: 'kiki', sessionId: 'session-kiki', segments: [{ sessionId: 'session-kiki-seg' }] },
  );
  const { ctx, routes, tools, prompts } = mockCtx();
  host.apply(ctx, { dbPath: tempDb(), statePath, nodesRoot: '/tmp/definitely-missing-nodes', writebackIntervalMs: 999_999 });
  const fetch = routes[0].fetch;
  const getTool = tools.find(t => t.name === 'issue_get');
  const commentTool = tools.find(t => t.name === 'issue_comment');

  const created = await post(fetch, { action: 'create', title: '工具回复测试' });
  const id = created.value.issue.id;
  const first = await commentTool.execute({ id, body: '第一条观察' }, { agent: { session: { id: 'session-kiki-seg' } } });

  prompts.length = 0;
  // kiki 在主 session 回复自己旧段发的评论 → 不该通知自己
  const selfReply = await commentTool.execute(
    { id, body: '自补一句', replyTo: first.id },
    { agent: { session: { id: 'session-kiki' } } },
  );
  assert.equal(selfReply.replyTo, true);
  const rendered = commentTool.output.render({}, selfReply)[0].text;
  assert.match(rendered, /回复已添加/);
  assert.doesNotMatch(rendered, /issue_|open|in_review|done|\bv\d+\b/);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(prompts.filter(p => p.sessionId === 'session-kiki').length, 0, '自己回复自己不发通知');

  // 鲸鱼通过工具回复 kiki 的评论 → kiki 收到通知
  prompts.length = 0;
  await commentTool.execute({ id, body: '收到你的观察', replyTo: first.id }, { agent: { session: { id: 'session-main' } } });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(prompts.filter(p => p.sessionId === 'session-kiki').length, 1);

  const got = await getTool.execute({ id }, { agent: { session: { id: 'session-main' } } });
  const text = getTool.output.render({}, got)[0].text;
  const commentLines = got.comments.join('\n');
  assert.ok(text.includes(`[评论 ${first.id}]`), 'issue_get 应带可读评论编号且不用 #N 撞事务链接');
  assert.doesNotMatch(commentLines, new RegExp(`#${first.id}\\b`), '评论编号不能写成 #N 以免被当成事务号');
  assert.match(commentLines, new RegExp(`回复 .*评论 ${first.id}`));
});

test('replying to a legacy "主 Bot" comment routes to mainBot active session', async () => {
  const statePath = makeState(
    { id: 'bot-1', name: '鲸鱼', sessionId: 'session-main' },
    { id: 'bot-2', name: 'kiki', sessionId: 'session-kiki' },
  );
  const { ctx, routes, tools, prompts } = mockCtx();
  host.apply(ctx, { dbPath: tempDb(), statePath, nodesRoot: '/tmp/definitely-missing-nodes', writebackIntervalMs: 999_999 });
  const fetch = routes[0].fetch;
  const created = await post(fetch, { action: 'create', title: '主 Bot 旧评论回复' });
  const id = created.value.issue.id;
  // HTTP 侧未传 authorName 时默认落为「主 Bot」
  const mainComment = await post(fetch, { action: 'comment', id, body: '请核对配置', authorKind: 'agent' });
  prompts.length = 0;

  await tools.find(t => t.name === 'issue_comment').execute(
    { id, body: '已核对完毕', replyTo: mainComment.value.comment.id },
    { agent: { session: { id: 'session-kiki' } } },
  );
  await new Promise(resolve => setTimeout(resolve, 0));

  const mainPrompts = prompts.filter(p => p.sessionId === 'session-main');
  assert.equal(mainPrompts.length, 1);
  assert.match(mainPrompts[0].content[0].text, /请核对配置/);
});

test('issue_get omits reply id on status/assign entries and issue_comment rejects replying to status', async () => {
  const statePath = makeState(
    { id: 'bot-1', name: '鲸鱼', sessionId: 'session-main' },
    { id: 'bot-2', name: '伟峰', sessionId: 'session-weifeng' },
  );
  const { ctx, routes, tools } = mockCtx();
  host.apply(ctx, { dbPath: tempDb(), statePath, nodesRoot: '/tmp/definitely-missing-nodes', writebackIntervalMs: 999_999 });
  const fetch = routes[0].fetch;
  const getTool = tools.find(t => t.name === 'issue_get');
  const commentTool = tools.find(t => t.name === 'issue_comment');

  const created = await post(fetch, { action: 'create', title: '状态不可回复' });
  const id = created.value.issue.id;
  await post(fetch, { action: 'assign', id, sessionId: 'session-weifeng', name: '伟峰' });
  await post(fetch, { action: 'update', id, status: 'dispatched' });
  await commentTool.execute({ id, body: '正文里的讨论' }, { agent: { session: { id: 'session-weifeng' } } });

  const detail = await post(fetch, { action: 'get', id });
  const statusEntry = detail.value.issue.comments.find(c => c.kind === 'status');
  const assignEntry = detail.value.issue.comments.find(c => c.kind === 'assign');
  const normalEntry = detail.value.issue.comments.find(c => c.kind === 'comment');

  const got = await getTool.execute({ id }, { agent: { session: { id: 'session-main' } } });
  const statusLine = got.comments.find(line => line.includes('[状态]'));
  const assignLine = got.comments.find(line => line.includes('[指派]'));
  const normalLine = got.comments.find(line => line.includes('正文里的讨论'));

  assert.doesNotMatch(statusLine, /\[评论 \d+\]/);
  assert.doesNotMatch(assignLine, /\[评论 \d+\]/);
  assert.ok(normalLine.includes(`[评论 ${normalEntry.id}]`));

  await assert.rejects(
    () => commentTool.execute({ id, body: '想回状态', replyTo: statusEntry.id }, { agent: { session: { id: 'session-main' } } }),
    err => err.code === 'INVALID_REPLY_TO',
  );
  await assert.rejects(
    () => commentTool.execute({ id, body: '想回指派', replyTo: assignEntry.id }, { agent: { session: { id: 'session-main' } } }),
    err => err.code === 'INVALID_REPLY_TO',
  );
});

test('issue tools and start dispatch include priority P0-P3', async () => {
  const statePath = makeState(
    { id: 'bot-1', name: '鲸鱼', sessionId: 'session-main' },
    { id: 'bot-2', name: '伟峰', sessionId: 'session-weifeng' },
  );
  const { ctx, routes, tools, prompts } = mockCtx();
  host.apply(ctx, { dbPath: tempDb(), statePath, nodesRoot: '/tmp/definitely-missing-nodes', writebackIntervalMs: 999_999 });
  const fetch = routes[0].fetch;
  const exec = { agent: { session: { id: 'session-main' } } };
  const createTool = tools.find(t => t.name === 'issue_create');
  const listTool = tools.find(t => t.name === 'issue_list');
  const getTool = tools.find(t => t.name === 'issue_get');
  const updateTool = tools.find(t => t.name === 'issue_update');

  const created = await createTool.execute({ title: '紧急修复', body: '立刻处理', priority: 'P0' }, exec);
  assert.equal(created.priority, 'P0');
  assert.match(createTool.output.render({}, created)[0].text, /P0/);

  await createTool.execute({ title: '普通优化', priority: 'P3' }, exec);
  const p0List = await listTool.execute({ priority: 'P0' }, exec);
  assert.equal(p0List.length, 1);
  assert.equal(p0List[0].priority, 'P0');
  assert.match(listTool.output.render({}, p0List)[0].text, /P0/);
  assert.equal(listTool.output.schema.items.properties.priority.type, 'string');

  const updated = await updateTool.execute({ id: created.id, priority: 'P1' }, exec);
  assert.equal(updated.priority, 'P1');
  assert.match(updateTool.output.render({}, updated)[0].text, /P1/);

  const got = await getTool.execute({ id: created.id }, exec);
  assert.equal(got.priority, 'P1');
  assert.match(getTool.output.render({}, got)[0].text, /P1/);

  prompts.length = 0;
  await post(fetch, { action: 'start', id: created.id });
  assert.match(prompts[0].content[0].text, /紧急程度：P1/);
});

test('评论回复与 @提及通知同样走 bot-issue notice + system-reminder，缺少 resolveAgent 时降级回 prompt', async () => {
  const statePath = makeState(
    { id: 'bot-1', name: '鲸鱼', sessionId: 'session-main' },
    { id: 'bot-2', name: '伟峰', sessionId: 'session-weifeng' },
  );
  const legacyPrompts = [];
  const legacyCtx = {
    effect(fn) { fn(); },
    connection: { fetch: { register(def) { legacyRoutes.push(def); } } },
    inject(names, cb) {
      if (names.includes('sessionController')) {
        cb({ sessionController: { prompt: async payload => { legacyPrompts.push(payload); } } });
      }
    },
    get() { return null; },
  };
  const legacyRoutes = [];
  host.apply(legacyCtx, { dbPath: ':memory:', statePath, nodesRoot: '/tmp/definitely-missing-nodes', writebackIntervalMs: 999_999 });
  const created = await post(legacyRoutes[0].fetch, { action: 'create', title: '降级测试' });
  await post(legacyRoutes[0].fetch, { action: 'comment', id: created.value.issue.id, body: '@伟峰 看一下', authorKind: 'user' });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(legacyPrompts.length, 1);
  assert.match(legacyPrompts[0].content[0].text, /^<system-reminder>[\s\S]*<\/system-reminder>/);
});
