/**
 * Host half of the Bot knowledge panel.
 *
 * Read-only over the DSCord knowledge database. This plugin never writes
 * `knowledge.sqlite`; the Bots keep writing through their own `remember` tool.
 */

import path from 'node:path';
import { homedir } from 'node:os';
import { openKnowledgeStore } from './store.js';
import { createKnowledgeHandler } from './handler.js';

export const name = 'bot-knowledge';
export const inject = ['connection'];

export function knowledgePaths(config = {}) {
  const home = process.env.DSH_HOME ? path.resolve(process.env.DSH_HOME) : path.join(homedir(), '.dsh');
  const botHome = path.join(home, 'bot');
  return {
    dbPath: config.dbPath || path.join(botHome, 'knowledge', 'knowledge.sqlite'),
    statePath: config.statePath || path.join(botHome, 'state.json'),
  };
}

export async function apply(ctx, config = {}) {
  const { dbPath, statePath } = knowledgePaths(config);
  let opened = null;
  const store = () => {
    if (!opened) opened = openKnowledgeStore({ dbPath, statePath });
    return opened;
  };
  const handle = createKnowledgeHandler({ store, schedule: ctx.get('schedule') || null });

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/bot-knowledge',
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      let result;
      try {
        result = await handle(await request.json());
      } catch (error) {
        result = { ok: false, error: { code: error.code || 'bot-knowledge/error', message: error.message } };
      }
      return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
    },
  }), 'bot-knowledge: HTTP route');

  ctx.effect(() => () => { try { opened?.close(); } catch { /* already closed */ } opened = null; },
    'bot-knowledge: read-only database');
}
