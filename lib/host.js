/**
 * Host half of the issue board (事务模块).
 *
 * A sibling plugin to dsh-plugin-bot-knowledge, not nested inside it: this one
 * owns the writable issue store, the HTTP route the browser half calls, and the
 * model-facing `issue_*` tools the main Bot uses. It never touches the knowledge
 * database.
 *
 * The tools are registered DIRECTLY against `ctx.tools.register` with raw
 * JSON-Schema `parameters` + `output.render`, deliberately without importing
 * `@deepseek-ai/dsh-tools`. dscord's resolve-hook only remaps `@deepseek-ai/*`
 * for dscord's own package root, so a `link:` plugin's own import of dsh-tools
 * fails at boot (`ERR_MODULE_NOT_FOUND`). `defineTool` only compiles the field
 * spec into that same JSON Schema and wraps `execute` in arg validation; we
 * author the schema directly and let the store validate its inputs.
 */

import path from 'node:path';
import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { openIssueStore, STATUSES } from './store.js';
import { createIssueHandler } from './handler.js';
import { startWriteback } from './writeback.js';

export const name = 'bot-issue';
export const inject = ['connection'];

export function issuePaths(config = {}) {
  const home = process.env.DSH_HOME ? path.resolve(process.env.DSH_HOME) : path.join(homedir(), '.dsh');
  const botHome = path.join(home, 'bot');
  return {
    dbPath: config.dbPath || path.join(botHome, 'issue', 'issue.sqlite'),
    statePath: config.statePath || path.join(botHome, 'state.json'),
    nodesRoot: config.nodesRoot || path.join(home, 'dscord', 'web', 'nodes'),
    writebackIntervalMs: config.writebackIntervalMs || 15_000,
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
const statusEnum = [...STATUSES];

export function apply(ctx, config = {}) {
  const { dbPath, statePath, nodesRoot, writebackIntervalMs } = issuePaths(config);
  let opened = null;
  const store = () => {
    if (!opened) opened = openIssueStore({ dbPath });
    return opened;
  };
  const mainBot = resolveMainBot(statePath);
  let sessionController = null;
  ctx.inject(['sessionController'], sc => { sessionController = sc.sessionController; });

  // 「启动」＝把活交给主 Bot：主 Bot 接活即进入「进行中」，不等 worker 真的起来。
  const start = async (issue) => {
    if (!mainBot?.sessionId) return { dispatched: false, reason: '找不到主 Bot 会话（检查 state.json 的 mainBotIds）' };
    if (typeof sessionController?.prompt !== 'function') return { dispatched: false, reason: '宿主未提供 sessionController' };
    if (issue.status === 'dispatched' || store().activeDispatch(issue.id)) return { dispatched: false, reason: '该 issue 已在处理中，不能重复启动' };
    const text = [
      `请接活并派工：事务 ${issue.id}「${issue.title}」现在交给你。`,
      '调用 dispatch_work 派一个工作者：issueId 填上面的 id，title 用事务标题，brief 写完整、自足的任务说明（把下面的正文作为依据，写清要做什么、做到什么程度），audience 按事务正文的要求写。',
      '如果实在无法派工（没有可用 worker / 缺信息等），先用 issue_comment 说明原因，再用 issue_update 把状态改回 open，不要让它停在「进行中」。',
      '--- 事务正文 ---',
      issue.body || '（无正文）',
    ].join('\n');
    try {
      await sessionController.prompt(
        { requestId: randomUUID(), sessionId: mainBot.sessionId, mode: 'queue', content: [{ type: 'text', text }] },
        AbortSignal.timeout(30_000),
      );
    } catch (error) {
      return { dispatched: false, reason: `通知主 Bot 失败：${error.message}` };
    }
    store().update(issue.id, { status: 'dispatched' }, { kind: 'system', name: 'dispatch' });
    return { dispatched: true, note: '已交给主 Bot（进行中），主 Bot 会派工给工作者，完成后自动写回「待验收」' };
  };

  const handle = createIssueHandler({ store, mainBot, start });

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
    const register = def => toolsCtx.tools.register(def);

    toolsCtx.effect(() => register({
      name: 'issue_create',
      description: '新建一个事务（issue）。每件事从一个 issue 出发：写清要做什么，之后可以评论讨论、派工给工作者，结果会闭环写回这里。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '一句话标题' },
          body: { type: 'string', description: '完整说明：背景、要做成什么、验收标准' },
          parentId: { type: 'string', description: '拆分子任务时，挂到父 issue 的 id 下' },
        },
        required: ['title'],
      },
      output: {
        schema: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string' } }, additionalProperties: false },
        render: (_args, value) => [{ type: 'text', text: `已创建 ${value.id}（${value.status}）` }],
      },
      async execute(args, exec) {
        const issue = store().create({ title: args.title, body: args.body, parentId: args.parentId, createdBy: 'agent', createdByName: caller(exec).name });
        return { id: issue.id, status: issue.status };
      },
    }), 'bot-issue: tool create');

    toolsCtx.effect(() => register({
      name: 'issue_list',
      description: '列出事务。可按状态或父 issue 过滤，返回简要信息；要看全文用 issue_get。',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: statusEnum, description: '只列这个状态' },
          parentId: { type: 'string', description: '只列挂在某个父 issue 下的子事务' },
        },
      },
      output: {
        schema: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, status: { type: 'string' } }, additionalProperties: false } },
        render: (_args, value) => [{ type: 'text', text: value.length ? value.map(t => `${t.status} ${t.id}  ${t.title}`).join('\n') : '（空）' }],
      },
      async execute(args) {
        return store().list({ status: args.status, parentId: args.parentId }).items.map(brief);
      },
    }), 'bot-issue: tool list');

    toolsCtx.effect(() => register({
      name: 'issue_get',
      description: '读一个事务的全文：标题、正文、状态、结果、评论时间线和派工记录。返回的 version 用于 issue_update 的安全写入。',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'issue id' } },
        required: ['id'],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: `${value.title} [${value.status}] v${value.version}\n\n${value.body || ''}` }],
      },
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
        type: 'object',
        properties: {
          id: { type: 'string', description: 'issue id' },
          status: { type: 'string', enum: statusEnum, description: '目标状态' },
          result: { type: 'string', description: '闭环结果说明（done 时写）' },
          title: { type: 'string' },
          body: { type: 'string' },
          expectedVersion: { type: 'integer', description: 'issue_get 读到的 version，不一致会拒绝写入' },
        },
        required: ['id'],
      },
      output: {
        schema: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string' }, version: { type: 'integer' } }, additionalProperties: false },
        render: (_args, value) => [{ type: 'text', text: `${value.id} → ${value.status} (v${value.version})` }],
      },
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
        type: 'object',
        properties: {
          id: { type: 'string', description: 'issue id' },
          body: { type: 'string', description: '评论内容' },
        },
        required: ['id', 'body'],
      },
      output: {
        schema: { type: 'object', properties: { id: { type: 'integer' } }, additionalProperties: false },
        render: () => [{ type: 'text', text: '评论已添加。' }],
      },
      async execute(args, exec) {
        if (!String(args.body || '').trim()) throw new Error('评论不能为空');
        const value = store().comment(args.id, { body: args.body, authorKind: 'agent', authorName: caller(exec).name });
        return { id: value.id };
      },
    }), 'bot-issue: tool comment');
  });

  // Dispatched issues close themselves: sweep the dscord node ledger without
  // waiting for the Bot's next turn.
  ctx.effect(() => {
    const handle = startWriteback({ store, nodesRoot, intervalMs: writebackIntervalMs });
    return () => handle.stop();
  }, 'bot-issue: writeback');

  ctx.effect(() => () => { try { opened?.close(); } catch { /* already closed */ } opened = null; }, 'bot-issue: database');
}
