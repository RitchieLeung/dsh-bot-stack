import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexEngine, isLocalExecItem } from '../vendor/ds-bot/src/host/local-agents/codex.js';
import { trackFrontLocalExec, maybeAutoCompact } from '../vendor/ds-bot/src/host/local-agents/budget.js';

test('isLocalExecItem distinguishes local execution items from non-exec and dsbot MCP calls', () => {
  assert.equal(isLocalExecItem({ type: 'commandExecution', command: 'ls' }), true);
  assert.equal(isLocalExecItem({ type: 'fileChange' }), true);
  assert.equal(isLocalExecItem({ type: 'customToolCall', name: 'exec' }), true);
  assert.equal(isLocalExecItem({ type: 'mcpToolCall', server: 'gitlab', tool: 'list_mrs' }), true);
  assert.equal(isLocalExecItem({ type: 'mcpToolCall', server: 'dsbot', tool: 'issue_get' }), false);
  assert.equal(isLocalExecItem({ type: 'userMessage' }), false);
  assert.equal(isLocalExecItem({ type: 'agentMessage' }), false);
  assert.equal(isLocalExecItem({ type: 'reasoning' }), false);
});

test('CodexEngine marks localExec activities, forwards contextWindow, and supports thread/compact/start', async () => {
  const engine = new CodexEngine('codex-cli', { name: 'Codex' }, { findExecutable: () => '/usr/bin/codex' });
  const rpcCalls = [];
  engine.peer = {
    async request(method, params) {
      rpcCalls.push({ method, params });
      return {};
    },
  };
  const thread = engine.threadFor('sess-1');
  thread.threadId = 'thr-123';

  engine.onNotice('item/started', { threadId: 'thr-123', item: { type: 'commandExecution', command: 'pytest -q' } });
  const ev1 = await thread.next();
  assert.equal(ev1.type, 'activity');
  assert.equal(ev1.localExec, true);

  engine.onNotice('item/started', { threadId: 'thr-123', item: { type: 'mcpToolCall', server: 'dsbot', tool: 'issue_comment' } });
  const ev2 = await thread.next();
  assert.equal(ev2.type, 'activity');
  assert.equal(ev2.localExec, undefined);

  engine.onNotice('thread/tokenUsage/updated', {
    threadId: 'thr-123',
    tokenUsage: {
      last: { inputTokens: 150_000, cachedInputTokens: 120_000, outputTokens: 1_000 },
      modelContextWindow: 1_000_000,
    },
  });
  const ev3 = await thread.next();
  assert.equal(ev3.type, 'usage');
  assert.equal(ev3.usage.inputTokens, 30_000);
  assert.equal(ev3.usage.cacheReadInputTokens, 120_000);
  assert.equal(ev3.contextWindow, 1_000_000);

  const ok = await engine.compact(thread);
  assert.equal(ok, true);
  assert.deepEqual(rpcCalls, [{ method: 'thread/compact/start', params: { threadId: 'thr-123' } }]);
});

test('trackFrontLocalExec steers front session at frontMaxToolCalls and interrupts runaway front, while sparing workers', () => {
  const steers = [];
  const cancels = [];
  const rt = {
    state: { prefs: { frontMaxToolCalls: 3 } },
    selfOf: id => (id === 'sess-front' ? { id: 'bot-zy' } : undefined),
    warn() {},
  };

  const frontLive = {
    sessionId: 'sess-front',
    engineSession: { threadId: 'thr-f' },
    engine: {
      steer(_s, text) { steers.push(text); },
      cancel() { cancels.push('cancelled'); },
    },
  };
  for (let i = 0; i < 2; i++) assert.equal(trackFrontLocalExec(frontLive, rt), 'counted');
  assert.equal(steers.length, 0);
  assert.equal(cancels.length, 0);

  // 3rd call hits limit -> steer
  assert.equal(trackFrontLocalExec(frontLive, rt), 'steered');
  assert.equal(steers.length, 1);
  assert.match(steers[0], /已达上限（3 次）/);
  assert.match(steers[0], /dispatch_work/);
  assert.equal(cancels.length, 0);

  // 4th, 5th, 6th call (limit + 3) -> hard interrupt
  trackFrontLocalExec(frontLive, rt);
  trackFrontLocalExec(frontLive, rt);
  assert.equal(cancels.length, 0);
  assert.equal(trackFrontLocalExec(frontLive, rt), 'interrupted');
  assert.equal(cancels.length, 1);

  // Worker session is not restricted
  const workerLive = {
    sessionId: 'sess-worker',
    engineSession: { threadId: 'thr-w' },
    engine: {
      steer(_s, text) { steers.push(text); },
      cancel() { cancels.push('worker-cancelled'); },
    },
  };
  for (let i = 0; i < 15; i++) assert.equal(trackFrontLocalExec(workerLive, rt), 'ignored');
  assert.equal(steers.length, 1);
  assert.equal(cancels.length, 1);
});

test('maybeAutoCompact auto-compacts Codex session past compactMaxK / compactRatio with cooldown', async () => {
  let compactCalls = 0;
  const rt = {
    state: { prefs: { compactRatio: 45, compactMaxK: 120 } },
    selfOf: () => ({ id: 'bot-zy' }),
    warn() {},
  };

  const live = {
    sessionId: 'sess-front',
    dead: false,
    contextWindow: 1_000_000,
    lastPromptTokens: 100_000,
    engineSession: { threadId: 'thr-1' },
    engine: {
      async compact() { compactCalls += 1; return true; },
    },
  };

  // Below 120K cap -> no compact
  assert.equal(await maybeAutoCompact(live, rt), false);
  assert.equal(compactCalls, 0);

  // Exceeds 120K cap -> triggers compact and resets lastPromptTokens
  live.lastPromptTokens = 135_000;
  assert.equal(await maybeAutoCompact(live, rt), true);
  assert.equal(compactCalls, 1);
  assert.equal(live.lastPromptTokens, 0);

  // Immediate re-trigger within cooldown -> skipped
  live.lastPromptTokens = 140_000;
  assert.equal(await maybeAutoCompact(live, rt), false);
  assert.equal(compactCalls, 1);
});
