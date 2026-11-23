import './helpers/dsh-tools-stub.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const workCore = await import('../dsh-connect/work-core.mjs');
const { ContactBook } = await import('../src/contact-book.mjs');
const { nativeMessage } = await import('../src/message-context.mjs');
const handoffs = await import('../vendor/ds-bot/src/host/handoffs.js');
const hostTools = await import('../vendor/ds-bot/src/host/tools.js');
const hostPrompt = await import('../vendor/ds-bot/src/host/prompt.js');

const { WorkCore, localBot, CARD_REFUSAL } = workCore;

function makeCore({ id = '@xiaoxin:local', nativeBotId = 'bot-xiaoxin', localpart = 'xiaoxin', maxWorkers = 2 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dscord-front-test-'));
  const state = { tasks: {} };
  const core = new WorkCore({
    ctx: {
      tools: {
        guard: () => () => {},
        schemas: () => [
          { name: 'bash' },
          { name: 'missiongo_list_issues' },
          { name: 'ask_user' },
          { name: 'show_view' },
        ],
      },
      sessionController: {
        create: async () => ({ sessionId: `worker-${Date.now()}` }),
        prompt: async () => {},
        selectModel: async () => ({ selected: { provider: 'deepseek-official', model: 'deepseek-flash' } }),
      },
    },
    native: {
      bot: async () => ({ id: nativeBotId, name: '小欣', model: 'deepseek-official/deepseek-flash' }),
      agent: async (sessionId) => ({
        id: sessionId,
        session: { id: sessionId },
        ctx: { tools: { register: () => {}, restrict: () => {} } },
      }),
    },
    node: { id, nativeBotId, localpart, directory: dir },
    state,
    save: async () => {},
    maxWorkers,
  });
  return { core, dir, cleanup: () => { core.dispose(); rmSync(dir, { recursive: true, force: true }); } };
}

test('front session can call external MCP and local tools directly while CARD_TOOLS and WORKER_DENY stay guarded', async () => {
  const { core, cleanup } = makeCore();
  try {
    const deniedOnFront = [];
    const frontAgent = {
      id: 'front-session-1',
      session: { id: 'front-session-1' },
      ctx: {
        tools: {
          register: () => {},
          restrict: ({ deny }) => deniedOnFront.push(...deny),
          schemas: () => [
            { name: 'bash' },
            { name: 'missiongo_list_issues' },
            { name: 'read_file' },
            { name: 'ask_user' },
            { name: 'show_view' },
          ],
        },
      },
    };
    await core.serveFront(frontAgent);

    // Quick tools & external MCP tools are allowed on the front session
    for (const toolName of ['missiongo_list_issues', 'bash', 'read_file', 'issue_list', 'dispatch_work']) {
      assert.equal(
        core.guard({ agent: { session: { id: 'front-session-1' } }, name: toolName }),
        undefined,
        `front session should allow ${toolName} without FRONT_REFUSAL`,
      );
    }

    // serveFront must not restrict bash or missiongo_list_issues
    assert.equal(deniedOnFront.includes('bash'), false);
    assert.equal(deniedOnFront.includes('missiongo_list_issues'), false);

    // Desktop card tools remain refused on front
    assert.equal(
      core.guard({ agent: { session: { id: 'front-session-1' } }, name: 'ask_user' }),
      CARD_REFUSAL,
    );

    // Worker session still cannot use WORKER_DENY tools
    core.state.tasks['T-worker1'] = { id: 'T-worker1', sessionId: 'worker-session-1', status: 'running' };
    assert.equal(
      typeof core.guard({ agent: { session: { id: 'worker-session-1' } }, name: 'dispatch_work' }),
      'string',
    );
    assert.equal(
      typeof core.guard({ agent: { session: { id: 'worker-session-1' } }, name: 'message_bot' }),
      'string',
    );
  } finally {
    cleanup();
  }
});

test('dispatch_work in direct native web chat (no room origin, no issueId) uses direct fallback origin when front is served', async () => {
  const { core, cleanup } = makeCore();
  try {
    // Before serveFront and with no origin/issueId, dispatch_work rejects
    const rejected = await core.dispatch({
      title: '孤立派工',
      brief: '没有会话也没有 origin',
      audience: '管理员',
    });
    assert.match(rejected, /现在没有要回复的消息/);

    // Once front session is served (direct native web chat), dispatch_work succeeds without issueId
    core.frontSessions.add('front-session-1');
    const accepted = await core.dispatch({
      title: '重度批量查单与汇总',
      brief: '跨 10 个产品拉取全量历史工单并生成统计报表',
      audience: '管理员',
    });
    assert.match(accepted, /^已派工：T-/);
    const tasks = core.tasks();
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].origin.direct, true);
    assert.equal(tasks[0].origin.roomId, null);
  } finally {
    cleanup();
  }
});

test('front turn events update frontBusy/loadView, ContactBook.reachableBots, and rt.statusOf worker load', async () => {
  const { core, dir, cleanup } = makeCore({ id: '@xiaoxin:local', nativeBotId: 'bot-xiaoxin', maxWorkers: 2 });
  const db = new DatabaseSync(':memory:');
  try {
    core.botName = '小欣';
    core.frontSessions.add('front-session-1');

    const book = new ContactBook({
      db,
      self: { id: '@yidan:local' },
      people: () => [
        { id: '@yidan:local', name: '怡丹', kind: 'bot', role: '主理人' },
        { id: '@xiaoxin:local', name: '小欣', kind: 'bot', role: '工单助手' },
      ],
      local: localBot,
    });

    // Initially idle
    assert.equal(core.loadView().status, 'idle');
    assert.equal(core.loadView().frontBusy, false);
    let reachable = book.reachableBots();
    assert.equal(reachable.length, 1);
    assert.equal(reachable[0].status, 'idle');
    assert.equal(reachable[0].frontBusy, false);

    // Front starts a turn and calls a tool -> busy
    await core.event({ id: 'front-session-1' }, { type: 'turn/start' });
    await core.event(
      { id: 'front-session-1' },
      { type: 'tool/call', data: { name: 'missiongo_list_issues', arguments: { query: '本周工单' } } },
    );
    assert.equal(core.loadView().status, 'busy');
    assert.equal(core.loadView().frontBusy, true);
    assert.equal(core.loadView().frontDoing?.tool, 'missiongo_list_issues');

    reachable = book.reachableBots();
    assert.equal(reachable[0].status, 'busy');
    assert.equal(reachable[0].frontBusy, true);
    assert.equal(reachable[0].frontDoing?.tool, 'missiongo_list_issues');

    // Front turn ends, but 1 background worker is running (out of maxWorkers=2) -> status is 'working'
    core.state.tasks['T-1'] = { id: 'T-1', title: '后台任务1', sessionId: 'w-1', status: 'running', createdAt: new Date().toISOString() };
    await core.event({ id: 'front-session-1' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
    assert.equal(core.loadView().frontBusy, false);
    assert.equal(core.loadView().status, 'working');
    assert.equal(core.loadView().activeWorkers, 1);

    // Second worker saturates maxWorkers=2 -> status becomes 'busy'
    core.state.tasks['T-2'] = { id: 'T-2', title: '后台任务2', sessionId: 'w-2', status: 'running', createdAt: new Date().toISOString() };
    core.state.tasks['T-3'] = { id: 'T-3', title: '后台任务3', status: 'queued', createdAt: new Date().toISOString() };
    assert.equal(core.loadView().status, 'busy');
    assert.equal(core.loadView().activeWorkers, 2);
    assert.equal(core.loadView().queuedWorkers, 1);

    // Check rt.statusOf in handoffs.js reflects WorkCore worker load
    const rt = {
      home: dir,
      state: { works: {}, bots: { 'bot-xiaoxin': { id: 'bot-xiaoxin', name: '小欣' } } },
      live: new Map(),
      groupOwners: new Map(),
      chatOf: () => 'front-session-1',
      groupSessionsOf: () => [],
      botOf: (id) => rt.state.bots[id],
      roomOf: () => undefined,
      save: async () => {},
    };
    handoffs.install(rt);
    const statusText = rt.statusOf('bot-xiaoxin');
    assert.match(statusText, /workers: 2\/2 running, 1 queued/);
    assert.match(statusText, /busy/);
  } finally {
    db.close();
    cleanup();
  }
});

test('message_bot queues by default when target Bot front is busy, and only steers when when="now"', async () => {
  const deliveries = [];
  const rt = {
    ctx: { on: () => () => {}, effect: () => () => {}, tools: { guard: () => () => {} } },
    state: {
      bots: {
        'bot-main': { id: 'bot-main', name: '怡丹' },
        'bot-worker': { id: 'bot-worker', name: '小欣' },
      },
      rooms: {},
      works: {},
    },
    teamTools: [],
    groupOwners: new Map(),
    live: new Map([['chat-worker', { turn: 1, since: Date.now() }]]),
    load: async () => {},
    selfOf: (sessionId) => (sessionId === 'chat-main' ? 'bot-main' : 'bot-worker'),
    botOf: (id) => rt.state.bots[id],
    findBot: (name) => Object.values(rt.state.bots).find((b) => b.name === name),
    roomOf: () => undefined,
    isMain: (id) => id === 'bot-main',
    chatOf: (id) => (id === 'bot-main' ? 'chat-main' : 'chat-worker'),
    groupSessionsOf: () => [],
    resolveAgent: async (sessionId) => ({ id: sessionId, inbox: { nextStep: [], nextTurn: [] } }),
    statusOf: () => 'working in its own chat (0m)',
    workOf: () => undefined,
    upstreamOf: () => new Set(),
    attachLong: async (text) => ({ text, files: [] }),
    openWork: () => {},
    dropWork: () => {},
    ownsWork: () => false,
    deliver: async (payload) => { deliveries.push(payload); },
  };
  hostTools.install(rt);
  const messageBot = rt.teamTools.find((t) => t.name === 'message_bot');
  assert.ok(messageBot, 'message_bot should be registered');

  // 1. Default call (no `when` specified) to a working Bot -> must queue (steer === false)
  const resDefault = await messageBot.execute(
    { to: '小欣', message: '帮我查一下今天的工单' },
    { agent: { id: 'chat-main' } },
  );
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].steer, false, 'default message_bot to busy Bot should queue (steer=false)');
  assert.match(resDefault, /^Queued for 小欣/);

  // 2. Explicit `when: "now"` to a working Bot -> steers mid-turn (steer === true)
  const resNow = await messageBot.execute(
    { to: '小欣', message: '紧急纠正：只查 HitGO 产品', when: 'now' },
    { agent: { id: 'chat-main' } },
  );
  assert.equal(deliveries.length, 2);
  assert.equal(deliveries[1].steer, true, 'explicit when="now" should steer (steer=true)');
  assert.match(resNow, /^Delivered to 小欣 while it is working/);
});

test('prompts instruct task-size autonomy and load-balanced routing', () => {
  const msg = nativeMessage({
    input: {
      requestId: 'req-1',
      botId: '@yidan:local',
      event: { eventId: '$1', roomId: '!r:local', senderId: '@u:local', body: 'hi' },
    },
    bot: { id: 'bot-yidan', name: '怡丹', role: '主理人' },
    files: { workdir: '/tmp', files: [] },
  });

  // Must mention quick tasks done directly by front and heavy tasks via dispatch_work
  assert.match(msg, /轻量|快速|直接/);
  assert.match(msg, /dispatch_work/);
  // Must mention load balancing / checking busy status in contacts
  assert.match(msg, /负载均衡|busy|空闲/);

  let promptSection;
  hostPrompt.install({
    ctx: {
      effect: (fn) => fn(),
      systemPrompt: {
        section: (sec) => { promptSection = sec; },
      },
    },
    selfOf: () => 'bot-yidan',
    botOf: () => ({ id: 'bot-yidan', name: '怡丹', role: '主理人' }),
    isMain: () => true,
    roomOf: () => undefined,
  });
  const rendered = promptSection.text({ agent: { id: 'chat-yidan' } });
  assert.match(rendered, /load[- ]balanc|idle|busy/i);
});
