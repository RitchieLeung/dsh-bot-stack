import test from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture } from './fixtures.js';
import { openKnowledgeStore } from '../lib/store.js';
import { createKnowledgeHandler } from '../lib/handler.js';

async function withHandler(fn, { schedule = null } = {}) {
  const fixture = await makeFixture();
  const store = openKnowledgeStore({ dbPath: fixture.dbPath, statePath: fixture.statePath });
  const handle = createKnowledgeHandler({ store, schedule });
  try { await fn(handle, store); } finally { store.close(); await fixture.cleanup(); }
}

test('an unknown action reports a code instead of throwing', async () => {
  await withHandler(async handle => {
    const result = await handle({ action: 'nope' });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'UNKNOWN_ACTION');
  });
});

test('a non-object body is rejected', async () => {
  await withHandler(async handle => {
    for (const body of [null, 42, 'x', []]) {
      const result = await handle(body);
      assert.equal(result.ok, false);
      assert.equal(result.error.code, 'INVALID_BODY');
    }
  });
});

test('bots action returns every bot', async () => {
  await withHandler(async handle => {
    const result = await handle({ action: 'bots', date: '2026-11-10' });
    assert.equal(result.ok, true);
    assert.equal(result.value.bots.length, 2);
    assert.equal(result.value.bots.find(b => b.id === 'A').reportCount, 1);
  });
});

test('entries action filters by bot', async () => {
  await withHandler(async handle => {
    const result = await handle({ action: 'entries', botId: 'A' });
    assert.equal(result.ok, true);
    assert.equal(result.value.total, 3);
  });
});

test('reports action defaults to today in Asia/Shanghai', async () => {
  await withHandler(async handle => {
    const result = await handle({ action: 'reports' });
    assert.equal(result.ok, true);
    assert.match(result.value.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(Array.isArray(result.value.reports));
    // The default date is the Shanghai calendar day, independent of the test clock.
    assert.equal(result.value.date, new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date()));
  });
});

test('reports action returns the stored report for an explicit date', async () => {
  await withHandler(async handle => {
    const result = await handle({ action: 'reports', date: '2026-11-10' });
    assert.equal(result.value.reports.length, 1);
    assert.equal(result.value.reports[0].botName, '甲');
  });
});

test('a missing database surfaces its own code and the path', async () => {
  await withHandler(async handle => {
    const result = await handle({ action: 'bots' });
    assert.equal(result.ok, true);
  });
  const fixture = await makeFixture();
  try {
    const store = openKnowledgeStore({ dbPath: fixture.dbPath, statePath: fixture.statePath });
    store.close();
    const handle = createKnowledgeHandler({ store, schedule: null });
    const result = await handle({ action: 'bots' });
    assert.equal(result.ok, false);
    assert.equal(typeof result.error.message, 'string');
  } finally { await fixture.cleanup(); }
});

test('schedule actions report that scheduling is unavailable without a service', async () => {
  await withHandler(async handle => {
    for (const action of ['schedules', 'ensure-schedules']) {
      const result = await handle({ action });
      assert.equal(result.ok, false);
      assert.equal(result.error.code, 'SCHEDULE_UNAVAILABLE');
    }
  });
});

test('schedules action lists only daily report tasks, with bot names', async () => {
  const schedule = {
    async list() {
      return { items: [
        { id: 's1', title: 'bot-daily-report:A', status: 'active', scheduledAt: '2026-11-11T11:00:00Z',
          target: { kind: 'session', sessionId: 'session-a' } },
        { id: 's2', title: 'some-other-task', status: 'active' },
      ] };
    },
  };
  await withHandler(async handle => {
    const result = await handle({ action: 'schedules' });
    assert.equal(result.ok, true);
    assert.equal(result.value.items.length, 1);
    assert.equal(result.value.items[0].botName, '甲');
    assert.equal(result.value.bots.length, 2);
  }, { schedule });
});

test('ensure-schedules action arms a task per bot', async () => {
  const calls = [];
  const schedule = {
    async list() { return { items: [] }; },
    async create(request) { calls.push(request); return { id: `x${calls.length}`, ...request }; },
    async edit(request) { calls.push(request); return request; },
  };
  await withHandler(async handle => {
    const result = await handle({ action: 'ensure-schedules' });
    assert.equal(result.ok, true);
    assert.equal(result.value.results.length, 2);
    assert.deepEqual(calls.map(call => call.target.sessionId), ['session-a', 'session-b']);
    assert.equal(calls[0].timing.daily.time, '19:00:00');
  }, { schedule });
});
