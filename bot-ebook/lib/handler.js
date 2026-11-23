/**
 * HTTP handler for the ebook module.
 *
 * Free of Cordis so the request/response contract is unit-testable.
 * `store` may be a store instance or a zero-argument factory returning one,
 * which lets the host open the database lazily: a missing database must not
 * stop the plugin from loading.
 *
 * 采集与助手通过可注入的 `ingest` / `assistant` / `models` 进来，handler 只做
 * 薄路由 + 参数校验，不碰模型/网络。
 */

export function createEbookHandler({ store, ingest, assistant, models }) {
  const resolve = () => (typeof store === 'function' ? store() : store);
  const fail = (code, message) => ({ ok: false, error: { code, message } });

  return async function handle(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return fail('INVALID_BODY', '请求格式无效');
    }
    const action = typeof body.action === 'string' ? body.action : '';
    try {
      if (action === 'meta') {
        return { ok: true, value: { books: resolve().listBooks(), stats: resolve().stats() } };
      }
      if (action === 'book') {
        if (typeof body.id !== 'string' || !body.id) return fail('INVALID_ID', '缺少书 id');
        return { ok: true, value: resolve().getBook(body.id) };
      }
      if (action === 'chapter') {
        if (typeof body.bookId !== 'string' || !body.bookId) return fail('INVALID_ID', '缺少书 id');
        if (!Number.isFinite(Number(body.idx))) return fail('INVALID_ID', '缺少章节序号');
        return { ok: true, value: resolve().getChapter(body.bookId, Number(body.idx)) };
      }
      if (action === 'search') {
        return { ok: true, value: resolve().search(body.query, { bookId: body.bookId, limit: body.limit }) };
      }
      if (action === 'progress') {
        if (typeof body.bookId !== 'string' || !body.bookId) return fail('INVALID_ID', '缺少书 id');
        return { ok: true, value: { progress: resolve().saveProgress(body.bookId, body.idx, body.offset) } };
      }
      if (action === 'delete_book') {
        if (typeof body.id !== 'string' || !body.id) return fail('INVALID_ID', '缺少书 id');
        return { ok: true, value: resolve().deleteBook(body.id) };
      }

      // ---- 通用采集 ----
      if (action === 'models') {
        return { ok: true, value: models ? await models() : { groups: [] } };
      }
      if (action === 'import_file') {
        if (!ingest?.importFile) return fail('UNSUPPORTED', '采集能力未启用');
        if (typeof body.name !== 'string' || !body.name) return fail('INVALID_INPUT', '缺少文件名');
        return { ok: true, value: await ingest.importFile(body) };
      }
      if (action === 'import_url') {
        if (!ingest?.importUrl) return fail('UNSUPPORTED', '采集能力未启用');
        if (typeof body.url !== 'string' || !body.url.trim()) return fail('INVALID_INPUT', '缺少链接');
        return { ok: true, value: await ingest.importUrl(body) };
      }
      if (action === 'import_status') {
        if (!ingest?.importStatus) return fail('UNSUPPORTED', '采集能力未启用');
        if (typeof body.jobId !== 'string' || !body.jobId) return fail('INVALID_ID', '缺少任务 id');
        return { ok: true, value: ingest.importStatus(body.jobId) };
      }
      if (action === 'import_commit') {
        if (!ingest?.commit) return fail('UNSUPPORTED', '采集能力未启用');
        if (!body.preview || typeof body.preview !== 'object') return fail('INVALID_INPUT', '缺少预览结果');
        return { ok: true, value: ingest.commit(body.preview) };
      }

      // ---- 阅读助手 ----
      if (action === 'ask') {
        if (!assistant?.ask) return fail('UNSUPPORTED', '助手能力未启用');
        if (typeof body.bookId !== 'string' || !body.bookId) return fail('INVALID_ID', '缺少书 id');
        if (typeof body.question !== 'string' || !body.question.trim()) return fail('INVALID_INPUT', '缺少问题');
        return { ok: true, value: await assistant.ask(body.bookId, body.question) };
      }

      return fail('UNKNOWN_ACTION', `未知操作：${action || '(空)'}`);
    } catch (error) {
      return fail(error.code || 'INTERNAL', error.message || String(error));
    }
  };
}
