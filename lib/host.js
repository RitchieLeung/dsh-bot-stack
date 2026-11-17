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
import { readFile } from 'node:fs/promises';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { openIssueStore, STATUSES, STATUS_LABELS } from './store.js';
import { createIssueHandler } from './handler.js';
import { startWriteback } from './writeback.js';
import { imageTask, chooseAssignee, specialtyScore } from './routing.js';
import { issueWorkflowProvider } from './skill.js';

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
    const sessionIds = new Set([id]);
    if (typeof bot.sessionId === 'string') sessionIds.add(bot.sessionId);
    if (Array.isArray(bot.segments)) {
      for (const seg of bot.segments) if (seg && typeof seg.sessionId === 'string') sessionIds.add(seg.sessionId);
    }
    return { id, name: typeof bot.name === 'string' && bot.name.trim() ? bot.name : id, sessionId: typeof bot.sessionId === 'string' ? bot.sessionId : null, sessionIds };
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

/** The Bots on this host with their model/role/instructions, for capability routing. */
export function botProfiles(statePath) {
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
    const bots = parsed?.bots && typeof parsed.bots === 'object' ? Object.values(parsed.bots) : [];
    return bots
      .filter(bot => bot && typeof bot.id === 'string')
      .map(bot => ({
        id: bot.id,
        name: typeof bot.name === 'string' && bot.name.trim() ? bot.name : bot.id,
        sessionId: typeof bot.sessionId === 'string' ? bot.sessionId : null,
        model: typeof bot.appliedModel === 'string' ? bot.appliedModel : (typeof bot.model === 'string' ? bot.model : null),
        role: typeof bot.role === 'string' ? bot.role : '',
        instructions: typeof bot.instructions === 'string' ? bot.instructions : '',
      }));
  } catch {
    return [];
  }
}

/** Who a tool call is attributed to: an agent session (by Bot name) or the local user. */
function caller(exec, nameOf, isMainOf) {
  const agent = exec?.agent;
  if (agent) {
    const sid = agent.session?.id || agent.id || '';
    return {
      kind: 'agent',
      name: (nameOf && nameOf(sid)) || agent.session?.title || agent.name || 'Bot',
      id: sid,
      isMain: typeof isMainOf === 'function' && isMainOf(sid),
    };
  }
  return { kind: 'user', name: '用户', id: '', isMain: true };
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
  // 部署可见性：把「这个 entry 现在跑的是哪份代码、哪个进程」写到文件里。
  // 换代码后 sync/急救台读它就能确认到底有没有真的重载（否则只能靠猜）。
  try {
    const healthPath = path.join(path.dirname(dbPath), 'health.json');
    mkdirSync(path.dirname(healthPath), { recursive: true });
    writeFileSync(healthPath, `${JSON.stringify({ at: Date.now(), pid: process.pid, module: fileURLToPath(import.meta.url) }, null, 2)}\n`);
  } catch { /* health file is best effort */ }

  const mainBot = resolveMainBot(statePath);
  const mainBotSessionIds = mainBot?.sessionIds ?? new Set();
  const isMainOf = sid => typeof sid === 'string' && mainBotSessionIds.has(sid);
  let sessionController = null;
  ctx.inject(['sessionController'], sc => { sessionController = sc.sessionController; });
  let llm = null;
  ctx.inject(['llm'], sub => { llm = sub.llm; });
  // 内置「事务规则」skill：全队成员共用一份工作流规则（硬规则由上面代码兜底）。
  let skillsWired = false;
  ctx.inject(['skills'], skillsCtx => {
    const dispose = skillsCtx.skills.registerProvider(() => issueWorkflowProvider());
    skillsWired = true;
    return () => { try { dispose?.(); } catch { /* already gone */ } };
  });
  const nameOf = sid => botNamesOf(statePath).get(sid) || null;

  // 模型能力（能不能看图）现查 runtime 模型目录，不写死。TTL 缓存避免每次派工都打一堆适配器调用。
  const visionCache = new Map();
  async function visionOf(ref) {
    if (typeof ref !== 'string' || !ref.includes('/')) return false;
    const hit = visionCache.get(ref);
    if (hit && Date.now() - hit.at < 10_000) return hit.value;
    let value = false;
    try {
      const cut = ref.indexOf('/');
      const provider = ref.slice(0, cut);
      const model = ref.slice(cut + 1);
      const info = await llm.resolveModelInfo(provider, model);
      value = Array.isArray(info?.inputModalities) && info.inputModalities.includes('image');
    } catch {
      value = false; // adapter 失败/字段缺省 = unknown → 按不能看图（保守）
    }
    visionCache.set(ref, { at: Date.now(), value });
    return value;
  }

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

  // 事务有更新时知会对侧：执行人动作 → 知会主 Bot；主 Bot/人动作 → 知会执行人；
  // 没有执行人（老事务/未派工）→ 知会主 Bot 来处理（重新派工）。
  const notifyCounterpart = (issue, bySessionId, summary) => {
    if (typeof sessionController?.prompt !== 'function') return;
    const label = issue.number ? `#${issue.number}` : issue.id;
    const assigneeSid = issue?.assignee?.sessionId;
    let target;
    if (assigneeSid) {
      if (bySessionId && bySessionId === assigneeSid) target = { sessionId: mainBot?.sessionId, name: '主 Bot' };
      else if (!bySessionId || isMainOf(bySessionId)) target = { sessionId: assigneeSid, name: issue.assignee.name || assigneeSid };
      else return; // 既不是执行人也不是主 Bot 的第三位，不打扰对侧
    } else {
      // 没有执行人：主 Bot 自己动的手就不必再通知自己，其它情况让主 Bot 接手。
      if (!bySessionId || !isMainOf(bySessionId)) target = { sessionId: mainBot?.sessionId, name: '主 Bot' };
    }
    if (!target?.sessionId) return;
    const text = `事务 ${label}「${issue.title}」有更新：${summary}\n请用 issue_get 读 ${label}，再按事务规则跟进${assigneeSid ? '' : '（这条还没有执行人，需要你来派工/接手）'}。`;
    try {
      sessionController.prompt(
        { requestId: randomUUID(), sessionId: target.sessionId, mode: 'queue', content: [{ type: 'text', text }] },
        AbortSignal.timeout(30_000),
      ).catch(() => {});
    } catch { /* best effort */ }
  };

  // 「启动」＝由 host 做确定性选人（能力 + 负载），定下执行人并落库；主 Bot 只负责
  // 写任务说明 + message_bot 给被点名的人。
  const start = async (issue) => {
    if (!mainBot?.sessionId) return { dispatched: false, reason: '找不到主 Bot 会话（检查 state.json 的 mainBotIds）' };
    if (typeof sessionController?.prompt !== 'function') return { dispatched: false, reason: '宿主未提供 sessionController' };
    // 有进行中的工作者任务，或已派给执行人：不重复启动。老事务（dispatched 但没执行人、
    // 也没有在途任务）允许「重派」，把活儿重新落到正确的人手上。
    if (store().activeDispatch(issue.id)) return { dispatched: false, reason: '该 issue 有进行中的工作者任务，不能重复启动' };
    if (issue.status === 'dispatched' && issue.assignee) {
      return { dispatched: false, reason: `已有执行人（${issue.assignee.name || issue.assignee.sessionId}），要改派请先换执行人` };
    }
    if (typeof llm?.resolveModelInfo !== 'function') return { dispatched: false, reason: '宿主未提供模型能力（llm），无法做能力路由' };

    const needVision = imageTask(issue.body);
    const profiles = botProfiles(statePath).filter(bot => bot.id !== mainBot.id && bot.sessionId);
    if (profiles.length === 0) return { dispatched: false, reason: '本机没有可派的同事（state.json 里没有其它 bot）' };
    const loads = store().loads();
    const candidates = [];
    for (const bot of profiles) {
      candidates.push({
        sessionId: bot.sessionId,
        name: bot.name,
        vision: await visionOf(bot.model),
        load: loads[bot.sessionId] || 0,
        specialty: specialtyScore({ role: bot.role, instructions: bot.instructions }, { tags: issue.tags || [], body: issue.body }),
      });
    }
    const chosen = chooseAssignee({ candidates, needVision });
    if (!chosen.assignee) return { dispatched: false, reason: chosen.reason };

    const text = [
      `请把事务 ${issue.id}「${issue.title}」交给同事 ${chosen.assignee.name}（已按能力/负载选定，你只需写说明并发送，不要再另挑人）。`,
      '步骤：',
      `1. 用 message_bot 把事务交给 ${chosen.assignee.name}（reply_to 用默认 me，when 用现在）。message 要自包含（对方看不到这里），至少写明：`,
      `   - 事务 ${issue.id}：${issue.title}`,
      '   - 任务说明（见下方「事务正文」）',
      `   - 「你做完后请用 issue_comment 把结果/结论写成评论，再用 issue_update 把 ${issue.id} 的状态改成 in_review（待验收）；你是这个事务的经办人（闭环者），结果以你写回为准。做不了/要改派/要拆任务，用 message_bot 找我。」`,
      '注意：不要用 dispatch_work / subagent / product_delegate —— 那些是你自己的下属，不是同事；这个事务要落到同事手上。',
      '如果你在前台看不到 issue_* 工具、调用时报 unknown tool：直接在群里说明「事务工具当前不可用」并停下，等修好再领，不要用 dispatch_work 装样子。',
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
    store().assign(issue.id, { sessionId: chosen.assignee.sessionId, name: chosen.assignee.name }, { kind: 'agent', name: mainBot.name, isMain: true });
    store().update(issue.id, { status: 'dispatched' }, { kind: 'system', name: '' });
    return {
      dispatched: true,
      note: `已派给 ${chosen.assignee.name}${needVision ? '（能看图）' : ''}，主 Bot 正在发送任务说明`,
      assignee: { sessionId: chosen.assignee.sessionId, name: chosen.assignee.name },
    };
  };

  // 工具注册结果：ping 里能看到「这个 entry 现在带没带上工具」，出问题不用翻日志。
  let toolsReport = { registered: [], failed: [], at: null };
  const diagnostics = () => ({
    module: fileURLToPath(import.meta.url), pid: process.pid, tools: toolsReport,
    wired: { llm: typeof llm?.resolveModelInfo === 'function', skills: skillsWired },
  });

  const handle = createIssueHandler({
    store, mainBot, start, diagnostics,
    notify: (issue, comment, commenterSessionId) => {
      try { notifyMentions(issue, comment?.body, commenterSessionId); } catch { /* best effort */ }
      // 状态变更总是知会对侧（无执行人时知会主 Bot 接手）；评论只在有执行人时知会对侧，避免刷屏。
      if (comment?.statusChange || issue?.assignee) {
        try { notifyCounterpart(issue, commenterSessionId, comment?.body || '有更新'); } catch { /* best effort */ }
      }
    },
    rosterOf: () => botRoster(statePath),
  });

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/bot-issue',
    // POST = JSON 动作；GET = 出图片字节（?attachment=<id>），<img src> 用的就是它。
    methods: ['POST', 'GET'],
    requestBody: 'buffered',
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === 'GET') {
        const id = url.searchParams.get('attachment');
        if (!id) return new Response('missing attachment id', { status: 400 });
        const file = store().getAttachment(id);
        if (!file) return new Response('not found', { status: 404 });
        try {
          const bytes = await readFile(file.filePath);
          return new Response(bytes, {
            headers: {
              'Content-Type': file.mime,
              'Content-Length': String(bytes.byteLength),
              'Cache-Control': 'private, max-age=31536000, immutable',
              'Content-Disposition': `inline; filename="${encodeURIComponent(file.name || file.id)}"`,
            },
          });
        } catch {
          return new Response('not found', { status: 404 });
        }
      }
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
    // 注册结果落盘（tools.json）：热重载时如果工具被「已注册」冲突挡掉，这里能看出来。
    const report = { at: Date.now(), pid: process.pid, registered: [], failed: [] };
    const reportPath = path.join(path.dirname(dbPath), 'tools.json');
    const flush = () => { try { writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`); } catch { /* best effort */ } };
    const register = def => {
      try {
        const dispose = toolsCtx.tools.register(def);
        report.registered.push(def.name);
        flush();
        return dispose;
      } catch (error) {
        report.failed.push({ name: def.name, error: String((error && error.message) || error) });
        flush();
        throw error;
      }
    };
    toolsReport = report;
    setTimeout(flush, 0);

    toolsCtx.effect(() => register({
      name: 'issue_create',
      description: '新建一个事务（issue）。每件事从一个 issue 出发：写清要做什么，之后可以评论讨论、派工给工作者，结果会闭环写回这里。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '一句话标题' },
          body: { type: 'string', description: '完整说明：背景、要做成什么、验收标准' },
          parentId: { type: 'string', description: '拆分子任务时，挂到父 issue 的 id 下' },
          tags: { type: 'array', items: { type: 'string' }, description: '事务标签，可多个（bug / feature / 优化 / 调研 …）；标签库里没有的会自动新建' },
          type: { type: 'string', description: '单个标签的旧写法，等价于 tags 只填一个' },
        },
        required: ['title'],
      },
      output: {
        schema: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string' } }, additionalProperties: false },
        render: (_args, value) => [{ type: 'text', text: `已创建 ${value.id}（${value.status}）` }],
      },
      async execute(args, exec) {
        const issue = store().create({
          title: args.title, body: args.body, parentId: args.parentId,
          tags: args.tags !== undefined ? args.tags : args.type,
          createdBy: 'agent', createdByName: caller(exec, nameOf, isMainOf).name,
        });
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
          type: { type: 'string', description: '只列带这个标签的事务（bug / feature …）' },
        },
      },
      output: {
        // brief() 的字段必须全在这里声明：additionalProperties: false 时少一个就整条工具调用失败。
        schema: {
          type: 'array',
          items: {
            type: 'object',
            // parentId 可能是 null，而 dsh 的 schema 校验不支持 type 数组（['string','null']
            // 会让整条工具注册失败）——所以它不在这里声明，靠 additionalProperties 放行。
            properties: {
              id: { type: 'string' }, number: { type: 'integer' }, title: { type: 'string' },
              status: { type: 'string' }, updatedAt: { type: 'integer' },
            },
            additionalProperties: true,
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.length ? value.map(t => `#${t.number ?? '?'} ${t.status} ${t.id}  ${t.title}`).join('\n') : '（空）' }],
      },
      async execute(args) {
        return store().list({ status: args.status, parentId: args.parentId, type: args.type }).items.map(brief);
      },
    }), 'bot-issue: tool list');

    toolsCtx.effect(() => register({
      name: 'issue_get',
      description: '读一个事务的全文：标题、正文、状态、标签、依赖、结果、评论时间线和派工记录。返回的 version 用于 issue_update 的安全写入。id 可以是内部 id，也可以是 #编号（如 #12）。',
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
          id: issue.id, number: issue.number, title: issue.title, body: issue.body, status: issue.status,
          type: issue.type, tags: issue.tags, version: issue.version,
          dependsOn: issue.dependsOn.map(dep => `#${dep.number} ${dep.status} ${dep.title}`),
          blocks: issue.blocks.map(dep => `#${dep.number} ${dep.status} ${dep.title}`),
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
          rejection: { type: 'string', description: '打回意见（把 in_review 打回 dispatched 时必填）' },
          title: { type: 'string' },
          body: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' }, description: '整组替换事务标签（传空数组=清空）；不传则不动' },
          type: { type: 'string', description: '单个标签的旧写法，等价于 tags 只填一个' },
          expectedVersion: { type: 'integer', description: 'issue_get 读到的 version，不一致会拒绝写入' },
        },
        required: ['id'],
      },
      output: {
        schema: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string' }, version: { type: 'integer' } }, additionalProperties: false },
        render: (_args, value) => [{ type: 'text', text: `${value.id} → ${value.status} (v${value.version})` }],
      },
      async execute(args, exec) {
        const actor = caller(exec, nameOf, isMainOf);
        const issue = store().update(args.id, {
          status: args.status, result: args.result, title: args.title, body: args.body,
          tags: args.tags, type: args.type,
          rejection: typeof args.rejection === 'string' ? args.rejection : undefined,
          expectedVersion: typeof args.expectedVersion === 'number' ? args.expectedVersion : undefined,
        }, actor);
        if (args.status !== undefined) {
          const summary = typeof args.rejection === 'string' && args.rejection.trim()
            ? `被打回重做：${args.rejection.trim()}`
            : `状态变为「${STATUS_LABELS[issue.status] || issue.status}」`;
          try { notifyCounterpart(issue, actor.id, summary); } catch { /* best effort */ }
        }
        return { id: issue.id, status: issue.status, version: issue.version };
      },
    }), 'bot-issue: tool update');

    toolsCtx.effect(() => register({
      name: 'issue_link',
      description: '给事务建依赖关系：A 依赖 B 表示「B 完成后 A 才能完成」。前置没闭环时 issue_update 把 A 改成 done 会被拒绝。不能依赖自己，也不能形成循环。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '依赖方（A）的 issue id 或 #编号' },
          dependsOn: { type: 'string', description: '前置（B）的 issue id 或 #编号' },
        },
        required: ['id', 'dependsOn'],
      },
      output: {
        schema: { type: 'object', properties: { id: { type: 'string' }, dependsOn: { type: 'array', items: { type: 'string' } } }, additionalProperties: false },
        render: (_args, value) => [{ type: 'text', text: `依赖已挂上，当前前置：${value.dependsOn.length ? value.dependsOn.join('、') : '（无）'}` }],
      },
      async execute(args) {
        const issue = store().link(args.id, args.dependsOn);
        return { id: issue.id, dependsOn: issue.dependsOn.map(dep => `#${dep.number} ${dep.title}`) };
      },
    }), 'bot-issue: tool link');

    toolsCtx.effect(() => register({
      name: 'issue_unlink',
      description: '解除事务依赖（A 不再依赖 B）。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '依赖方（A）的 issue id 或 #编号' },
          dependsOn: { type: 'string', description: '前置（B）的 issue id 或 #编号' },
        },
        required: ['id', 'dependsOn'],
      },
      output: {
        schema: { type: 'object', properties: { id: { type: 'string' } }, additionalProperties: false },
        render: () => [{ type: 'text', text: '依赖已解除。' }],
      },
      async execute(args) {
        const issue = store().unlink(args.id, args.dependsOn);
        return { id: issue.id };
      },
    }), 'bot-issue: tool unlink');

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
        const actor = caller(exec, nameOf, isMainOf);
        const value = store().comment(args.id, { body: args.body, authorKind: 'agent', authorName: actor.name });
        try { notifyMentions(store().get(args.id), args.body, exec.agent?.session?.id); } catch { /* best effort */ }
        try { notifyCounterpart(store().get(args.id), actor.id, '新增评论'); } catch { /* best effort */ }
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






