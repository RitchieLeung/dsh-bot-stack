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
import { openIssueStore, STATUSES, STATUS_LABELS } from './store.js';
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

/** session id → bot name, so a comment shows who actually wrote it (not "主 Bot"/"worker"). */
export function botNamesOf(statePath) {
  const map = new Map();
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
    const bots = parsed?.bots && typeof parsed.bots === 'object' ? Object.values(parsed.bots) : [];
    for (const bot of bots) {
      if (!bot || typeof bot.id !== 'string') continue;
      const name = typeof bot.name === 'string' && bot.name.trim() ? bot.name : bot.id;
      map.set(bot.id, name);
      if (typeof bot.sessionId === 'string') map.set(bot.sessionId, name);
      if (Array.isArray(bot.segments)) {
        for (const seg of bot.segments) if (seg && typeof seg.sessionId === 'string') map.set(seg.sessionId, name);
      }
    }
  } catch { /* no directory yet */ }
  return map;
}

/** The Bots on this host as { id, name, sessionId }, for resolving @mentions. */
export function botRoster(statePath) {
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
    const bots = parsed?.bots && typeof parsed.bots === 'object' ? Object.values(parsed.bots) : [];
    return bots
      .filter(bot => bot && typeof bot.id === 'string')
      .map(bot => ({
        id: bot.id,
        name: typeof bot.name === 'string' && bot.name.trim() ? bot.name : bot.id,
        sessionId: typeof bot.sessionId === 'string' ? bot.sessionId : null,
      }));
  } catch {
    return [];
  }
}

/** Who a tool call is attributed to: an agent session (by Bot name) or the local user. */
function caller(exec, nameOf) {
  const agent = exec?.agent;
  if (agent) {
    const sid = agent.session?.id || agent.id || '';
    return { kind: 'agent', name: (nameOf && nameOf(sid)) || agent.session?.title || agent.name || 'Bot', id: sid };
  }
  return { kind: 'user', name: '用户', id: '' };
}

const brief = issue => ({ id: issue.id, number: issue.number, title: issue.title, status: issue.status, parentId: issue.parentId, updatedAt: issue.updatedAt });
const statusEnum = [...STATUSES];
/** `open=待处理、discussing=讨论中…`：给模型看的枚举，人话名字从 store 来，不重复维护。 */
const statusGloss = STATUSES.map(status => `${status}=${STATUS_LABELS[status]}`).join('、');

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
  const nameOf = sid => botNamesOf(statePath).get(sid) || null;

  // 事务评论里的 @同事 → 直接 prompt 那位同事的前台会话，等于「at 到了」。
  const notifyMentions = (issue, body, commenterSessionId = null) => {
    if (typeof body !== 'string' || !body.includes('@') || typeof sessionController?.prompt !== 'function') return;
    const label = issue.number ? `#${issue.number}` : issue.id;
    const roster = botRoster(statePath).filter(bot => bot.sessionId).sort((a, b) => b.name.length - a.name.length);
    const seen = new Set();
    for (const bot of roster) {
      if (!body.includes(`@${bot.name}`)) continue;
      if (bot.sessionId === commenterSessionId) continue;
      if (seen.has(bot.sessionId)) continue;
      seen.add(bot.sessionId);
      const text = `你在事务 ${label}「${issue.title}」的评论里被 @ 了。\n评论内容：\n${body}\n\n需要的话用 issue_get 读 ${label}，再用 issue_comment 回复。`;
      try {
        sessionController.prompt(
          { requestId: randomUUID(), sessionId: bot.sessionId, mode: 'queue', content: [{ type: 'text', text }] },
          AbortSignal.timeout(30_000),
        ).catch(() => {});
      } catch { /* best effort */ }
    }
  };

  // 「启动」＝把活交给主 Bot，由主 Bot 挑一位**同事**经办并落到对方手上。
  // 注意：同事要走 dscord 的 message_bot（bot 对 bot），不是 dispatch_work/subagent
  // ——后者是这个 bot 自己的工作者/子 agent，不是同事。
  const start = async (issue) => {
    if (!mainBot?.sessionId) return { dispatched: false, reason: '找不到主 Bot 会话（检查 state.json 的 mainBotIds）' };
    if (typeof sessionController?.prompt !== 'function') return { dispatched: false, reason: '宿主未提供 sessionController' };
    if (issue.status === 'dispatched' || store().activeDispatch(issue.id)) return { dispatched: false, reason: '该 issue 已在处理中，不能重复启动' };
    const text = [
      `请为事务 ${issue.id}「${issue.title}」派活给最合适的同事，不要派给你自己的子 agent 或工作者。`,
      '步骤：',
      '1. 先用 list_bots 看团队里有哪些同事。',
      '2. 按事务内容挑最合适的一位（前端归玉清、后端归尚锦、实施归伟峰、思路/协调归 kiki；名字以 list_bots 返回为准）。',
      '3. 用 message_bot 把事务交给这位同事（reply_to 用默认 me，when 用现在）。message 要自包含（对方看不到这里），至少写明：',
      `   - 事务 ${issue.id}：${issue.title}`,
      '   - 任务说明（见下方「事务正文」）',
      `   - 「你做完后请用 issue_comment 把结果/结论写成评论，再用 issue_update 把 ${issue.id} 的状态改成 in_review（待验收）；你是这个事务的经办人（闭环者），结果以你写回为准。」`,
      '注意：不要用 dispatch_work / subagent / product_delegate —— 那些是你自己的下属，不是同事；这个事务要落到同事手上。',
      '如果事务信息不足、或判断不出去交给谁，先用 issue_comment 说明原因，再用 issue_update 把状态改回 open，不要让它停在「进行中」。',
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
    store().update(issue.id, { status: 'dispatched' }, { kind: 'system', name: '' });
    return { dispatched: true, note: '已交给主 Bot（进行中），主 Bot 会把事务派给同事，完成后由经办同事写回「待验收」' };
  };

  const handle = createIssueHandler({ store, mainBot, start, notify: (issue, comment, commenterSessionId) => notifyMentions(issue, comment.body, commenterSessionId), rosterOf: () => botRoster(statePath) });

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
          type: { type: 'string', description: '事务类型，随意自定义（bug / feature / 优化 / 调研 …）' },
        },
        required: ['title'],
      },
      output: {
        schema: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string' } }, additionalProperties: false },
        render: (_args, value) => [{ type: 'text', text: `已创建 ${value.id}（${value.status}）` }],
      },
      async execute(args, exec) {
        const issue = store().create({ title: args.title, body: args.body, parentId: args.parentId, type: args.type, createdBy: 'agent', createdByName: caller(exec, nameOf).name });
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
          type: { type: 'string', description: '只列这个类型（bug / feature …）' },
        },
      },
      output: {
        schema: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, number: { type: 'integer' }, title: { type: 'string' }, status: { type: 'string' } }, additionalProperties: false } },
        render: (_args, value) => [{ type: 'text', text: value.length ? value.map(t => `#${t.number ?? '?'} ${t.status} ${t.id}  ${t.title}`).join('\n') : '（空）' }],
      },
      async execute(args) {
        return store().list({ status: args.status, parentId: args.parentId, type: args.type }).items.map(brief);
      },
    }), 'bot-issue: tool list');

    toolsCtx.effect(() => register({
      name: 'issue_get',
      description: '读一个事务的全文：标题、正文、状态、类型、结果、评论时间线和派工记录。返回的 version 用于 issue_update 的安全写入。id 可以是内部 id，也可以是 #编号（如 #12）。',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'issue id 或 #编号（如 #12）' } },
        required: ['id'],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: `#${value.number ?? '?'} ${value.title} [${value.status}] v${value.version}\n\n${value.body || ''}` }],
      },
      async execute(args) {
        const issue = store().get(args.id);
        return {
          id: issue.id, number: issue.number, title: issue.title, body: issue.body, status: issue.status, type: issue.type, version: issue.version,
          result: issue.result, createdByName: issue.createdByName, createdAt: issue.createdAt, updatedAt: issue.updatedAt,
          comments: issue.comments.map(c => `${c.authorName || c.authorKind}: ${c.body}`),
          dispatches: issue.dispatches.map(d => `${d.taskId} (${d.status})`),
        };
      },
    }), 'bot-issue: tool get');

    toolsCtx.effect(() => register({
      name: 'issue_update',
      description: `更新事务：改状态、写结果、改标题或正文。改状态要遵守流转规则（${statusGloss}）；传 expectedVersion 可避免覆盖别人的改动。`,
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'issue id 或 #编号（如 #12）' },
          status: { type: 'string', enum: statusEnum, description: `目标状态（${statusGloss}）` },
          result: { type: 'string', description: '闭环结果说明（done 时写）' },
          title: { type: 'string' },
          body: { type: 'string' },
          type: { type: 'string', description: '事务类型（bug / feature …）' },
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
          status: args.status, result: args.result, title: args.title, body: args.body, type: args.type,
          expectedVersion: typeof args.expectedVersion === 'number' ? args.expectedVersion : undefined,
        }, caller(exec, nameOf));
        return { id: issue.id, status: issue.status, version: issue.version };
      },
    }), 'bot-issue: tool update');

    toolsCtx.effect(() => register({
      name: 'issue_comment',
      description: '给事务追加一条评论（发现、结论、交接说明等），同时会出现在时间线里。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'issue id 或 #编号（如 #12）' },
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
        const value = store().comment(args.id, { body: args.body, authorKind: 'agent', authorName: caller(exec, nameOf).name });
        try { notifyMentions(store().get(args.id), args.body, exec.agent?.session?.id); } catch { /* best effort */ }
        return { id: value.id };
      },
    }), 'bot-issue: tool comment');
  });

  // Dispatched issues close themselves: sweep the dscord node ledger without
  // waiting for the Bot's next turn.
  ctx.effect(() => {
    const handle = startWriteback({ store, nodesRoot, intervalMs: writebackIntervalMs, workerNameOf: nameOf });
    return () => handle.stop();
  }, 'bot-issue: writeback');

  ctx.effect(() => () => { try { opened?.close(); } catch { /* already closed */ } opened = null; }, 'bot-issue: database');
}
