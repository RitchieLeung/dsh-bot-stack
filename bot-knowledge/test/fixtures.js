import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SOURCE_A = {
  id: 'source_a', revision: 1,
  json: JSON.stringify({ id: 'source_a', revision: 1, authorId: 'user-1', roomId: '!room:local', eventId: '$event-a', body: '原始来源', authorKind: 'human' }),
};

function memory(id, bot, status, record) {
  return {
    id, bot, status,
    scope: record.scope || 'own',
    json: JSON.stringify({ id, botId: bot, scope: record.scope || 'own', status, revision: 1, observedAt: record.observedAt,
      text: record.text, kind: record.kind || 'stated', predicate: record.predicate, facets: record.facets || [],
      topic: record.topic ?? null, claimState: 'statement', saidBy: record.saidBy || 'user-1', subjectId: 'user-1',
      sourceRefs: record.sourceRefs || [], entityIds: [], projectIds: [], basisRefs: [], validFrom: null, validUntil: null }),
  };
}

export async function makeFixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'bot-knowledge-fixture-'));
  const dbPath = path.join(dir, 'knowledge.sqlite');
  const statePath = path.join(dir, 'state.json');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE memories(id TEXT PRIMARY KEY, bot TEXT NOT NULL, scope TEXT NOT NULL, status TEXT NOT NULL, json TEXT NOT NULL);
    CREATE TABLE sources(id TEXT, revision INTEGER, json TEXT NOT NULL, PRIMARY KEY(id,revision));
    CREATE TABLE source_heads(id TEXT PRIMARY KEY, revision INTEGER NOT NULL);
    CREATE TABLE journal(seq INTEGER PRIMARY KEY AUTOINCREMENT, json TEXT NOT NULL);`);
  const insertSource = db.prepare('INSERT INTO sources(id, revision, json) VALUES (?, ?, ?)');
  insertSource.run(SOURCE_A.id, SOURCE_A.revision, SOURCE_A.json);
  const insert = db.prepare('INSERT INTO memories(id, bot, scope, status, json) VALUES (?, ?, ?, ?, ?)');
  const rows = [
    memory('m1', 'A', 'active', { observedAt: 1794291000000, text: '甲的职责是项目管理', predicate: 'role' }),
    memory('m2', 'A', 'active', { observedAt: 1794291100000, text: '发布窗口的教训', predicate: 'release-window', facets: ['experience'] }),
    memory('m3', 'A', 'active', { observedAt: 1794291200000, text: '今天做完了 A 和 B', predicate: 'daily-report', facets: ['experience'], topic: '2026-11-10', kind: 'inference', sourceRefs: [{ id: SOURCE_A.id, revision: SOURCE_A.revision }] }),
    memory('m4', 'A', 'superseded', { observedAt: 1794290900000, text: '旧职责', predicate: 'role' }),
  ];
  for (const row of rows) insert.run(row.id, row.bot, row.scope, row.status, row.json);
  db.close();
  await writeFile(statePath, JSON.stringify({
    version: 1,
    mainBotIds: ['A'],
    bots: {
      A: { id: 'A', name: '甲', role: '职责甲', model: 'm1', sessionId: 'session-a' },
      B: { id: 'B', name: '乙', role: '职责乙', model: 'm2', sessionId: 'session-b' },
    },
  }));
  return { dir, dbPath, statePath, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
