/**
 * Daily work-report scheduling.
 *
 * The report is authored by the Bot itself: a daily prompt wakes its front
 * session and asks it to write one memory with `predicate = 'daily-report'`.
 * The prompt is deliberately date-independent so the task only needs editing
 * when the Bot's session changes, not every day.
 */

export const REPORT_PREDICATE = 'daily-report';
export const DEFAULT_TIME = '19:00:00';
export const DEFAULT_TIME_ZONE = 'Asia/Shanghai';
export const REPORT_TITLE_PREFIX = 'bot-daily-report:';

export function reportTitle(botId) {
  return `${REPORT_TITLE_PREFIX}${botId}`;
}

export function reportPrompt({ botName }) {
  const who = botName ? `${botName}` : '这只 Bot';
  return [
    `这是系统每日 19:00 自动触发的工作日报任务，不要回复任何人。`,
    `你是${who}。请调用 remember 工具写一条工作日报，参数如下：`,
    `- predicate: "${REPORT_PREDICATE}"`,
    `- topic: 今天的日期，格式 YYYY-MM-DD（Asia/Shanghai 时区，按你上下文里的当前时间算）`,
    '- kind: "inference"',
    '- facets: ["experience"]',
    `- text: 用中文分四行写：① 今天做了什么；② 卡在哪、需要谁配合；③ 明天计划；④ 一句话感想。`,
    '写完后结束这一轮即可。你的回复不会发送给任何人，不需要写给人看的客套话。',
  ].join('\n');
}

export async function ensureDailyReportSchedules({ schedule, bots, time = DEFAULT_TIME, timeZone = DEFAULT_TIME_ZONE }) {
  const catalogue = await schedule.list({ limit: 500 });
  const items = Array.isArray(catalogue?.items) ? catalogue.items : [];
  const byTitle = new Map();
  for (const item of items) {
    if (item && typeof item.title === 'string') byTitle.set(item.title, item);
  }
  const results = [];
  for (const bot of Array.isArray(bots) ? bots : []) {
    if (!bot || typeof bot.id !== 'string') continue;
    const title = reportTitle(bot.id);
    const prompt = reportPrompt({ botName: bot.name });
    const timing = { kind: 'daily', daily: { time, time_zone: timeZone } };
    const target = bot.sessionId ? { kind: 'session', sessionId: bot.sessionId } : null;
    const current = byTitle.get(title);

    if (!current) {
      if (!target) { results.push({ botId: bot.id, scheduleId: null, action: 'skipped' }); continue; }
      const created = await schedule.create({ title, prompt, timing, target });
      results.push({ botId: bot.id, scheduleId: created?.id ?? null, action: 'created' });
      continue;
    }

    const sameSession = current.target?.kind === 'session' && current.target.sessionId === bot.sessionId;
    const samePrompt = current.prompt === prompt;
    if (sameSession && samePrompt) {
      results.push({ botId: bot.id, scheduleId: current.id, action: 'unchanged' });
      continue;
    }
    await schedule.edit({ id: current.id, action: 'update',
      patch: { prompt, timing, ...(target ? { target } : {}) } });
    results.push({ botId: bot.id, scheduleId: current.id, action: 'updated' });
  }
  return results;
}

export function reportSchedules(catalogue, bots) {
  const names = new Map((Array.isArray(bots) ? bots : []).map(bot => [bot.id, bot.name]));
  return (Array.isArray(catalogue) ? catalogue : [])
    .filter(item => typeof item?.title === 'string' && item.title.startsWith(REPORT_TITLE_PREFIX))
    .map(item => {
      const botId = item.title.slice(REPORT_TITLE_PREFIX.length);
      return {
        botId,
        botName: names.get(botId) || botId,
        scheduleId: item.id,
        status: item.status || 'unknown',
        nextRunAt: item.scheduledAt || null,
      };
    });
}
