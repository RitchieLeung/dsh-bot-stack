/**
 * Read-only access to the DSCord knowledge store.
 *
 * Every read here opens the database with `readOnly: true`. The panel must
 * never write: Bots own their memories through their own `remember` tool.
 */

import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { classifyMemory, REPORT_PREDICATE } from './classify.js';

const UNREADABLE_TEXT = '（内容不可读）';

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function openDatabase(dbPath) {
  if (!existsSync(dbPath)) {
    throw failure('KNOWLEDGE_DB_MISSING', `找不到记忆库：${dbPath}`);
  }
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 2000');
    // A garbage file opens lazily; probe it so the failure is reported here.
    db.prepare('SELECT count(*) AS c FROM memories').get();
    return db;
  } catch (error) {
    try { db?.close(); } catch { /* already unusable */ }
    throw failure('KNOWLEDGE_DB_UNREADABLE', `记忆库无法读取：${dbPath}（${error.message}）`);
  }
}

function readBots(statePath) {
  if (!existsSync(statePath)) {
    throw failure('KNOWLEDGE_STATE_MISSING', `找不到 Bot 配置：${statePath}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(statePath, 'utf8'));
  } catch (error) {
    throw failure('KNOWLEDGE_STATE_MISSING', `Bot 配置无法解析：${statePath}（${error.message}）`);
  }
  const bots = parsed?.bots && typeof parsed.bots === 'object' ? Object.values(parsed.bots) : [];
  const byId = new Map();
  for (const bot of bots) {
    if (!bot || typeof bot.id !== 'string') continue;
    byId.set(bot.id, {
      id: bot.id,
      name: typeof bot.name === 'string' && bot.name.trim() ? bot.name : bot.id,
      role: typeof bot.role === 'string' ? bot.role : '',
      model: typeof bot.model === 'string' ? bot.model : '',
      sessionId: typeof bot.sessionId === 'string' ? bot.sessionId : null,
    });
  }
  return byId;
}

function decodeRow(row, botName, sourceOf) {
  let record;
  try {
    record = JSON.parse(row.json);
  } catch {
    record = null;
  }
  if (!record || typeof record !== 'object') {
    return {
      id: row.id, botId: row.bot, botName, text: UNREADABLE_TEXT, kind: '', predicate: '', facets: [],
      scope: row.scope || 'own', status: row.status || 'unknown', observedAt: null, topic: null,
      category: 'knowledge', sources: [],
    };
  }
  const text = typeof record.text === 'string' && record.text.trim() ? record.text : UNREADABLE_TEXT;
  const facets = Array.isArray(record.facets) ? record.facets.filter(f => typeof f === 'string') : [];
  const observedAt = typeof record.observedAt === 'number' ? record.observedAt : null;
  const sourceRefs = Array.isArray(record.sourceRefs) ? record.sourceRefs : [];
  return {
    id: row.id,
    botId: typeof record.botId === 'string' ? record.botId : row.bot,
    botName,
    text,
    kind: typeof record.kind === 'string' ? record.kind : '',
    predicate: typeof record.predicate === 'string' ? record.predicate : '',
    facets,
    scope: typeof record.scope === 'string' ? record.scope : (row.scope || 'own'),
    status: row.status || (typeof record.status === 'string' ? record.status : 'unknown'),
    observedAt,
    topic: typeof record.topic === 'string' ? record.topic : null,
    ...classifyMemory(record),
    sources: sourceRefs
      .filter(ref => ref && typeof ref.id === 'string')
      .map(ref => sourceOf(ref)),
  };
}

export function openKnowledgeStore({ dbPath, statePath }) {
  const db = openDatabase(dbPath);
  const selectActive = db.prepare("SELECT id, bot, scope, status, json FROM memories WHERE status = 'active'");
  const selectSource = db.prepare('SELECT json FROM sources WHERE id = ? AND revision = ?');
  let bots = null;

  function botDirectory() {
    bots ||= readBots(statePath);
    return bots;
  }

  function sourceOf(ref) {
    const unknown = { id: ref.id, revision: typeof ref.revision === 'number' ? ref.revision : null, authorId: null, roomId: null, eventId: null };
    if (typeof ref.revision !== 'number') return unknown;
    let row;
    try {
      row = selectSource.get(ref.id, ref.revision);
    } catch {
      return unknown;
    }
    if (!row) return unknown;
    try {
      const source = JSON.parse(row.json);
      return { ...unknown,
        authorId: typeof source.authorId === 'string' ? source.authorId : null,
        roomId: typeof source.roomId === 'string' ? source.roomId : null,
        eventId: typeof source.eventId === 'string' ? source.eventId : null };
    } catch {
      return unknown;
    }
  }

  function allEntries() {
    const directory = botDirectory();
    return selectActive.all().map(row => decodeRow(row, directory.get(row.bot)?.name || row.bot, sourceOf));
  }

  function byObservedDesc(a, b) {
    return (b.observedAt || 0) - (a.observedAt || 0);
  }

  return {
    bots({ date } = {}) {
      const directory = botDirectory();
      const entries = allEntries();
      return [...directory.values()].map(bot => {
        const mine = entries.filter(entry => entry.botId === bot.id);
        return {
          id: bot.id,
          name: bot.name,
          role: bot.role,
          model: bot.model,
          memoryCount: mine.length,
          reportCount: mine.filter(entry => entry.category === 'daily-report' && (!date || entry.topic === date)).length,
        };
      });
    },

    entries({ botId, category, limit = 50, offset = 0 } = {}) {
      const all = allEntries()
        .filter(entry => (botId ? entry.botId === botId : true))
        .filter(entry => (category ? entry.category === category : true))
        .sort(byObservedDesc);
      const start = Math.max(0, offset);
      const size = Math.max(1, limit);
      return { items: all.slice(start, start + size), shown: all.slice(start, start + size).length, total: all.length };
    },

    reports({ date } = {}) {
      if (typeof date !== 'string' || !date) return [];
      const directory = botDirectory();
      return allEntries()
        .filter(entry => entry.category === 'daily-report' && entry.topic === date)
        .sort((a, b) => (a.observedAt || 0) - (b.observedAt || 0))
        .map(entry => ({
          botId: entry.botId,
          botName: entry.botName || directory.get(entry.botId)?.name || entry.botId,
          date,
          text: entry.text,
          observedAt: entry.observedAt,
          memoryId: entry.id,
        }));
    },

    /** Bot directory without touching memories; used by the schedule endpoints. */
    botList() {
      return [...botDirectory().values()];
    },

    close() {
      try { db.close(); } catch { /* already closed */ }
    },
  };
}

export { REPORT_PREDICATE };
