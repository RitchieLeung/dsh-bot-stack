import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { makeFixture } from './fixtures.js';
import { openKnowledgeStore } from '../lib/store.js';

async function withStore(fn) {
  const fixture = await makeFixture();
  const store = openKnowledgeStore({ dbPath: fixture.dbPath, statePath: fixture.statePath });
  try { await fn(store, fixture); } finally { store.close(); await fixture.cleanup(); }
}

test('bots() lists both bots with active memory and report counts', async () => {
  await withStore(async store => {
    const bots = store.bots({ date: '2026-11-10' });
    assert.equal(bots.length, 2);
    const a = bots.find(b => b.id === 'A');
    const b = bots.find(b => b.id === 'B');
    assert.equal(a.name, '甲');
    assert.equal(a.memoryCount, 3);
    assert.equal(a.reportCount, 1);
    assert.equal(b.memoryCount, 0);
    assert.equal(b.reportCount, 0);
  });
});

test('entries() returns active memories with bot name and sources', async () => {
  await withStore(async store => {
    const { items, shown, total } = store.entries({ botId: 'A' });
    assert.equal(total, 3);
    assert.equal(shown, 3);
    const report = items.find(i => i.id === 'm3');
    assert.equal(report.botName, '甲');
    assert.equal(report.category, 'daily-report');
    assert.equal(report.sources[0].authorId, 'user-1');
    assert.equal(report.sources[0].roomId, '!room:local');
  });
});

test('entries() filters by category', async () => {
  await withStore(async store => {
    assert.equal(store.entries({ botId: 'A', category: 'journal' }).total, 1);
    assert.equal(store.entries({ botId: 'A', category: 'knowledge' }).total, 1);
    assert.equal(store.entries({ botId: 'A', category: 'daily-report' }).total, 1);
  });
});

test('entries() paginates without losing the total', async () => {
  await withStore(async store => {
    const page = store.entries({ botId: 'A', limit: 2, offset: 0 });
    assert.equal(page.shown, 2);
    assert.equal(page.total, 3);
    const second = store.entries({ botId: 'A', limit: 2, offset: 2 });
    assert.equal(second.shown, 1);
  });
});

test('superseded memories are not listed as current', async () => {
  await withStore(async store => {
    const ids = store.entries({ botId: 'A' }).items.map(i => i.id);
    assert.ok(!ids.includes('m4'));
  });
});

test('reporting bots come from mainBotIds, then config, then the first bot', async () => {
  await withStore(async store => {
    assert.deepEqual(store.reportBotIds(), ['A']);
    assert.deepEqual(store.reportBotList().map(bot => bot.name), ['甲']);
  });
  const fixture = await makeFixture();
  try {
    const forced = openKnowledgeStore({ dbPath: fixture.dbPath, statePath: fixture.statePath, reportBotIds: ['B'] });
    assert.deepEqual(forced.reportBotIds(), ['B']);
    forced.close();
  } finally { await fixture.cleanup(); }
});

test('reports() returns the daily report for one date', async () => {
  await withStore(async store => {
    const reports = store.reports({ date: '2026-11-10' });
    assert.equal(reports.length, 1);
    assert.equal(reports[0].botId, 'A');
    assert.equal(reports[0].botName, '甲');
    assert.equal(reports[0].date, '2026-11-10');
    assert.equal(store.reports({ date: '2026-11-11' }).length, 0);
  });
});

test('a missing database is distinguishable from an empty bot', async () => {
  const fixture = await makeFixture();
  try {
    assert.throws(
      () => openKnowledgeStore({ dbPath: path.join(fixture.dir, 'nope.sqlite'), statePath: fixture.statePath }),
      error => error.code === 'KNOWLEDGE_DB_MISSING' && error.message.includes('nope.sqlite'));
    const garbage = path.join(fixture.dir, 'garbage.sqlite');
    await writeFile(garbage, 'this is definitely not a sqlite database');
    assert.throws(
      () => openKnowledgeStore({ dbPath: garbage, statePath: fixture.statePath }),
      error => error.code === 'KNOWLEDGE_DB_UNREADABLE');
  } finally { await fixture.cleanup(); }
});

test('a missing state file reports its own code', async () => {
  const fixture = await makeFixture();
  try {
    const store = openKnowledgeStore({ dbPath: fixture.dbPath, statePath: path.join(fixture.dir, 'nope.json') });
    assert.throws(() => store.bots({ date: '2026-11-10' }), error => error.code === 'KNOWLEDGE_STATE_MISSING');
    store.close();
  } finally { await fixture.cleanup(); }
});

test('a memory record without text does not break the page', async () => {
  const fixture = await makeFixture();
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(fixture.dbPath);
  db.prepare('INSERT INTO memories(id, bot, scope, status, json) VALUES (?, ?, ?, ?, ?)')
    .run('bad', 'A', 'own', 'active', JSON.stringify({ id: 'bad', botId: 'A', scope: 'own', status: 'active', observedAt: 1 }));
  db.close();
  const store = openKnowledgeStore({ dbPath: fixture.dbPath, statePath: fixture.statePath });
  try {
    const item = store.entries({ botId: 'A' }).items.find(i => i.id === 'bad');
    assert.equal(item.text, '（内容不可读）');
    assert.equal(item.category, 'knowledge');
  } finally { store.close(); await fixture.cleanup(); }
});
