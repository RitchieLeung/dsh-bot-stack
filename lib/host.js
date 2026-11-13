/**
 * Host half of the issue board (事务模块).
 *
 * A sibling plugin to dsh-plugin-bot-knowledge, not nested inside it: this one
 * owns the writable issue store, the HTTP route the browser half calls, and the
 * model-facing `issue_*` tools the main Bot uses. It never touches the knowledge
 * database.
 */

import path from 'node:path';
import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { openIssueStore, STATUSES } from './store.js';
import { createIssueHandler } from './handler.js';

export const name = 'bot-issue';
export const inject = ['connection'];

export function issuePaths(config = {}) {
  const home = process.env.DSH_HOME ? path.resolve(process.env.DSH_HOME) : path.join(homedir(), '.dsh');
  const botHome = path.join(home, 'bot');
  return {
    dbPath: config.dbPath || path.join(botHome, 'issue', 'issue.sqlite'),
    statePath: config.statePath || path.join(botHome, 'state.json'),
  };
}

/** The main Bot on this host: Mac 鲸鱼 / 146 小欣, read from dscord's state, never hardcoded. */
export function resolveMainBot(statePath) {
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
    const bots = parsed?.bots && typeof parsed.bots === 'object' ? Object.values(parsed.bots) : [];
    const mainBotIds = Array.isArray(parsed?.mainBotIds) ? parsed.mainBotIds.filter(id => typeof id === 'string') : [];
    const byId = new Map(bots.filter(bot => bot && typeof bot.id === 'string').map(bot => [bot.id, bot]));
    const id = mainBotIds.find(candidate => byId.has(candidate)) || [...byId.keys()][0] || null;
    if (!id) return null;
    const bot = byId.get(id);
    return { id, name: typeof bot.name === 'string' && bot.name.trim() ? bot.name : id, sessionId: typeof bot.sessionId === 'string' ? bot.sessionId : null };
  } catch {
    return null;
  }
}

/** Who a tool call is attributed to: an agent session or the local user. */
function caller(exec) {
  const agent = exec?.agent;
  if (agent) {
    return { kind: 'agent', name: agent.session?.title || agent.name || '主 Bot', id: agent.id || agent.session?.id || '' };
  }
  return { kind: 'user', name: '用户', id: '' };
}

const brief = issue => ({ id: issue.id, title: issue.title, status: issue.status, parentId: issue.parentId, updatedAt: issue.updatedAt });
const statusLine = issue => `${issue.status.padEnd(11)} ${issue.id}  ${issue.title}`;
const renderText = text => (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : text }];

export function apply(ctx, config = {}) {
  const { dbPath, statePath } = issuePaths(config);
  let opened = null;
  const store = () => {
    if (!opened) opened = openIssueStore({ dbPath });
    return opened;
  };
  const mainBot = resolveMainBot(statePath);

  const handle = createIssueHandler({ store, mainBot, start: null });

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/bot-issue',
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      let result;
      try {
        result = await handle(await request.json());
      } catch (error) {
        result = { ok: false, error: { code: error.code || 'bot-issue/error', message: error.message } };
      }
      return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
    },
  }), 'bot-issue: HTTP route');

  // Model-facing tools: the main Bot manages issues through these.
  ctx.inject(['tools'], toolsCtx => {
    const register = def => toolsCtx.tools.register(defineTool(def));

    toolsCtx.effect(() => register({
      name: 'issue_create',
      description: '新建一个事务（issue）。每件事从一个 issue 出发：写清要做什么，之后可以评论讨论、派工给工作者，结果会闭环写回这里。',
      parameters: {
        title: { type: 'string', required: true, description: '一句话标题' },
        body: { type: 'string', description: '完整说明：背景、要做成什么、验收标准' },
        parentId: { type: 'string', description: '拆分子任务时，挂到父 issue 的 id 下' },
      },
      output: { schema: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string' } }, additionalProperties: false } },
      async execute(args, exec) {
        const issue = store().create({ title: args.title, body: args.body, parentId: args.parentId, createdBy: 'agent', createdByName: caller(exec).name });
        return { id: issue.id, status: issue.status };
      },
    }), 'bot-issue: tool create');

    toolsCtx.effect(() => register({
      name: 'issue_list',
      description: '列出事务。可按状态或父 issue 过滤，返回简要信息；要看全文用 issue_get。',
      parameters: {
        status: { type: 'string', enum: [...STATUSES], description: '只列这个状态' },
        parentId: { type: 'string', description: '只列挂在某个父 issue 下的子事务' },
      },
      output: { schema: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, status: { type: 'string' } }, additionalProperties: false } } },
      async execute(args) {
        return store().list({ status: args.status, parentId: args.parentId }).items.map(brief);
      },
    }), 'bot-issue: tool list');

    toolsCtx.effect(() => register({
      name: 'issue_get',
      description: '读一个事务的全文：标题、正文、状态、结果、评论时间线和派工记录。返回的 version 用于 issue_update 的安全写入。',
      parameters: { id: { type: 'string', required: true, description: 'issue id' } },
      output: { schema: { type: 'object', additionalProperties: true } },
      async execute(args) {
        const issue = store().get(args.id);
        return {
          id: issue.id, title: issue.title, body: issue.body, status: issue.status, version: issue.version,
          result: issue.result, createdByName: issue.createdByName, createdAt: issue.createdAt, updatedAt: issue.updatedAt,
          comments: issue.comments.map(c => `${c.authorName || c.authorKind}: ${c.body}`),
          dispatches: issue.dispatches.map(d => `${d.taskId} (${d.status})`),
        };
      },
    }), 'bot-issue: tool get');

    toolsCtx.effect(() => register({
      name: 'issue_update',
      description: '更新事务：改状态、写结果、改标题或正文。改状态要遵守流转规则（open/discussing/dispatched/in_review/done/failed/cancelled）；传 expectedVersion 可避免覆盖别人的改动。',
      parameters: {
        id: { type: 'string', required: true, description: 'issue id' },
        status: { type: 'string', enum: [...STATUSES], description: '目标状态' },
        result: { type: 'string', description: '闭环结果说明（done 时写）' },
        title: { type: 'string' },
        body: { type: 'string' },
        expectedVersion: { type: 'integer', description: 'issue_get 读到的 version，不一致会拒绝写入' },
      },
      output: { schema: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string' }, version: { type: 'integer' } }, additionalProperties: false } },
      async execute(args, exec) {
        const issue = store().update(args.id, {
          status: args.status, result: args.result, title: args.title, body: args.body,
          expectedVersion: typeof args.expectedVersion === 'number' ? args.expectedVersion : undefined,
        }, caller(exec));
        return { id: issue.id, status: issue.status, version: issue.version };
      },
    }), 'bot-issue: tool update');

    toolsCtx.effect(() => register({
      name: 'issue_comment',
      description: '给事务追加一条评论（发现、结论、交接说明等），同时会出现在时间线里。',
      parameters: {
        id: { type: 'string', required: true, description: 'issue id' },
        body: { type: 'string', required: true, description: '评论内容' },
      },
      output: { schema: { type: 'object', properties: { id: { type: 'integer' } }, additionalProperties: false } },
      async execute(args, exec) {
        if (!String(args.body || '').trim()) throw new Error('评论不能为空');
        const value = store().comment(args.id, { body: args.body, authorKind: 'agent', authorName: caller(exec).name });
        return { id: value.id };
      },
    }), 'bot-issue: tool comment');
  });

  ctx.effect(() => () => { try { opened?.close(); } catch { /* already closed */ } opened = null; }, 'bot-issue: database');
}
