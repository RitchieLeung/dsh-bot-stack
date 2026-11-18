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
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { openIssueStore, STATUSES, STATUS_LABELS } from './store.js';
import { createIssueHandler } from './handler.js';
import { startWriteback } from './writeback.js';
import { imageTask } from './routing.js';
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
    stagingDir: config.stagingDir || path.join(botHome, 'workspace', 'issue-attachments'),
    writebackIntervalMs: config.writebackIntervalMs || 15_000,
  };
}

// ── 事务图片：本地文件 → 附件 + markdown ──────────────────────────────────────
//
// Bot 自己截图（Playwright 等）后把文件路径交给工具，这里读文件、走 store 现成的
// addAttachment（mime 白名单 / 10MB 上限 / sha256 去重都在那），返回可直接写进
// 正文的 markdown。设计见 docs/2026-11-18-issue-images-design.md。

const IMAGE_EXT_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

export const MAX_IMAGES_PER_CALL = 8;

/** `store.js` 的 failure 没有导出，这里要自己的。 */
function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** 按扩展名判断图片 mime；不认识的返回 null。 */
export function imageMimeFor(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  return IMAGE_EXT_MIME[ext] || null;
}

/**
 * 把本地图片存成事务附件，返回 markdown 片段。
 *
 * 路径必须是绝对路径或 `~` 开头——不同 Bot 的 cwd 不一样，按 cwd 猜是坑。
 */
export function attachImages({ store, issueId, images = [] }) {
  const list = Array.isArray(images) ? images.filter(item => typeof item === 'string' && item.trim()) : [];
  if (list.length === 0) return { markdown: '', attachments: [] };
  if (list.length > MAX_IMAGES_PER_CALL) {
    throw failure('TOO_MANY_IMAGES', `一次最多 ${MAX_IMAGES_PER_CALL} 张图片，这次给了 ${list.length} 张`);
  }

  const attachments = [];
  const marks = [];
  for (const raw of list) {
    const given = raw.trim();
    const expanded = given === '~' || given.startsWith('~/') ? path.join(homedir(), given.slice(1)) : given;
    if (!path.isAbsolute(expanded)) {
      throw failure('RELATIVE_PATH', `${given} 不是绝对路径，请给绝对路径（如 /tmp/shot.png）`);
    }
    const mime = imageMimeFor(expanded);
    if (!mime) {
      throw failure('UNSUPPORTED_IMAGE', `${expanded} 不是支持的图片格式（png/jpg/jpeg/gif/webp/svg）`);
    }
    let buffer;
    try {
      buffer = readFileSync(expanded);
    } catch (error) {
      if (error.code === 'ENOENT') throw failure('IMAGE_NOT_FOUND', `找不到文件：${expanded}`);
      throw failure('IMAGE_UNREADABLE', `读不了文件：${expanded}（${error.message}）`);
    }
    if (!buffer.length) throw failure('EMPTY_IMAGE', `文件是空的：${expanded}`);

    const name = path.basename(expanded);
    const saved = store().addAttachment({ issueId, name, mime, data: buffer.toString('base64') });
    const safeName = saved.name || name;
    attachments.push({ id: saved.id, url: saved.url, name: safeName });
    marks.push(`![${safeName}](${saved.url})`);
  }
  return { markdown: marks.join('\n'), attachments };
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
        workDir: typeof bot.workDir === 'string' && bot.workDir ? bot.workDir : null,
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
  const { dbPath, statePath, nodesRoot, stagingDir, writebackIntervalMs } = issuePaths(config);
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
  // 内置「事务规则」skill：全队成员共用一份工作流规则（硬规则由上面代码兜底）。
  let skillsWired = false;
  ctx.inject(['skills'], skillsCtx => {
    const dispose = skillsCtx.skills.registerProvider(() => issueWorkflowProvider());
    skillsWired = true;
    return () => { try { dispose?.(); } catch { /* already gone */ } };
  });
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

  // 事务有更新时知会对侧：执行人动作 → 知会主 Bot；主 Bot/人动作 → 知会执行人；
  // 没有执行人（老事务/未派工）→ 知会主 Bot 来处理（重新派工）。
  // 同一个 Bot 的会话 id 可能不止一个（bot.id / sessionId / 各段），用名字判同一只 Bot，避免
  // 「执行人报回来自动知会主 Bot」因会话 id 漂移而失效。
  const sameBot = (a, b) => {
    if (!a || !b) return false;
    if (a === b) return true;
    const na = nameOf(a);
    return !!na && na === nameOf(b);
  };
  const notifyCounterpart = (issue, bySessionId, summary) => {
    if (typeof sessionController?.prompt !== 'function') return;
    const label = issue.number ? `#${issue.number}` : issue.id;
    const assigneeSid = issue?.assignee?.sessionId;
    let target;
    if (assigneeSid) {
      if (bySessionId && sameBot(bySessionId, assigneeSid)) target = { sessionId: mainBot?.sessionId, name: '主 Bot' };
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
    // 也没有在途任务）允许「重派」。
    if (store().activeDispatch(issue.id)) return { dispatched: false, reason: '该 issue 有进行中的工作者任务，不能重复启动' };
    if (issue.status === 'dispatched' && issue.assignee) {
      return { dispatched: false, reason: `已有执行人（${issue.assignee.name || issue.assignee.sessionId}），要改派请先换执行人` };
    }

    const needVision = imageTask(issue.body);
    const roster = botRoster(statePath).filter(bot => bot.id !== mainBot.id && bot.sessionId);
    if (roster.length === 0) return { dispatched: false, reason: '本机没有可派的同事（state.json 里没有其它 bot）' };
    const loads = store().loads();
    const loadTable = roster.map(bot => `   - ${bot.name}：在办 ${loads[bot.sessionId] || 0} 条`).join('\n');

    // 附件放进共享工作区，给出绝对路径：worker 只能靠 read_image 读文件，不能只看 URL。
    const issueStagingDir = path.join(stagingDir, String(issue.number || issue.id));
    const attachments = [];
    try {
      for (const hit of String(issue.body || '').matchAll(/\/api\/bot-issue\?attachment=([0-9a-f]+)/g)) {
        const file = store().getAttachment(hit[1]);
        if (!file?.filePath) continue;
        try {
          mkdirSync(issueStagingDir, { recursive: true });
          const dest = path.join(issueStagingDir, path.basename(file.name || file.id));
          copyFileSync(file.filePath, dest);
          attachments.push({ name: file.name || hit[1], path: dest });
        } catch {
          attachments.push({ name: file.name || hit[1], path: file.filePath });
        }
      }
    } catch { /* best effort */ }

    const text = [
      `【事务派工】事务 ${issue.id}「${issue.title}」需要你来派工。**执行人由你自己（主 Bot）定**，按「专才 + 负载 + 能不能看图」挑一位同事——不是你被指定。`,
      '步骤：',
      '1. 用 list_bots 看同事；用 list_bot_models 看谁的模型标着 "reads images"（能看图）。',
      '2. 本机同事当前在办（负载，越少越好）：',
      loadTable,
      needVision
        ? '3. ⚠️ 这条事务带图片：**必须挑能看图的同事**（list_bot_models 里 "reads images" 的）。挑错了它看不到图，会闭环回来找你重派。'
        : '3. 按事务内容挑最合适的（专才优先、负载低的优先）。',
      `4. 用 message_bot 把任务交给它（reply_to 默认 me，when 现在）。message 要自包含（对方看不到这里），写明：事务 ${issue.id}：${issue.title}；任务说明（见下方正文）；做完用 issue_comment 写结果 + issue_update 推进到 in_review；做不了/看不到图就 issue_comment 说明 + message_bot 找你，不要标待验收假装完成。`,
      attachments.length
        ? `5. 附件已放到共享工作区，把这几个本地路径写进 message（对方用 read_image 读路径才能看到图，只看 /api/... URL 看不到）：\n${attachments.map(a => `   - ${a.path}（${a.name}）`).join('\n')}`
        : null,
      '6. 用 issue_assign 记录执行人：issue_assign(事务 id, 对方名字)。',
      '7. 如果对方做不了/看不到图，它会闭环回来找你 → 你改派（issue_assign 换人）或拆子事务（issue_create 带 parentId）再派。',
      '注意：不要用 dispatch_work / subagent / product_delegate —— 那些是你自己的下属，不是同事。',
      '回复用户时，说「我按专才+负载挑了 X」，不要说「你指定的」——是你自己挑的。',
      '--- 事务正文 ---',
      issue.body || '（无正文）',
    ].filter(line => line !== null).join('\n');

    try {
      await sessionController.prompt(
        { requestId: randomUUID(), sessionId: mainBot.sessionId, mode: 'queue', content: [{ type: 'text', text }] },
        AbortSignal.timeout(30_000),
      );
    } catch (error) {
      return { dispatched: false, reason: `通知主 Bot 失败：${error.message}` };
    }
    // 执行人由主 Bot 用 issue_assign 记录（它自己挑的人）；这里只把事务标为进行中。
    store().update(issue.id, { status: 'dispatched' }, { kind: 'system', name: '' });
    return { dispatched: true, note: '已交给主 Bot：它会按专才+负载自己挑人、message_bot 派活，并用 issue_assign 记录执行人' };
  };


  // 工具注册结果：ping 里能看到「这个 entry 现在带没带上工具」，出问题不用翻日志。
  let toolsReport = { registered: [], failed: [], at: null };
  const diagnostics = () => ({
    module: fileURLToPath(import.meta.url), pid: process.pid, tools: toolsReport,
    wired: { skills: skillsWired },
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
      name: 'issue_assign',
      description: '把事务指派/改派给某位同事（只有主 Bot 能做）。派工时用它记录执行人：先 list_bots 挑人，再 issue_assign(事务 id, 同事名字)。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'issue id 或 #编号（如 #12）' },
          bot: { type: 'string', description: '同事名字（list_bots 返回的）或它的会话 id' },
        },
        required: ['id', 'bot'],
      },
      output: {
        schema: { type: 'object', properties: { id: { type: 'string' }, assignee: { type: 'string' } }, additionalProperties: false },
        render: (_args, value) => [{ type: 'text', text: `${value.id} → 执行人 ${value.assignee}` }],
      },
      async execute(args, exec) {
        const actor = caller(exec, nameOf, isMainOf);
        const bot = botRoster(statePath).find(b => b.name === args.bot || b.id === args.bot || b.sessionId === args.bot);
        if (!bot?.sessionId) throw new Error(`找不到同事：${args.bot}（先用 list_bots 看看有哪些同事）`);
        const issue = store().assign(args.id, { sessionId: bot.sessionId, name: bot.name }, actor);
        return { id: issue.id, assignee: bot.name };
      },
    }), 'bot-issue: tool assign');

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






