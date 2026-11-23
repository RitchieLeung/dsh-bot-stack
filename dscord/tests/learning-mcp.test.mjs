import './helpers/dsh-tools-stub.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const learning = await import('../vendor/ds-bot/src/host/learning.js');
const workCore = await import('../dsh-connect/work-core.mjs');
const localAgents = await import('../vendor/ds-bot/src/host/local-agents/index.js');
const { LoopbackMcp } = await import('../vendor/ds-bot/src/host/local-agents/mcp.js');

function createIssueDb(home) {
  const dir = join(home, 'issue');
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'issue.sqlite'));
  db.exec(`
    CREATE TABLE issues (
      id TEXT PRIMARY KEY,
      number INTEGER,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      priority TEXT NOT NULL DEFAULT 'P2',
      parentId TEXT,
      type TEXT,
      createdBy TEXT NOT NULL,
      createdByName TEXT NOT NULL DEFAULT '',
      version INTEGER NOT NULL DEFAULT 1,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      closedAt INTEGER,
      result TEXT,
      assigneeSessionId TEXT,
      assigneeName TEXT,
      assignedAt INTEGER
    );
    CREATE TABLE comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issueId TEXT NOT NULL,
      authorKind TEXT NOT NULL DEFAULT 'user',
      authorName TEXT NOT NULL DEFAULT '',
      authorSessionId TEXT,
      body TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'comment',
      replyToId INTEGER,
      at INTEGER NOT NULL
    );
  `);
  db.prepare(`
    INSERT INTO issues (id, number, title, body, status, createdBy, createdByName, version, createdAt, updatedAt, assigneeName)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('I-4d076aa4', 10, '测试一下新版事务', '获取公网和内网 IP', 'dispatched', 'user-1', '管理员', 4, 1000, 2000, '尚锦');
  db.prepare('INSERT INTO comments (issueId, authorKind, authorName, body, kind, at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('I-4d076aa4', 'user', '管理员', '必须实际执行命令验证输出，禁止只口头编造。', 'reject', 1600);
  db.close();
}

function makeRuntime({ home, partLinesBySession = {}, botShotImpl, redactSecrets = v => v } = {}) {
  const listeners = new Map();
  const effects = [];
  const disposers = new Map();
  const partLinesCalls = [];
  const bot = { id: 'bot-1', name: '尚锦', role: '后端工程师', capabilities: [] };
  const state = { bots: { [bot.id]: bot }, capabilities: { items: {} } };
  const rt = {
    home,
    config: { learning: true, memory: true },
    state,
    teamTools: [],
    chatOwners: new Map([['chat-1', bot.id]]),
    groupOwners: new Map(),
    ctx: {
      on(event, fn) {
        const list = listeners.get(event) || [];
        list.push(fn);
        listeners.set(event, list);
        return () => {};
      },
      effect(fn, label) {
        effects.push(label);
        const dispose = fn();
        if (typeof dispose === 'function') disposers.set(label, dispose);
        return typeof dispose === 'function' ? dispose : () => {};
      },
    },
    isBotSession: sid => sid === 'chat-1' || sid === 'group-1',
    selfOf: sid => (sid === 'chat-1' || sid === 'group-1' ? bot.id : undefined),
    botOf: id => (id === bot.id ? bot : undefined),
    chatOf: id => (id === bot.id ? 'chat-1' : undefined),
    readOnly: () => undefined,
    workView: () => ({}),
    uiLanguage: () => 'zh-CN',
    redactSecrets,
    warn: () => {},
    load: async () => {},
    save: async () => {},
    async *partLines(sid, _signal, opts = {}) {
      partLinesCalls.push({ sid, group: opts?.group });
      for (const row of partLinesBySession[sid] || []) {
        // Mirror vendor/ds-bot/src/host/parts.js:155 group filtering.
        if (!opts?.group && typeof row.text === 'string' && row.text.startsWith('[Group chat')) continue;
        yield row;
      }
    },
    botShot: botShotImpl || (async () => JSON.stringify({ action: 'none', reason: 'not needed' })),
    capabilitySave: async (item) => {
      state.capabilities.items[item.name] = item;
      return item;
    },
    capabilityEndpoint: async (endpoint, body) => {
      if (endpoint === 'bot-capability' && body?.attached) {
        bot.capabilities = [...new Set([...(bot.capabilities || []), body.name])];
      }
    },
    capabilityDelete: async () => {},
  };
  return { rt, bot, listeners, effects, disposers, partLinesCalls };
}

test('install disables 3-minute agent/status queue and interval timer sweep', async () => {
  const home = mkdtempSync(join(tmpdir(), 'lmcp-'));
  try {
    const { rt, listeners, effects } = makeRuntime({ home });
    learning.install(rt);
    assert.equal(listeners.get('agent/status')?.length ?? 0, 0, 'must not subscribe agent/status for 3-min timer queue');
    assert.equal(effects.includes('ds-bot: learning'), false, 'must not install background interval sweep');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('skill_retrospect is in rt.teamTools, FRONT_TOOLS, WORKER_DENY, and crosses LoopbackMcp for Codex', async () => {
  const home = mkdtempSync(join(tmpdir(), 'lmcp-'));
  try {
    const { rt } = makeRuntime({ home });
    learning.install(rt);
    const tool = rt.teamTools.find(t => t.name === 'skill_retrospect');
    assert.ok(tool, 'skill_retrospect must be registered in rt.teamTools');
    assert.equal(workCore.FRONT_TOOLS.has('skill_retrospect'), true);
    assert.equal(workCore.WORKER_DENY.has('skill_retrospect'), true);

    // Simulate real local-agents install + adapter.deps.toolsFor + LoopbackMcp exposure
    let capturedAdapter;
    rt.state.localAgents = { custom: [{ id: 'cli-test', name: 'TestCLI', command: 'codex' }], sessions: {} };
    rt.ctx.llm = {
      registerAdapter(_routes, adapter) {
        capturedAdapter = adapter;
        return { replace() {}, dispose() {} };
      },
    };
    rt.teamFolder = () => home;
    localAgents.install(rt);
    assert.ok(capturedAdapter, 'local-agents must register adapter synchronously for custom agent route');
    const bridged = capturedAdapter.deps.toolsFor({ tools: [...rt.teamTools, { name: 'bash' }] });
    assert.equal(bridged.some(t => t.name === 'skill_retrospect'), true);
    assert.equal(bridged.some(t => t.name === 'bash'), false);

    // Unknown session cannot trigger retrospect
    const refused = await tool.execute({ trigger_type: 'negative_feedback', summary: 'test' }, { agent: { id: 'unknown-sid' } });
    assert.match(refused, /无法识别/);

    const mcp = new LoopbackMcp(() => [tool], async () => ({ text: 'ok', isError: false }));
    const listed = mcp.answer({ id: 1, method: 'tools/list', params: {} });
    const mcpTool = listed.result.tools.find(t => t.name === 'skill_retrospect');
    assert.ok(mcpTool);
    assert.deepEqual(mcpTool.inputSchema.required, ['trigger_type', 'summary']);
    assert.deepEqual(mcpTool.inputSchema.properties.trigger_type.enum, ['issue_rejected', 'negative_feedback']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('skill_retrospect with issue_rejected reads issue.sqlite reject comments and creates proposal', async () => {
  const home = mkdtempSync(join(tmpdir(), 'lmcp-'));
  try {
    createIssueDb(home);
    let seenPrompt = '';
    const { rt } = makeRuntime({
      home,
      partLinesBySession: {
        'group-1': [
          { seq: 12, who: 'user', time: 1700, text: 'User: 这次 #10 我打回了，必须真执行命令！' },
          { seq: 11, who: 'bot', time: 1650, text: '尚锦: 我重新执行并贴了实测输出' },
        ],
      },
      botShotImpl: async (_bot, _sys, text) => {
        seenPrompt = text;
        return JSON.stringify({
          action: 'create',
          name: 'verify-real-command-output',
          description: '在声明执行结果前必须实际运行命令并贴出可核查输出。',
          content: '- 提交结果前必须运行真实命令验证，严禁口头估算或编造结果。',
          why: '事务 #10 因未实测执行而被驳回。',
        });
      },
    });
    learning.install(rt);
    const tool = rt.teamTools.find(t => t.name === 'skill_retrospect');
    assert.ok(tool);
    const reply = await tool.execute({
      trigger_type: 'issue_rejected',
      summary: '未实际运行命令直接提交导致被打回',
      issue_id: '#10',
    }, { agent: { id: 'group-1' }, signal: new AbortController().signal });

    assert.match(reply, /verify-real-command-output/);
    assert.match(seenPrompt, /\[Retrospect Trigger\] type=issue_rejected/);
    assert.match(seenPrompt, /必须实际执行命令验证输出/);
    assert.match(seenPrompt, /User: 这次 #10 我打回了/);

    const waiting = rt.learningView()['bot-1'] || [];
    assert.equal(waiting.length, 1);
    assert.equal(waiting[0].name, 'verify-real-command-output');
    assert.equal(waiting[0].kind, 'skill');

    const persisted = JSON.parse(readFileSync(join(home, 'learning', 'state.json'), 'utf8'));
    assert.equal(Object.keys(persisted.proposals).length, 1);
    assert.equal(persisted.cursors['group-1'], 12);

    // Approving the card still works through existing learningEndpoint
    const ans = await rt.learningEndpoint('learning-answer', { id: waiting[0].id, approve: true });
    assert.equal(ans.applied, true);
    assert.ok(rt.state.capabilities.items['verify-real-command-output']);
    assert.equal(rt.state.bots['bot-1'].capabilities.includes('verify-real-command-output'), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('negative_feedback works with cursor already caught up via fallback window and respects gate & none & secret', async () => {
  const home = mkdtempSync(join(tmpdir(), 'lmcp-'));
  try {
    mkdirSync(join(home, 'learning'), { recursive: true });
    let callCount = 0;
    let lastPrompt = '';
    const { rt } = makeRuntime({
      home,
      partLinesBySession: {
        'chat-1': [
          { seq: 20, who: 'user', time: 2000, text: 'User: 别再只读文件名就下结论！' },
        ],
      },
      redactSecrets: text => text.replace(/sk-secret-123/g, '[REDACTED]'),
      botShotImpl: async (_bot, _sys, text) => {
        callCount += 1;
        lastPrompt = text;
        if (callCount === 1) return JSON.stringify({ action: 'none', reason: '只是单次沟通误差' });
        if (callCount === 2) {
          return JSON.stringify({
            action: 'create',
            name: 'bad-secret-skill',
            description: '含敏感测试',
            content: 'token is sk-secret-123',
            why: '测试密钥拦截',
          });
        }
        return JSON.stringify({
          action: 'create',
          name: 'verify-before-claim',
          description: '下结论前必须先核对源码内容。',
          content: '- 下任何技术结论前先用工具核实真实代码后再回复。',
          why: '用户因未读源码下结论给出强烈负反馈。',
        });
      },
    });
    learning.install(rt);
    const tool = rt.teamTools.find(t => t.name === 'skill_retrospect');
    assert.ok(tool);

    // 1. action === 'none'
    const noneRes = await tool.execute({
      trigger_type: 'negative_feedback',
      summary: '用户指出看错文件',
    }, { agent: { id: 'chat-1' }, signal: new AbortController().signal });
    assert.match(noneRes, /未生成|无需/);
    assert.equal((rt.learningView()['bot-1'] || []).length, 0);

    // 2. secret redacted -> rejected cleanly
    const secRes = await tool.execute({
      trigger_type: 'negative_feedback',
      summary: '再次调用测试密钥过滤',
    }, { agent: { id: 'chat-1' }, signal: new AbortController().signal });
    assert.match(secRes, /未能生成|密钥|拦截/);
    assert.equal((rt.learningView()['bot-1'] || []).length, 0);

    // 3. Even though cursor is now at seq=20, fallback window still feeds the recent user correction!
    const okRes = await tool.execute({
      trigger_type: 'negative_feedback',
      summary: '用户强烈要求下结论前先核查代码',
    }, { agent: { id: 'chat-1' }, signal: new AbortController().signal });
    assert.match(okRes, /verify-before-claim/);
    assert.match(lastPrompt, /别再只读文件名就下结论/);
    assert.equal((rt.learningView()['bot-1'] || []).length, 1);

    // 4. Duplicate invocation while pending proposal exists is blocked by default gate without calling botShot again
    const beforeCalls = callCount;
    const blockedRes = await tool.execute({
      trigger_type: 'negative_feedback',
      summary: '再提一个重复复盘',
    }, { agent: { id: 'chat-1' }, signal: new AbortController().signal });
    assert.equal(callCount, beforeCalls);
    assert.match(blockedRes, /待用户审批/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('skill_retrospect passes group flag to partLines for group sessions', async () => {
  const home = mkdtempSync(join(tmpdir(), 'lmcp-'));
  let lastPrompt = '';
  try {
    const { rt, partLinesCalls } = makeRuntime({
      home,
      partLinesBySession: {
        'group-1': [{ seq: 30, time: 3000, who: 'room', text: '[Group chat "运维群" · new message]\n管理员: 必须附实际命令输出' }],
        'chat-1': [{ seq: 1, time: 1000, who: 'user', text: 'User: 私聊提醒' }],
      },
      botShotImpl: async (_bot, _sys, text) => {
        lastPrompt = text;
        return JSON.stringify({
          action: 'create',
          name: 'group-evidence-check',
          description: '群聊交付前必须附实际命令输出',
          content: '# 规则\n- 提交前附完整命令与实际输出',
          why: '群聊被指出未附命令输出',
        });
      },
    });
    rt.groupOwners.set('group-1', { roomId: 'room-1' });
    learning.install(rt);
    const tool = rt.teamTools.find(item => item.name === 'skill_retrospect');

    const res = await tool.execute({
      trigger_type: 'negative_feedback',
      summary: '群聊交付因缺命令输出被打回',
    }, { agent: { id: 'group-1' }, signal: new AbortController().signal });

    assert.match(res, /group-evidence-check/);
    assert.deepEqual(partLinesCalls, [
      { sid: 'group-1', group: true },
      { sid: 'chat-1', group: false },
    ]);
    assert.match(lastPrompt, /必须附实际命令输出/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('concurrent skill_retrospect calls for the same bot block second in-flight call', async () => {
  const home = mkdtempSync(join(tmpdir(), 'lmcp-'));
  let callCount = 0;
  const releases = [];
  let shotEntered;
  const enteredPromise = new Promise(resolve => { shotEntered = resolve; });
  try {
    const { rt } = makeRuntime({
      home,
      partLinesBySession: {
        'chat-1': [{ seq: 1, time: 1000, who: 'user', text: 'User: 下次不要没验证就汇报' }],
      },
      botShotImpl: async () => {
        callCount += 1;
        shotEntered();
        await new Promise(resolve => { releases.push(resolve); });
        return JSON.stringify({
          action: 'create',
          name: 'single-flight-check',
          description: '验证并发复盘只生成一张卡',
          content: '# 规则\n- 避免并发重复复盘',
          why: '并发测试',
        });
      },
    });
    learning.install(rt);
    const tool = rt.teamTools.find(item => item.name === 'skill_retrospect');

    const firstPromise = tool.execute({
      trigger_type: 'negative_feedback',
      summary: '第一次复盘调用',
    }, { agent: { id: 'chat-1' }, signal: new AbortController().signal });
    await enteredPromise;

    const secondPromise = tool.execute({
      trigger_type: 'negative_feedback',
      summary: '并发重复调用',
    }, { agent: { id: 'chat-1' }, signal: new AbortController().signal });
    await new Promise(resolve => setTimeout(resolve, 20));
    for (const release of releases) release();

    const [firstRes, secondRes] = await Promise.all([firstPromise, secondPromise]);
    assert.equal(callCount, 1);
    assert.match(secondRes, /已有复盘正在进行/);
    assert.match(firstRes, /single-flight-check/);
    assert.equal((rt.learningView()['bot-1'] || []).length, 1);
  } finally {
    for (const release of releases) release();
    rmSync(home, { recursive: true, force: true });
  }
});

test('learning shutdown joins in-flight retrospectSkill and exits cleanly without partial writes', async () => {
  const home = mkdtempSync(join(tmpdir(), 'lmcp-'));
  let releaseShot;
  let shotEntered;
  const enteredPromise = new Promise(resolve => { shotEntered = resolve; });
  try {
    const { rt, disposers } = makeRuntime({
      home,
      partLinesBySession: {
        'chat-1': [{ seq: 1, time: 1000, who: 'user', text: 'User: 禁止跳过测试' }],
      },
      botShotImpl: async () => {
        shotEntered();
        await new Promise(resolve => { releaseShot = resolve; });
        return JSON.stringify({
          action: 'create',
          name: 'should-not-write-after-stop',
          description: '关闭途中不应落盘',
          content: '# 规则\n- test',
          why: 'shutdown race',
        });
      },
    });
    learning.install(rt);
    const tool = rt.teamTools.find(item => item.name === 'skill_retrospect');

    const callPromise = tool.execute({
      trigger_type: 'negative_feedback',
      summary: '关闭竞争测试',
    }, { agent: { id: 'chat-1' }, signal: new AbortController().signal });
    await enteredPromise;

    const shutdown = disposers.get('ds-bot: learning shutdown');
    assert.equal(typeof shutdown, 'function');

    let shutdownDone = false;
    const shutdownPromise = Promise.resolve(shutdown()).then(() => { shutdownDone = true; });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(shutdownDone, false, 'shutdown must wait for in-flight retrospectSkill to settle');

    releaseShot();
    const [callRes] = await Promise.all([callPromise, shutdownPromise]);
    assert.equal(shutdownDone, true);
    assert.match(callRes, /关闭/);
    assert.equal(Object.keys(rt.learningView()).length, 0);
    const stateFile = join(home, 'learning', 'state.json');
    if (existsSync(stateFile)) {
      const saved = JSON.parse(readFileSync(stateFile, 'utf8'));
      assert.deepEqual(saved.proposals, {});
    } else {
      assert.equal(existsSync(stateFile), false);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
