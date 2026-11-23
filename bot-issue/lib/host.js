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
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { ATTACHMENT_MAX_BYTES, canReplyComment, DEFAULT_PRIORITY, openIssueStore, PRIORITIES, PRIORITY_LABELS, STATUSES, STATUS_LABELS } from './store.js';
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

/** 时间戳 → 本地时间字符串（模型可见输出用，尽量短）。 */
function fmtTime(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '未知';
  try { return new Date(ms).toLocaleString('zh-CN', { hour12: false }); } catch { return '未知'; }
}

// ── 事务图片：本地文件 → 附件 + markdown ──────────────────────────────────────
//
// Bot 自己截图（Playwright 等）后把文件路径交给工具，这里读文件、走 store 现成的
// addAttachment（mime 白名单 / 10MB 上限 / sha256 去重都在那），返回可直接写进
// 正文的 markdown。设计见 docs/2026-11-18-issue-images-design.md。
//
// 两条硬规则：
// 1. 先校验、再落库。planImages() 不写任何东西，全部通过之后才 savePlannedImages()，
//    否则「3 张图第 2 张坏了」会留下半成品事务/孤儿附件。
// 2. 扩展名只是第一道门，还要嗅文件头（magic bytes）：`notes.txt` 改名成 `shot.png`
//    或者符号链接指过去，都得挡在 NOT_AN_IMAGE。

const IMAGE_EXT_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

const IMAGE_EXT_HINT = 'png/jpg/jpeg/gif/webp';

export const MAX_IMAGES_PER_CALL = 8;
/** issue_get 一次最多 stage 多少个附件，防止有人拿一堆图把磁盘刷爆。 */
export const MAX_STAGED_ATTACHMENTS = 20;
/** issue_get 一次最多 stage 多少字节。 */
export const MAX_STAGED_BYTES = 50 * 1024 * 1024;

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

/** 按文件头判断真实类型；认不出来返回 null。扩展名不可信，这个才可信。 */
export function sniffImageMime(buffer) {
  if (!buffer || buffer.length < 4) return null;
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 6 && buffer.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('latin1') === 'RIFF'
    && buffer.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

/**
 * 校验并读完所有图片，**不写任何东西**。返回 [{ name, mime, buffer }]。
 *
 * 路径必须是绝对路径或 `~` 开头——不同 Bot 的 cwd 不一样，按 cwd 猜是坑。
 */
export function planImages(images = []) {
  const list = Array.isArray(images) ? images.filter(item => typeof item === 'string' && item.trim()) : [];
  if (list.length === 0) return [];
  if (list.length > MAX_IMAGES_PER_CALL) {
    throw failure('TOO_MANY_IMAGES', `一次最多 ${MAX_IMAGES_PER_CALL} 张图片，这次给了 ${list.length} 张`);
  }

  const planned = [];
  for (const raw of list) {
    const given = raw.trim();
    const expanded = given === '~' || given.startsWith('~/') ? path.join(homedir(), given.slice(1)) : given;
    if (!path.isAbsolute(expanded)) {
      throw failure('RELATIVE_PATH', `${given} 不是绝对路径，请给绝对路径（如 /tmp/shot.png）`);
    }
    const byExt = imageMimeFor(expanded);
    if (!byExt) {
      throw failure('UNSUPPORTED_IMAGE', `${expanded} 不是支持的图片格式（${IMAGE_EXT_HINT}）`);
    }

    let stat;
    try {
      stat = statSync(expanded);
    } catch (error) {
      if (error.code === 'ENOENT') throw failure('IMAGE_NOT_FOUND', `找不到文件：${expanded}`);
      throw failure('IMAGE_UNREADABLE', `读不了文件：${expanded}（${error.message}）`);
    }
    // 先看大小再读：别为了报「太大」把几 GB 读进内存。
    if (!stat.isFile()) throw failure('NOT_A_FILE', `${expanded} 不是普通文件`);
    if (stat.size === 0) throw failure('EMPTY_IMAGE', `文件是空的：${expanded}`);
    if (stat.size > ATTACHMENT_MAX_BYTES) {
      const mb = (stat.size / 1024 / 1024).toFixed(1);
      throw failure('TOO_LARGE', `${path.basename(expanded)} 太大（${mb}MB），单张上限 ${ATTACHMENT_MAX_BYTES / 1024 / 1024}MB`);
    }

    let buffer;
    try {
      buffer = readFileSync(expanded);
    } catch (error) {
      throw failure('IMAGE_UNREADABLE', `读不了文件：${expanded}（${error.message}）`);
    }
    if (!buffer.length) throw failure('EMPTY_IMAGE', `文件是空的：${expanded}`);

    const sniffed = sniffImageMime(buffer);
    if (!sniffed) {
      throw failure('NOT_AN_IMAGE', `${path.basename(expanded)} 的内容不是图片（扩展名写着 ${path.extname(expanded) || '无'}，但文件头对不上）`);
    }
    planned.push({ name: path.basename(expanded), mime: sniffed, buffer });
  }
  return planned;
}

/** 把 planImages() 的结果写进附件库，返回 markdown 片段。 */
export function savePlannedImages({ store, issueId, planned = [] }) {
  const attachments = [];
  const marks = [];
  for (const item of planned) {
    const saved = store().addAttachment({ issueId, name: item.name, mime: item.mime, data: item.buffer.toString('base64') });
    const safeName = saved.name || item.name;
    attachments.push({ id: saved.id, url: saved.url, name: safeName });
    marks.push(`![${safeName}](${saved.url})`);
  }
  return { markdown: marks.join('\n'), attachments };
}

/** 校验 + 落库，一步到位（调用方不需要自己分两段时用这个）。 */
export function attachImages({ store, issueId, images = [] }) {
  return savePlannedImages({ store, issueId, planned: planImages(images) });
}

/**
 * 把事务里所有图片附件 stage 到共享工作区，返回可直接 `read_image` 的本地路径。
 *
 * Bot 看不了 URL：评论/正文里存的是 `/api/bot-issue?attachment=<id>`，要读图必须落到
 * 本地文件。这里按 id 去重、按 `<id>-<文件名>` 落盘（同一个附件重复 stage 是幂等覆盖：
 * 目标已存在且大小一致就不重复拷）。
 */
export function stageIssueAttachments({ store, stagingDir, issueNumber, issueId, texts = [] }) {
  const seen = new Set();
  const refs = [];
  for (const item of texts) {
    for (const hit of String(item?.text || '').matchAll(/\/api\/bot-issue\?attachment=([0-9a-f]+)/g)) {
      if (seen.has(hit[1])) continue;
      seen.add(hit[1]);
      refs.push({ id: hit[1], where: item?.where || 'body' });
    }
  }
  if (!refs.length) return { attachments: [], skipped: 0 };

  const dir = path.join(stagingDir, String(issueNumber || issueId || 'unknown'));
  const attachments = [];
  let bytes = 0;
  let skipped = 0;

  for (const { id, where } of refs) {
    const url = `/api/bot-issue?attachment=${id}`;
    if (attachments.length >= MAX_STAGED_ATTACHMENTS) { skipped += 1; continue; }
    const file = store().getAttachment(id);
    if (!file?.filePath) {
      attachments.push({ where, name: '', mime: '', bytes: 0, url, path: null, note: '附件文件已不存在' });
      continue;
    }
    if (attachments.length && bytes + Number(file.bytes || 0) > MAX_STAGED_BYTES) { skipped += 1; continue; }

    const base = path.basename(file.name || file.id);
    const dest = path.join(dir, `${id}-${base}`);
    try {
      mkdirSync(dir, { recursive: true });
      const fresh = !existsSync(dest) || statSync(dest).size !== Number(file.bytes || 0);
      if (fresh) copyFileSync(file.filePath, dest);
      bytes += Number(file.bytes || 0);
      attachments.push({ where, name: file.name || base, mime: file.mime, bytes: file.bytes, url, path: dest });
    } catch (error) {
      attachments.push({ where, name: file.name || base, mime: file.mime, bytes: file.bytes, url, path: null, note: `复制失败：${error.message}` });
    }
  }
  return { attachments, skipped };
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

const brief = issue => ({
  id: issue.id,
  number: issue.number,
  title: issue.title,
  status: issue.status,
  priority: issue.priority || DEFAULT_PRIORITY,
  parentId: issue.parentId,
  updatedAt: issue.updatedAt,
});
const statusEnum = [...STATUSES];
const priorityEnum = [...PRIORITIES];
/** `open=待处理、discussing=讨论中…`：给模型看的枚举，人话名字从 store 来，不重复维护。 */
const statusGloss = STATUSES.map(status => `${status}=${STATUS_LABELS[status]}`).join('、');
// 模型看到的文案统一用人话状态名（待处理/待验收/已闭环…），不暴露 open/in_review 这类内部码。
const labelOf = status => STATUS_LABELS[status] || status;
const KIND_LABELS = { comment: '评论', status: '状态', reject: '打回', assign: '指派', result: '结果' };
const kindLabelOf = kind => KIND_LABELS[kind] || kind;

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
  const NOTICE_SUMMARY_MAX = 120;
  const boundSummary = summary => {
    const s = String(summary || '').replace(/\s+/g, ' ').trim();
    if (!s) return '事务通知';
    return s.length <= NOTICE_SUMMARY_MAX ? s : `${s.slice(0, NOTICE_SUMMARY_MAX - 1)}…`;
  };
  const deepFreeze = value => {
    if (!value || typeof value !== 'object') return value;
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
    return value;
  };
  const escapeReminder = line => String(line || '').replaceAll('</system-reminder>', '<\\/system-reminder>');
  const formatSystemReminder = (lines, body = '') => {
    const head = ['<system-reminder>', ...lines.filter(Boolean).map(escapeReminder), '</system-reminder>'].join('\n');
    const tail = String(body || '').trim();
    return tail ? `${head}\n\n${tail}` : head;
  };
  const createNoticeMessage = (text, summary) => deepFreeze(structuredClone({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: 'bot-issue',
      form: 'notice',
      summary: boundSummary(summary),
    },
  }));

  let sessionController = null;
  let sessions = null;
  ctx.inject(['sessionController'], sc => { sessionController = sc.sessionController; });
  ctx.inject(['sessions'], s => { sessions = s.sessions; });
  // 内置「事务规则」skill：全队成员共用一份工作流规则（硬规则由上面代码兜底）。
  let skillsWired = false;
  ctx.inject(['skills'], skillsCtx => {
    const dispose = skillsCtx.skills.registerProvider(() => issueWorkflowProvider());
    skillsWired = true;
    return () => { try { dispose?.(); } catch { /* already gone */ } };
  });
  const nameOf = sid => botNamesOf(statePath).get(sid) || null;

  // 同一个 Bot 的会话 id 可能不止一个（bot.id / sessionId / 各段），用名字判同一只 Bot，
  // 并在同一次提醒中按 Bot 规范键去重，避免「被回复 + @ + 对侧」连发三条提醒。
  const sameBot = (a, b) => {
    if (!a || !b) return false;
    if (a === b) return true;
    const na = nameOf(a);
    return !!na && na === nameOf(b);
  };
  const resolveBotTarget = ({ sessionId = null, name = null } = {}) => {
    const names = botNamesOf(statePath);
    const trimmed = typeof name === 'string' && name.trim() ? name.trim() : null;
    const resolvedName = (sessionId && names.get(sessionId)) || trimmed;
    const roster = botRoster(statePath);
    let bot = roster.find(b => (resolvedName && b.name === resolvedName) || (sessionId && b.sessionId === sessionId));
    if (!bot && resolvedName === '主 Bot' && mainBot?.id) {
      bot = roster.find(b => b.id === mainBot.id) || mainBot;
    }
    const targetSid = bot?.sessionId || sessionId || null;
    const key = bot?.id ? `bot:${bot.id}` : (resolvedName ? `name:${resolvedName}` : (targetSid ? `sid:${targetSid}` : null));
    return { key, sessionId: targetSid };
  };
  // 以 DSH 非用户事件（form: 'notice'）+ <system-reminder> 唤醒目标会话，
  // 聊天界面会渲染为「收到执行请求」折叠事件卡，不混入普通用户气泡。
  const sendNotice = async (sessionId, { summary, text }) => {
    if (!sessionId || !sessionController) return false;
    if (typeof sessionController.resolveAgent === 'function') {
      const resolved = await sessionController.resolveAgent(sessionId);
      if (!resolved || 'error' in resolved || typeof resolved.agent?.followup !== 'function') {
        throw new Error(resolved?.error?.message || '目标会话不可用');
      }
      resolved.agent.followup(createNoticeMessage(text, summary));
      if (typeof sessions?.flush === 'function' && resolved.agent.session) {
        await sessions.flush(resolved.agent.session);
      }
      return true;
    }
    if (typeof sessionController.prompt === 'function') {
      await sessionController.prompt(
        { requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text }] },
        AbortSignal.timeout(30_000),
      );
      return true;
    }
    return false;
  };
  const deliverBestEffort = async (sessionId, payload) => {
    try { return await sendNotice(sessionId, payload); } catch { return false; }
  };

  // 回复某条评论时直接知会原评论作者（如果作者是 Bot 且不是回复者自己）。
  const notifyReplyTarget = async (issue, comment, commenterSessionId = null, notified = new Set()) => {
    const target = comment?.replyTo;
    if (!target || target.authorKind !== 'agent') return;
    const resolved = resolveBotTarget({ sessionId: target.authorSessionId, name: target.authorName });
    if (!resolved.sessionId || sameBot(resolved.sessionId, commenterSessionId)) return;
    if (resolved.key && notified.has(resolved.key)) return;
    const label = issue.number ? `#${issue.number}` : issue.id;
    const replier = comment.authorKind === 'user' ? '用户' : (comment.authorName || '同事');
    const text = formatSystemReminder(
      [`[事务评论回复] 目标评论 #${comment.id}（事务 ${label}「${issue.title}」）；若需回应请遵循 \`issue-workflow\` 规则。`],
      [`${replier} 回复了你的评论：`, target.preview ? `> ${target.preview}` : null, comment.body].filter(Boolean).join('\n'),
    );
    if (await deliverBestEffort(resolved.sessionId, { summary: `${label} 评论被 ${replier} 回复`, text }) && resolved.key) {
      notified.add(resolved.key);
    }
  };

  // 事务评论里的 @同事 → 以事件通知唤醒被提及同事的前台会话。
  const notifyMentions = async (issue, body, commenterSessionId = null, notified = new Set()) => {
    if (typeof body !== 'string' || !body.includes('@') || !sessionController) return;
    const label = issue.number ? `#${issue.number}` : issue.id;
    const roster = botRoster(statePath).filter(bot => bot.sessionId).sort((a, b) => b.name.length - a.name.length);
    for (const bot of roster) {
      if (!body.includes(`@${bot.name}`)) continue;
      if (sameBot(bot.sessionId, commenterSessionId)) continue;
      const { key } = resolveBotTarget({ sessionId: bot.sessionId, name: bot.name });
      if (key && notified.has(key)) continue;
      const text = formatSystemReminder(
        [`[事务提及通知] 你在事务 ${label}「${issue.title}」中被提及；请遵循 \`issue-workflow\` 规则按需处理。`],
        `评论内容：\n${body}`,
      );
      if (await deliverBestEffort(bot.sessionId, { summary: `${label} 评论提及了你`, text }) && key) {
        notified.add(key);
      }
    }
  };

  // 事务有更新时知会对侧：执行人动作 → 知会主 Bot；主 Bot/人动作 → 知会执行人；
  // 没有执行人（老事务/未派工）→ 知会主 Bot 按规则接手。
  const notifyCounterpart = async (issue, bySessionId, summary, notified = new Set()) => {
    if (!sessionController) return;
    const label = issue.number ? `#${issue.number}` : issue.id;
    const assigneeSid = issue?.assignee?.sessionId;
    let target;
    if (assigneeSid) {
      if (bySessionId && sameBot(bySessionId, assigneeSid)) target = { sessionId: mainBot?.sessionId, name: mainBot?.name || '主 Bot' };
      else if (!bySessionId || isMainOf(bySessionId)) target = { sessionId: assigneeSid, name: issue.assignee.name || assigneeSid };
      else return; // 既不是执行人也不是主 Bot 的第三位，不打扰对侧
    } else {
      // 没有执行人：主 Bot 自己动的手就不必再通知自己，其它情况让主 Bot 接手。
      if (!bySessionId || !isMainOf(bySessionId)) target = { sessionId: mainBot?.sessionId, name: mainBot?.name || '主 Bot' };
    }
    if (!target?.sessionId || sameBot(target.sessionId, bySessionId)) return;
    const { key } = resolveBotTarget({ sessionId: target.sessionId, name: target.name });
    if (key && notified.has(key)) return;
    const text = formatSystemReminder(
      [`[事务状态变更] 事务 ${label}「${issue.title}」发生更新；请对照 \`issue-workflow\` 规则读取上下文并按职责跟进。`],
      `事务：${label}「${issue.title}」\n动态：${summary}`,
    );
    if (await deliverBestEffort(target.sessionId, { summary: `事务 ${label}：${summary}`, text }) && key) {
      notified.add(key);
    }
  };

  const notifyActivity = async (issue, comment, commenterSessionId = null, summaryOverride = null) => {
    const notified = new Set();
    try { await notifyReplyTarget(issue, comment, commenterSessionId, notified); } catch { /* best effort */ }
    try { await notifyMentions(issue, comment?.body, commenterSessionId, notified); } catch { /* best effort */ }
    // 状态变更总是知会对侧（无执行人时知会主 Bot 接手）；评论只在有执行人时知会对侧，避免刷屏。
    if (comment?.statusChange || issue?.assignee) {
      try { await notifyCounterpart(issue, commenterSessionId, summaryOverride || comment?.body || '有更新', notified); } catch { /* best effort */ }
    }
  };

  // 「启动」＝推送派工事件给主 Bot；主 Bot 按 `issue-workflow` skill 自主选人、message_bot 并登记执行人。
  const start = async (issue) => {
    if (!mainBot?.sessionId) return { dispatched: false, reason: '找不到主 Bot 会话（检查 state.json 的 mainBotIds）' };
    if (typeof sessionController?.resolveAgent !== 'function' && typeof sessionController?.prompt !== 'function') {
      return { dispatched: false, reason: '宿主未提供 sessionController' };
    }
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

    const label = issue.number ? `#${issue.number}` : issue.id;
    const prioLabel = PRIORITY_LABELS[issue.priority] || issue.priority || PRIORITY_LABELS[DEFAULT_PRIORITY];
    const attachmentsSection = attachments.length
      ? `\n\n附件本地路径（read_image 读取）：\n${attachments.map(a => `- ${a.path}（${a.name}）`).join('\n')}`
      : '';
    const text = formatSystemReminder(
      [
        '[事务派工事件] 请主 Bot 按 `issue-workflow` 规则自主调度并完成指派登记。',
        needVision
          ? '- 本事务包含图片，选定执行人时需确认其模型具备读图能力；转交时附带下列本机附件路径。'
          : '- 结合成员专长与当前负载独立选定执行人，勿混淆团队交接与工作者派工路径。',
      ],
      [
        `事务：${label}（${issue.id}）「${issue.title}」`,
        `紧急程度：${prioLabel}`,
        '',
        '同事在办负载：',
        loadTable,
      ].join('\n') + attachmentsSection + `\n\n正文：\n${issue.body || '（无正文）'}`,
    );

    try {
      await sendNotice(mainBot.sessionId, { summary: `派工：${label}「${issue.title}」`, text });
    } catch (error) {
      return { dispatched: false, reason: `通知主 Bot 失败：${error.message}` };
    }
    // 执行人由主 Bot 自主指派记录；这里只把事务标为进行中。
    store().update(issue.id, { status: 'dispatched' }, { kind: 'system', name: '' });
    return { dispatched: true, note: '已交给主 Bot 处理' };
  };


  // ---- 临时讨论群桥接：通过进程内 /api/dscord/kernel 建群、发开场白、终态自动焚毁 ----
  const callKernel = async (endpoint, payload = {}) => {
    if (typeof ctx.connection?.createSharedFetchHandler !== 'function') {
      throw new Error('当前宿主不支持进程内群聊桥接');
    }
    const handler = ctx.connection.createSharedFetchHandler('/api');
    const response = await handler.fetch(new Request('http://localhost/api/dscord/kernel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint, payload }),
    }), ctx.connection.browserPeer);
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.ok) {
      throw new Error(data?.error?.message || `内核请求 ${endpoint} 失败 (${response.status})`);
    }
    return data.value;
  };

  const discussRoom = {
    async create(issue, { members = [], topic = '', autoStart = false } = {}) {
      const roster = botRoster(statePath);
      const validIds = new Set(roster.map(b => b.id));
      const picked = new Set();
      if (mainBot?.id && validIds.has(mainBot.id)) picked.add(mainBot.id);
      for (const m of members) {
        const hit = roster.find(b => b.id === m || b.sessionId === m || b.name === m);
        if (hit) picked.add(hit.id);
      }
      if (issue.assignee?.sessionId) {
        const hit = roster.find(b => b.sessionId === issue.assignee.sessionId || b.id === issue.assignee.sessionId);
        if (hit) picked.add(hit.id);
      }
      const memberIds = [...picked];
      if (memberIds.length === 0) return null;
      const ref = issue.number ? `#${issue.number}` : issue.id;
      const shortTitle = String(issue.title || '').trim().slice(0, 22);
      const name = `讨论 · ${ref} ${shortTitle}`.trim();
      const room = await callKernel('create-room', {
        members: memberIds,
        name,
        ...(mainBot?.id && picked.has(mainBot.id) ? { admin: mainBot.id } : {}),
      });
      if (!room?.id) return null;
      const gateRule = autoStart
        ? '本群已授权多方共识自动开工：实现方用 issue_comment(agree: true) 签字确认方案可行后，主 Bot 方可汇总共识并推进到「进行中」。'
        : '本群需由用户最终拍板开工：请对齐需求边界、可行性与实现方案，实现方可签字确认，主 Bot 将共识汇总写入事务评论后等待用户点击「确认共识 · 启动」。';
      const notice = [
        `事务 ${ref}「${issue.title}」临时讨论群（验收通过或取消后自动销毁）。`,
        topic ? `本次讨论焦点：${topic}` : '',
        '规则：讨论期禁止直接派工写代码。' + gateRule,
      ].filter(Boolean).join('\n');
      try { await callKernel('update-room', { id: room.id, notice }); } catch { /* best effort */ }
      const intro = [
        `【发起事务讨论】${ref}「${issue.title}」`,
        topic ? `讨论焦点：${topic}` : '',
        issue.body ? `事务说明：\n${issue.body.slice(0, 1200)}` : '',
        '',
        '请主 Bot 组织受邀成员先澄清需求边界、评估可行性并给出方案，讨论期不要直接派工动代码。达成共识后，实现方请用 issue_comment(agree: true) 签字确认，主 Bot 汇总最终方案。',
      ].filter(Boolean).join('\n');
      try { await callKernel('send', { sessionId: room.id, text: intro }); } catch { /* best effort */ }
      return { id: room.id, name: room.name || name };
    },
    async destroy(issue, reason = '临时讨论群已自动销毁') {
      const roomId = issue?.discussionRoom?.id;
      if (!roomId) return store().get(issue.id);
      try { await callKernel('delete-room', { id: roomId }); } catch { /* room may already be deleted */ }
      return store().clearDiscussionRoom(issue.id, reason);
    },
  };

  // 工具注册结果：ping 里能看到「这个 entry 现在带没带上工具」，出问题不用翻日志。
  let toolsReport = { registered: [], failed: [], at: null };
  const diagnostics = () => ({
    module: fileURLToPath(import.meta.url), pid: process.pid, tools: toolsReport,
    wired: { skills: skillsWired },
  });

  const handle = createIssueHandler({
    store, mainBot, start, diagnostics, discussRoom,
    notify: (issue, comment, commenterSessionId) => {
      notifyActivity(issue, comment, commenterSessionId);
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
          priority: { type: 'string', enum: priorityEnum, description: '需求紧急程度：P0（紧急）、P1（高）、P2（中，默认）、P3（低）' },
          tags: { type: 'array', items: { type: 'string' }, description: '事务标签，可多个（bug / feature / 优化 / 调研 …）；标签库里没有的会自动新建' },
          type: { type: 'string', description: '单个标签的旧写法，等价于 tags 只填一个' },
          images: {
            type: 'array',
            items: { type: 'string' },
            description: '要附到正文里的本地图片绝对路径（png/jpg/jpeg/gif/webp/svg，最多 8 张）',
          },
        },
        required: ['title'],
      },
      output: {
        schema: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string' }, priority: { type: 'string' } }, additionalProperties: false },
        render: (_args, value) => [{ type: 'text', text: `已创建 ${value.id}（${labelOf(value.status)} · ${value.priority || DEFAULT_PRIORITY}）` }],
      },
      async execute(args, exec) {
        const actor = caller(exec, nameOf, isMainOf);
        // 先把图片全部校验完再建事务：任何一张坏掉都不该留下半成品事务。
        const planned = planImages(args.images);
        const issue = store().create({
          title: args.title, body: args.body, parentId: args.parentId, priority: args.priority,
          tags: args.tags !== undefined ? args.tags : args.type,
          createdBy: 'agent', createdByName: actor.name,
        });
        // 附件要挂 issueId，所以只能先建事务再补正文。
        const { markdown } = savePlannedImages({ store, issueId: issue.id, planned });
        if (!markdown) return { id: issue.id, status: issue.status, priority: issue.priority };
        const updated = store().update(issue.id, { body: [issue.body, markdown].filter(Boolean).join('\n\n') }, actor);
        return { id: updated.id, status: updated.status, priority: updated.priority };
      },
    }), 'bot-issue: tool create');

    toolsCtx.effect(() => register({
      name: 'issue_list',
      description: '列出事务。可按状态、紧急程度或父 issue 过滤，返回简要信息（默认按紧急程度从高到低排）；要看全文用 issue_get。',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: statusEnum, description: '只列这个状态' },
          priority: { type: 'string', enum: priorityEnum, description: '只列这个紧急程度（P0~P3）' },
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
              status: { type: 'string' }, priority: { type: 'string' }, updatedAt: { type: 'integer' },
            },
            additionalProperties: true,
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.length ? value.map(t => `#${t.number ?? '?'} [${t.priority || DEFAULT_PRIORITY}] ${labelOf(t.status)} ${t.id}  ${t.title}`).join('\n') : '（空）' }],
      },
      async execute(args) {
        return store().list({ status: args.status, priority: args.priority, parentId: args.parentId, type: args.type }).items.map(brief);
      },
    }), 'bot-issue: tool list');

    toolsCtx.effect(() => register({
      name: 'issue_get',
      description: '读一个事务的全文：标题、正文、状态、紧急程度、标签、依赖、结果、评论时间线和派工记录。返回的 version 用于 issue_update 的安全写入。id 可以是内部 id，也可以是 #编号（如 #12）。',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'issue id 或 #编号（如 #12）' } },
        required: ['id'],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{
          type: 'text',
          text: [
            `#${value.number ?? '?'} [${value.priority || DEFAULT_PRIORITY}] ${value.title}【${labelOf(value.status)}】`,
            value.tags?.length ? `标签：${value.tags.join('、')}` : null,
            value.assignee ? `执行人：${value.assignee}` : null,
            value.createdByName ? `创建人：${value.createdByName}` : null,
            `创建于 ${fmtTime(value.createdAt)} · 更新于 ${fmtTime(value.updatedAt)}`,
            '',
            value.body || '（无正文）',
            value.dependsOn?.length ? `\n前置：${value.dependsOn.join('；')}` : null,
            value.blocks?.length ? `\n后置：${value.blocks.join('；')}` : null,
            value.result ? `\n闭环结果：\n${value.result}` : null,
            value.dispatches?.length ? `\n派工记录：\n${value.dispatches.join('\n')}` : null,
            value.comments?.length
              ? `\n评论时间线（共 ${value.commentTotal} 条${value.commentsTruncated ? `，仅显示最近 ${value.comments.length} 条` : ''}）：\n${value.comments.join('\n')}`
              : null,
            value.attachments?.length
              ? `\n附带的图片（用 read_image 读这些本地路径，不要读 URL）：\n${value.attachments
                .map((att, i) => `${i + 1}. ${att.name || att.url}  ${att.path || `（${att.note || '拿不到本地路径'}）`}`)
                .join('\n')}`
              : null,
            value.attachmentsSkipped
              ? `（另有 ${value.attachmentsSkipped} 张图超出单次上限，没放进工作区）`
              : null,
          ].filter(line => line !== null).join('\n'),
        }],
      },
      async execute(args) {
        const issue = store().get(args.id);
        const staged = stageIssueAttachments({
          store, stagingDir, issueNumber: issue.number, issueId: issue.id,
          texts: [
            { where: 'body', text: issue.body || '' },
            ...issue.comments.map(c => ({ where: `comment:${c.id}`, text: c.body || '' })),
          ],
        });
        const MAX_COMMENTS = 20;
        const comments = issue.comments || [];
        const commentsTruncated = comments.length > MAX_COMMENTS;
        const shownComments = comments.slice(-MAX_COMMENTS);
        return {
          id: issue.id, number: issue.number, title: issue.title, body: issue.body, status: issue.status,
          priority: issue.priority, type: issue.type, tags: issue.tags, version: issue.version,
          assignee: issue.assignee ? (issue.assignee.name || issue.assignee.sessionId) : null,
          dependsOn: issue.dependsOn.map(dep => `#${dep.number} ${labelOf(dep.status)} ${dep.title}`),
          blocks: issue.blocks.map(dep => `#${dep.number} ${labelOf(dep.status)} ${dep.title}`),
          result: issue.result, createdByName: issue.createdByName, createdAt: issue.createdAt, updatedAt: issue.updatedAt,
          commentTotal: comments.length,
          commentsTruncated,
          comments: shownComments.map(c => {
            const who = c.authorKind === 'user' ? '用户' : (c.authorName || c.authorKind);
            const prefix = canReplyComment(c) ? `[评论 ${c.id}]` : '';
            const replyHint = c.replyTo
              ? ` 回复 [评论 ${c.replyTo.id}]（${c.replyTo.authorKind === 'user' ? '用户' : (c.replyTo.authorName || c.replyTo.authorKind)}）`
              : '';
            return `${prefix}[${kindLabelOf(c.kind)}] ${who}（${fmtTime(c.at)}）${replyHint}：${c.body}`;
          }),
          dispatches: issue.dispatches.map(d => `${d.taskId}（${labelOf(d.status)}）`),
          attachments: staged.attachments,
          attachmentsSkipped: staged.skipped,
        };
      },
    }), 'bot-issue: tool get');

    toolsCtx.effect(() => register({
      name: 'issue_update',
      description: `更新事务：改状态、紧急程度、写结果、改标题或正文。改状态要遵守流转规则（${statusGloss}），且所有状态流转都必须填写处理意见（note / result / rejection）；只有用户能推进到 done（已闭环），主 Bot 到 in_review（待验收）即视为交验；传 expectedVersion 可避免覆盖别人的改动。`,
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'issue id 或 #编号（如 #12）' },
          status: { type: 'string', enum: statusEnum, description: `目标状态（${statusGloss}）。in_review=待验收（执行人交验、主 Bot 测试通过的终点）；done=已闭环（仅用户可点，主 Bot 点会被拒绝）` },
          priority: { type: 'string', enum: priorityEnum, description: '需求紧急程度：P0（紧急）、P1（高）、P2（中）、P3（低）' },
          note: { type: 'string', description: '状态流转处理意见（任何改状态的动作必填：取消写取消原因、提交待验收写交付结论、转进行中/讨论中/重开/失败写处理说明；验收通过也可填 result，打回重做也可填 rejection）' },
          result: { type: 'string', description: '闭环结果/验收意见（用户把 in_review 推进到 done 时必填，写清验证了什么，不要只写状态）' },
          rejection: { type: 'string', description: '验收不通过/打回意见（把 in_review 打回 open 或 dispatched 时必填）' },
          title: { type: 'string' },
          body: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' }, description: '整组替换事务标签（传空数组=清空）；不传则不动' },
          type: { type: 'string', description: '单个标签的旧写法，等价于 tags 只填一个' },
          images: {
            type: 'array',
            items: { type: 'string' },
            description: '要追加到正文末尾的本地图片绝对路径（png/jpg/jpeg/gif/webp/svg，最多 8 张）；不传 body 时追加到现有正文',
          },
          expectedVersion: { type: 'integer', description: 'issue_get 读到的 version，不一致会拒绝写入' },
        },
        required: ['id'],
      },
      output: {
        schema: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string' }, priority: { type: 'string' }, version: { type: 'integer' } }, additionalProperties: false },
        render: (_args, value) => [{ type: 'text', text: `${value.id} → ${labelOf(value.status)}（${value.priority || DEFAULT_PRIORITY}）` }],
      },
      async execute(args, exec) {
        const actor = caller(exec, nameOf, isMainOf);
        const before = store().get(args.id);
        // 先校验全部图片，再落库：校验失败时一行都不写。
        const planned = planImages(args.images);
        // 只带 images 时追加到现有正文末尾，不能把正文清空。
        const { markdown } = savePlannedImages({ store, issueId: before.id, planned });
        const body = markdown
          ? [args.body !== undefined ? args.body : before.body, markdown].filter(Boolean).join('\n\n')
          : args.body;
        const issue = store().update(args.id, {
          status: args.status, priority: args.priority, result: args.result,
          note: typeof args.note === 'string' ? args.note : undefined,
          title: args.title, body,
          tags: args.tags, type: args.type,
          rejection: typeof args.rejection === 'string' ? args.rejection : undefined,
          expectedVersion: typeof args.expectedVersion === 'number' ? args.expectedVersion : undefined,
        }, actor);
        if (args.status !== undefined) {
          const opinionText = [args.note, args.result].find(v => typeof v === 'string' && v.trim())?.trim();
          const summary = typeof args.rejection === 'string' && args.rejection.trim()
            ? `被打回重做：${args.rejection.trim()}`
            : `状态变为「${STATUS_LABELS[issue.status] || issue.status}」${opinionText ? `：${opinionText}` : ''}`;
          try { await notifyCounterpart(issue, actor.id, summary); } catch { /* best effort */ }
          if ((issue.status === 'done' || issue.status === 'cancelled') && issue.discussionRoom?.id) {
            const reason = issue.status === 'done'
              ? '临时讨论群已自动销毁（验收通过，结论已沉淀在事务记录中）'
              : '临时讨论群已自动销毁（事务已取消）';
            try { await discussRoom.destroy(issue, reason); } catch { /* best effort */ }
          }
        }
        return { id: issue.id, status: issue.status, priority: issue.priority, version: issue.version };
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

    const emptyCommentStreak = new Map();
    toolsCtx.effect(() => register({
      name: 'issue_comment',
      description: '给事务追加一条评论（发现、结论、交接说明等），同时会出现在时间线里。支持通过 replyTo 指定回复某条历史评论并通知原评论作者。评论会直接给人看：写人话，别写工具名（issue_get 这类）、状态码（open/in_review）或版本号（v10）。有截图/产出图时用 images 一起贴上来。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'issue id 或 #编号（如 #12）' },
          body: { type: 'string', description: '必填：评论正文内容（即使附带 images 也请写一句简短说明）' },
          replyTo: { type: 'integer', description: '可选：要回复那条评论的编号（从事务详情时间线里方括号中的数字读取，如 42）' },
          agree: { type: 'boolean', description: '仅在「讨论中」状态有效：设为 true 表示你已理解需求并确认方案可行（签字达成共识）' },
          images: {
            type: 'array',
            items: { type: 'string' },
            description: '要贴进评论的本地图片绝对路径（png/jpg/jpeg/gif/webp/svg，最多 8 张）。',
          },
        },
        required: ['id', 'body'],
      },
      output: {
        schema: {
          type: 'object',
          properties: { id: { type: 'integer' }, images: { type: 'integer' }, replyTo: { type: 'boolean' } },
          additionalProperties: false,
        },
        render: (_args, value) => [{
          type: 'text',
          text: value?.replyTo
            ? (value?.images ? `回复已添加（含 ${value.images} 张图）。` : '回复已添加。')
            : (value?.images ? `评论已添加（含 ${value.images} 张图）。` : '评论已添加。'),
        }],
      },
      async execute(args, exec) {
        const issue = store().get(args.id);
        // 先校验图片、回复目标和正文，再落库：校验失败不该留下孤儿附件。
        const planned = planImages(args.images);
        const text = String(args.body || '').trim();
        const streakKey = String(exec?.agent?.id || exec?.session?.id || 'global');
        if (!text && !planned.length) {
          const streak = (emptyCommentStreak.get(streakKey) || 0) + 1;
          emptyCommentStreak.set(streakKey, streak);
          if (streak >= 3) {
            throw new Error(`已连续 ${streak} 次调用 issue_comment 缺少 body 参数，请立即停止重试此工具！请直接在聊天回复中把结果发给用户，不要继续空转。`);
          }
          throw new Error(`评论不能为空：缺少必填参数 body（请传入 { id: "${args.id}", body: "你的评论内容" }，不要只传 id）。`);
        }
        emptyCommentStreak.delete(streakKey);
        const replyToId = args.replyTo !== undefined && args.replyTo !== null ? args.replyTo : null;
        if (replyToId !== null) {
          const target = Number.isSafeInteger(replyToId) ? issue.comments.find(c => c.id === replyToId) : null;
          if (!canReplyComment(target)) {
            throw failure('INVALID_REPLY_TO', target ? '状态或指派记录不能回复' : '找不到要回复的评论');
          }
        }
        const { markdown, attachments } = savePlannedImages({ store, issueId: issue.id, planned });
        const body = [text, markdown].filter(Boolean).join('\n\n');

        const actor = caller(exec, nameOf, isMainOf);
        const isAgree = args.agree === true && issue.status === 'discussing';
        const value = store().comment(issue.id, {
          body,
          authorKind: 'agent',
          authorName: actor.name,
          authorSessionId: actor.id || null,
          kind: isAgree ? 'agree' : 'comment',
          replyToId,
        });
        const summary = isAgree
          ? `已确认讨论方案：${text.slice(0, 80)}`
          : (attachments.length ? `新增评论（${attachments.length} 张图）` : (replyToId ? '回复了评论' : '新增评论'));
        await notifyActivity(store().get(issue.id), value, actor.id, summary);
        return { id: value.id, images: attachments.length, replyTo: Boolean(value.replyToId) };
      },
    }), 'bot-issue: tool comment');
  });

  // Dispatched issues close themselves: sweep the dscord node ledger without
  // waiting for the Bot's next turn.
  ctx.effect(() => {
    const handle = startWriteback({
      store,
      nodesRoot,
      intervalMs: writebackIntervalMs,
      workerNameOf: nameOf,
      // A worker finished: the issue moved to 待验收 on its own, so somebody has to
      // look. The main Bot owns verification, so ping it (the worker is not a Bot).
      onSettle: ({ issueId }) => {
        try {
          const full = store().get(issueId);
          void notifyCounterpart(full, full?.assignee?.sessionId || null, '工作者已交回结果，已转入待验收');
        } catch { /* best effort */ }
      },
    });
    return () => handle.stop();
  }, 'bot-issue: writeback');

  ctx.effect(() => () => { try { opened?.close(); } catch { /* already closed */ } opened = null; }, 'bot-issue: database');
}






