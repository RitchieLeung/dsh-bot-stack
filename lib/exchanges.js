/**
 * Read-only access to the DSCord Bot-to-Bot private chat records.
 *
 * Every read opens a Bot's own node database with `readOnly: true`. The panel
 * must never write: private chat belongs to the Bots' own `message_bot` tool.
 *
 * Layout on disk (one node database per Bot):
 *   <nodesRoot>/<hostId>/nodes/<bot-uuid>/node.sqlite
 * Each database holds `contact_exchanges` (one row per private exchange) and
 * `contacts` (the peer names). The Bot's display name lives in the kernel state.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function parseJson(value) {
  try { return JSON.parse(value); } catch { return null; }
}

function shortName(id) {
  const localpart = String(id || '').split(':')[0];
  return localpart.length > 20 ? `${localpart.slice(0, 18)}…` : localpart || '未知';
}

function openNodeDatabase(file) {
  if (!existsSync(file)) return null;
  let db = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 2000');
    // A garbage file opens lazily; probe it so the failure is reported here.
    db.prepare('SELECT count(*) AS c FROM contact_exchanges').get();
    return db;
  } catch {
    try { db?.close(); } catch { /* already closed */ }
    return null;
  }
}

/** Bot display names keyed by native Bot id (`session-…`), read from the kernel state. */
function readBotNames(statePath) {
  const names = new Map();
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    for (const bot of Object.values(state.bots ?? {})) {
      if (bot && typeof bot.id === 'string') names.set(bot.id, bot.name || '');
    }
  } catch { /* a missing state file only costs us names */ }
  return names;
}

/** One node directory's Bot identity: `{ botId, nativeBotId }`. */
function readNodeIdentity(dir) {
  const bridge = parseJson(existsSync(path.join(dir, 'native-bridge.json'))
    ? readFileSync(path.join(dir, 'native-bridge.json'), 'utf8')
    : '');
  return { nativeBotId: typeof bridge?.nativeBotId === 'string' ? bridge.nativeBotId : '' };
}

export function openExchangeStore({ nodesRoot, statePath }) {
  return {
    close() { /* every read opens and closes its own database */ },

    view() {
      const names = readBotNames(statePath);
      const bots = [];
      let hosts = [];
      try {
        hosts = readdirSync(nodesRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);
      } catch {
        return { bots: [], nodesRoot };
      }
      for (const host of hosts) {
        const nodesDir = path.join(nodesRoot, host, 'nodes');
        let dirs = [];
        try {
          dirs = readdirSync(nodesDir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);
        } catch { continue; }
        for (const dir of dirs) {
          const nodeDir = path.join(nodesDir, dir);
          const db = openNodeDatabase(path.join(nodeDir, 'node.sqlite'));
          if (!db) continue;
          try {
            const peers = new Map((db.prepare('SELECT id, name FROM contacts').all() ?? [])
              .map(row => [row.id, row.name]));
            const rows = db.prepare(`SELECT id, at, direction, peer_id, via, room_id, origin_json, status, task_id, detail
              FROM contact_exchanges ORDER BY at DESC`).all() ?? [];
            const exchanges = rows.map(row => {
              const origin = parseJson(row.origin_json) ?? {};
              return {
                id: row.id,
                at: row.at,
                direction: row.direction === 'in' ? 'in' : 'out',
                peerId: row.peer_id,
                peerName: peers.get(row.peer_id) || shortName(row.peer_id),
                via: row.via,
                roomId: row.room_id || '',
                status: row.status,
                taskId: row.task_id || '',
                detail: row.detail || '',
                body: typeof origin.body === 'string' ? origin.body : '',
                senderName: origin.senderName || origin.senderId || '',
              };
            });
            const identity = readNodeIdentity(path.join(nodesRoot, host));
            bots.push({
              id: dir,
              name: names.get(identity.nativeBotId) || shortName(dir),
              nativeBotId: identity.nativeBotId,
              exchanges,
            });
          } finally {
            try { db.close(); } catch { /* already closed */ }
          }
        }
      }
      bots.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
      return { bots, nodesRoot };
    },
  };
}
