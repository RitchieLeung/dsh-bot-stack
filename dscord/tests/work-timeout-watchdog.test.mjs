import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkCore, FRONT_TOOLS, WORKER_DENY } from '../dsh-connect/work-core.mjs';

function makeHarness({ mainBotId = 'bot-main', workerBotId = 'bot-heming', timeoutMs = 60 * 60_000, graceMs = 15 * 60_000, idleTimeoutMs = 20 * 60_000, hardTimeoutMs = 4 * 60 * 60_000 } = {}) {
  const prompts = [];
  const cancels = [];
  const nativeState = {
    mainBotId,
    mainBotIds: [mainBotId],
    bots: [
      { id: mainBotId, name: '小欣', sessionId: 'sess-main' },
      { id: workerBotId, name: '鹤鸣', sessionId: 'sess-heming' },
    ],
  };
  const makeAgent = sessionId => ({
    session: { id: sessionId },
    ctx: { tools: { register() {}, schemas: () => [], restrict() {} } },
    async cancel(reason) { cancels.push({ sessionId, reason }); },
  });
  const ctx = {
    tools: { guard() { return () => {}; } },
    on() { return () => {}; },
    sessionController: {
      async prompt(payload) { prompts.push(payload); },
    },
  };
  const native = {
    async state() { return nativeState; },
    async bot(id) { return nativeState.bots.find(b => b.id === id); },
    async agent(sessionId) { return makeAgent(sessionId); },
  };
  const mainCore = new WorkCore({
    ctx, native,
    node: { nativeBotId: mainBotId, localpart: 'xiaoxin', directory: '/tmp/test-main' },
    state: { tasks: {}, frontNotes: [] },
    save: async () => {},
    timeoutMs, graceMs, idleTimeoutMs, hardTimeoutMs,
  });
  mainCore.botName = '小欣';
  mainCore.frontSessions.add('sess-main');

  const workerCore = new WorkCore({
    ctx, native,
    node: { nativeBotId: workerBotId, localpart: 'heming', directory: '/tmp/test-heming' },
    state: { tasks: {}, frontNotes: [] },
    save: async () => {},
    timeoutMs, graceMs, idleTimeoutMs, hardTimeoutMs,
  });
  workerCore.botName = '鹤鸣';
  workerCore.frontSessions.add('sess-heming');

  const nowIso = new Date().toISOString();
  workerCore.state.tasks['T-test0001'] = {
    id: 'T-test0001',
    title: '按样板间能力架构重做内容擦除并交 Draft MR',
    status: 'running',
    sessionId: 'sess-worker-1',
    startedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    lastActivityAt: nowIso,
    createdAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    toolCalls: 188,
    busy: true,
    progress: '已完成最终截图，准备提 MR',
    lastText: '#23 已附上 6 张最终截图与完整验证记录',
    origin: { issueId: 'I-test23' },
    events: [],
  };

  return { mainCore, workerCore, prompts, cancels };
}

test('task_extend is registered in FRONT_TOOLS and denied on workers', () => {
  assert.equal(FRONT_TOOLS.has('task_extend'), true);
  assert.equal(WORKER_DENY.has('task_extend'), true);
});

test('60-min soft timeout notifies Main Bot without interrupting the worker', async () => {
  const { mainCore, workerCore, prompts, cancels } = makeHarness();
  try {
    await workerCore.checkTimeout('T-test0001');
    const task = workerCore.state.tasks['T-test0001'];
    assert.equal(task.status, 'running', 'worker must NOT be killed at soft timeout');
    assert.equal(cancels.length, 0, 'worker agent must NOT be cancelled');
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].sessionId, 'sess-main', 'must notify Main Bot');
    const promptText = prompts[0].content?.[0]?.text || '';
    assert.match(promptText, /任务超时巡检提醒/);
    assert.match(promptText, /T-test0001/);
    assert.match(promptText, /188 次/);
    assert.match(promptText, /task_extend/);

    // Main Bot can inspect and extend cross-Bot task
    const statusText = mainCore.status('T-test0001');
    assert.match(statusText, /鹤鸣/);
    assert.match(statusText, /188 次/);

    const extendReply = await mainCore.extend('T-test0001', { minutes: 60, reason: '还在正常收尾' });
    assert.match(extendReply, /已为 T-test0001 续期/);
    assert.equal(task.extendedCount, 1);
  } finally {
    for (const t of workerCore.timers.values()) clearTimeout(t);
  }
});

test('graceTimeout keeps active worker running when not extended, but stops truly idle worker', async () => {
  const { workerCore, cancels } = makeHarness({ idleTimeoutMs: 20 * 60_000, hardTimeoutMs: 4 * 60 * 60_000 });
  try {
    const task = workerCore.state.tasks['T-test0001'];
    const notifiedAt = new Date(Date.now() - 15 * 60_000).toISOString();
    // Case 1: worker is still active (lastActivityAt is now) -> do NOT kill
    task.lastActivityAt = new Date().toISOString();
    await workerCore.graceTimeout('T-test0001', notifiedAt);
    assert.equal(task.status, 'running');
    assert.equal(cancels.length, 0);

    // Case 2: worker has been idle for 25 minutes -> stop as stalled
    task.lastActivityAt = new Date(Date.now() - 25 * 60_000).toISOString();
    await workerCore.graceTimeout('T-test0001', notifiedAt);
    assert.equal(task.status, 'failed');
    assert.equal(cancels.length, 1);
    assert.match(task.summary, /判定卡死并已停止/);
  } finally {
    for (const t of workerCore.timers.values()) clearTimeout(t);
  }
});

test('Main Bot can cross-Bot cancel an unhealthy worker task, but non-main peer cannot', async () => {
  const { mainCore, workerCore, cancels } = makeHarness();
  const peerCore = new WorkCore({
    ctx: { tools: { guard() { return () => {}; } }, on() { return () => {}; }, sessionController: { async prompt() {} } },
    native: mainCore.native,
    node: { nativeBotId: 'bot-peer', localpart: 'peer', directory: '/tmp/test-peer' },
    state: { tasks: {}, frontNotes: [] },
    save: async () => {},
  });
  try {
    const denied = await peerCore.cancel('T-test0001');
    assert.match(denied, /只有主 Bot 才能跨 Bot/);
    assert.equal(workerCore.state.tasks['T-test0001'].status, 'running');
    assert.equal(cancels.length, 0);

    const deniedExtend = await peerCore.extend('T-test0001', { minutes: 60 });
    assert.match(deniedExtend, /只有主 Bot 才能跨 Bot/);

    const res = await mainCore.cancel('T-test0001');
    assert.equal(res, 'T-test0001 已取消。');
    assert.equal(workerCore.state.tasks['T-test0001'].status, 'cancelled');
    assert.equal(cancels.length, 1);
    assert.equal(cancels[0].sessionId, 'sess-worker-1');
  } finally {
    for (const t of workerCore.timers.values()) clearTimeout(t);
  }
});

test('hardTimeoutMs enforces an upper bound so runaway tasks cannot hold slots forever', async () => {
  const { workerCore, cancels } = makeHarness({ hardTimeoutMs: 4 * 60 * 60_000 });
  try {
    const task = workerCore.state.tasks['T-test0001'];
    task.startedAt = new Date(Date.now() - 4 * 60 * 60_000 - 60_000).toISOString();
    await workerCore.checkTimeout('T-test0001');
    assert.equal(task.status, 'failed');
    assert.equal(cancels.length, 1);
    assert.match(task.summary, /超过最长上限/);
  } finally {
    for (const t of workerCore.timers.values()) clearTimeout(t);
  }
});
