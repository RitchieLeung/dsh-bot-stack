/**
 * HTTP handler for the knowledge panel.
 *
 * Kept free of Cordis so the request/response contract is unit-testable.
 * `store` may be a store instance or a zero-argument factory returning one,
 * which lets the host open the database lazily: a temporarily missing
 * database must not stop the plugin from loading.
 */

export function todayInShanghai(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(now);
}

export function createKnowledgeHandler({ store, schedule }) {
  const resolve = () => (typeof store === 'function' ? store() : store);
  return async function handle(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { ok: false, error: { code: 'INVALID_BODY', message: '请求格式无效' } };
    }
    const action = typeof body.action === 'string' ? body.action : '';
    try {
      if (action === 'bots') {
        const date = typeof body.date === 'string' && body.date ? body.date : todayInShanghai();
        return { ok: true, value: { bots: resolve().bots({ date }) } };
      }
      if (action === 'entries') {
        return { ok: true, value: resolve().entries({ botId: body.botId, category: body.category, limit: body.limit, offset: body.offset }) };
      }
      if (action === 'reports') {
        const date = typeof body.date === 'string' && body.date ? body.date : todayInShanghai();
        return { ok: true, value: { date, reports: resolve().reports({ date }) } };
      }
      if (action === 'schedules' || action === 'ensure-schedules') {
        if (!schedule) return { ok: false, error: { code: 'SCHEDULE_UNAVAILABLE', message: '宿主未提供排程服务' } };
        return { ok: false, error: { code: 'SCHEDULE_NOT_WIRED', message: '排程尚未接入' } };
      }
      return { ok: false, error: { code: 'UNKNOWN_ACTION', message: `未知操作：${action || '(空)'}` } };
    } catch (error) {
      return { ok: false, error: { code: error.code || 'INTERNAL', message: error.message || String(error) } };
    }
  };
}
