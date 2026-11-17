/**
 * 派工路由：纯函数、无 Cordis，可单测。
 *
 * 能力（能不能看图）由 host 现查 `ctx.llm` 后作为 `vision` 传进来；这里只做
 * 「需要看图 → 只留能看图的」「负载低优先、岗位匹配加分」的确定性选择。不写死
 * 任何模型→能力映射。
 */

/** 事务正文里的图片证据：附件 URL 或 markdown 图片。 */
const IMAGE_HINT_RE = /\/api\/bot-issue\?attachment=|!\[[^\]]*\]\([^)]*\)/;

/** 岗位关键词：从 bot 自己声明的 role/instructions 与事务的 tags/body 里共现时加分。 */
export const SPECIALTY_KEYWORDS = ['前端', '后端', '实施', '协调', '头脑风暴', '算法', '运维'];

/** 事务正文是否要求看图。 */
export function imageTask(body) {
  return typeof body === 'string' && IMAGE_HINT_RE.test(body);
}

/**
 * 岗位匹配分：关键词同时出现在 bot 自述（role/instructions）和事务（tags/body）里
 * 的个数。读 bot 自己的声明，不额外造能力。
 * @param {{role?: string, instructions?: string}} bot
 * @param {{tags?: string[], body?: string}} issue
 * @returns {number}
 */
export function specialtyScore(bot, issue) {
  const botText = `${bot?.role ?? ''} ${bot?.instructions ?? ''}`;
  const issueText = `${(issue?.tags ?? []).join(' ')} ${issue?.body ?? ''}`;
  let score = 0;
  for (const keyword of SPECIALTY_KEYWORDS) {
    if (botText.includes(keyword) && issueText.includes(keyword)) score += 1;
  }
  return score;
}

/**
 * 从候选中选执行人。
 * @param {{ candidates: Array<{sessionId:string, name:string, vision:boolean, load:number, specialty:number}>, needVision: boolean }} input
 * @returns {{ assignee: object|null, reason: string|null }}
 */
export function chooseAssignee({ candidates, needVision }) {
  const pool = needVision ? candidates.filter(candidate => candidate.vision === true) : candidates;
  if (pool.length === 0) {
    return {
      assignee: null,
      reason: needVision
        ? '本机没有能看图的同事，无法派工（请人工处理或改由主 Bot 跨机协调）'
        : '没有可用的同事',
    };
  }
  // 负载低优先；负载相同看岗位匹配分（高者优先）；再相同保持原顺序（稳定）。
  const ranked = [...pool].sort((a, b) => (a.load - b.load) || (b.specialty - a.specialty));
  return { assignee: ranked[0], reason: null };
}
