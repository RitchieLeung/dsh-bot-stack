/**
 * HTTP handler for the issue board.
 *
 * Kept free of Cordis so the request/response contract is unit-testable.
 * `store` may be a store instance or a zero-argument factory returning one,
 * which lets the host open the database lazily: a missing database must not
 * stop the plugin from loading.
 *
 * `start` is the dispatch bridge (Phase 2). It receives the full issue and is
 * expected to return `{ dispatched: true, taskId }` or
 * `{ dispatched: false, reason }`; when absent the `start` action reports that
 * the bridge is not wired.
 */

import { STATUSES } from './store.js';

export function createIssueHandler({ store, start, mainBot = null, notify = null, rosterOf = null }) {
  const resolve = () => (typeof store === 'function' ? store() : store);
  const fail = (code, message) => ({ ok: false, error: { code, message } });

  return async function handle(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return fail('INVALID_BODY', '请求格式无效');
    }
    const action = typeof body.action === 'string' ? body.action : '';
    const author = {
      kind: body.authorKind === 'agent' ? 'agent' : 'user',
      name: typeof body.authorName === 'string' ? body.authorName : (body.authorKind === 'agent' ? '主 Bot' : ''),
    };
    try {
      if (action === 'meta') {
        return { ok: true, value: {
          statuses: STATUSES, mainBot, counts: resolve().counts(), types: resolve().types(),
          roster: typeof rosterOf === 'function' ? rosterOf() : [],
        } };
      }
      if (action === 'list') {
        const value = resolve().list({
          status: body.status,
          parentId: body.parentId,
          type: body.type,
          query: body.query,
          limit: body.limit,
          offset: body.offset,
        });
        return { ok: true, value };
      }
      if (action === 'get') {
        if (typeof body.id !== 'string' || !body.id) return fail('INVALID_ID', '缺少 issue id');
        return { ok: true, value: { issue: resolve().get(body.id) } };
      }
      if (action === 'create') {
        const issue = resolve().create({
          title: body.title,
          body: body.body,
          parentId: body.parentId,
          type: body.type,
          createdBy: author.kind,
          createdByName: author.name,
        });
        return { ok: true, value: { issue } };
      }
      if (action === 'update') {
        if (typeof body.id !== 'string' || !body.id) return fail('INVALID_ID', '缺少 issue id');
        const issue = resolve().update(body.id, {
          status: body.status,
          result: body.result,
          title: body.title,
          body: body.body,
          type: body.type,
          expectedVersion: typeof body.expectedVersion === 'number' ? body.expectedVersion : undefined,
        }, author);
        return { ok: true, value: { issue } };
      }
      if (action === 'comment') {
        if (typeof body.id !== 'string' || !body.id) return fail('INVALID_ID', '缺少 issue id');
        const issue = resolve().get(body.id);
        const value = resolve().comment(body.id, {
          body: body.body,
          authorKind: author.kind,
          authorName: author.name,
        });
        if (typeof notify === 'function') {
          try { await notify(issue, value, null); } catch { /* mention notification is best-effort */ }
        }
        return { ok: true, value: { comment: value } };
      }
      if (action === 'start') {
        if (typeof body.id !== 'string' || !body.id) return fail('INVALID_ID', '缺少 issue id');
        if (typeof start !== 'function') {
          return fail('DISPATCH_UNAVAILABLE', '派工桥接尚未启用');
        }
        const issue = resolve().get(body.id);
        const result = await start(issue);
        return { ok: true, value: result };
      }
      return fail('UNKNOWN_ACTION', `未知操作：${action || '(空)'}`);
    } catch (error) {
      return fail(error.code || 'INTERNAL', error.message || String(error));
    }
  };
}
