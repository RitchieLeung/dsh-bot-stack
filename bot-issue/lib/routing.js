/**
 * 派工辅助：只判断「事务正文里有没有图」这一件事（纯函数、可单测）。
 *
 * 历史上有过 chooseAssignee/specialtyScore 的确定性选人，但按用户要求改回「执行人由主 Bot
 * 自己定（用 list_bots + list_bot_models 看谁能看图、结合负载）」，这里只保留图片判定，给
 * 派工提示加一句「这条带图，挑人时确认对方能看图」的提醒。
 */

/** 事务正文里的图片证据：附件 URL 或 markdown 图片。 */
const IMAGE_HINT_RE = /\/api\/bot-issue\?attachment=|!\[[^\]]*\]\([^)]*\)/;

/** 事务正文是否要求看图。 */
export function imageTask(body) {
  return typeof body === 'string' && IMAGE_HINT_RE.test(body);
}
