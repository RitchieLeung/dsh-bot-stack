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

import { PRIORITIES, STATUSES, STATUS_LABELS } from './store.js';

export function createIssueHandler({ store, start, mainBot = null, notify = null, rosterOf = null, diagnostics = null }) {
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
      // 健康检查：面板/部署脚本/急救台用它确认「这个插件现在跑的是哪份代码」。
      if (action === 'ping') {
        return { ok: true, value: {
          pong: Date.now(), plugin: 'dsh-plugin-bot-issue', pid: process.pid,
          diagnostics: typeof diagnostics === 'function' ? diagnostics() : null,
        } };
      }
      if (action === 'meta') {
        const library = resolve().tags();
        return { ok: true, value: {
          statuses: STATUSES, priorities: PRIORITIES, mainBot, counts: resolve().counts(),
          tags: library,
          /** Back-compat alias: `types` was the old name for the label library. */
          types: library,
          roster: typeof rosterOf === 'function' ? rosterOf() : [],
          versions: resolve().versions(),
          userReplies: resolve().userReplies(),
          seen: resolve().seen(),
        } };
      }
      if (action === 'list') {
        const value = resolve().list({
          status: body.status,
          parentId: body.parentId,
          type: body.type,
          priority: body.priority,
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
      // 服务端已读：支持单条详情标记，也支持从旧 localStorage 批量迁移。
      if (action === 'seen') {
        if (body.seen !== undefined) {
          if (!body.seen || typeof body.seen !== 'object' || Array.isArray(body.seen)) return fail('INVALID_SEEN', 'seen 必须是 { issueId: version }');
          return { ok: true, value: { seen: resolve().markSeenMany(body.seen) } };
        }
        if (typeof body.id !== 'string' || !body.id) return fail('INVALID_ID', '缺少 issue id');
        return { ok: true, value: { seen: resolve().markSeen(body.id, body.version) } };
      }
      if (action === 'create') {
        const issue = resolve().create({
          title: body.title,
          body: body.body,
          parentId: body.parentId,
          priority: body.priority,
          tags: body.tags !== undefined ? body.tags : body.type,
          createdBy: author.kind,
          createdByName: author.name,
        });
        // 新建说明里 @同事 也算通知（和评论一致）。
        if (typeof notify === 'function' && typeof issue.body === 'string' && issue.body.includes('@')) {
          try { await notify(issue, { body: issue.body }, null); } catch { /* mention notification is best-effort */ }
        }
        return { ok: true, value: { issue } };
      }
      if (action === 'update') {
        if (typeof body.id !== 'string' || !body.id) return fail('INVALID_ID', '缺少 issue id');
        const issue = resolve().update(body.id, {
          status: body.status,
          result: body.result,
          note: typeof body.note === 'string' ? body.note : undefined,
          opinion: typeof body.opinion === 'string' ? body.opinion : undefined,
          title: body.title,
          body: body.body,
          priority: body.priority,
          tags: body.tags,
          type: body.type,
          rejection: typeof body.rejection === 'string' ? body.rejection : undefined,
          expectedVersion: typeof body.expectedVersion === 'number' ? body.expectedVersion : undefined,
        }, author);
        // 状态推进要知会对侧：打回/验收/交结果时，通知执行人或主 Bot（面板这次之前漏了）。
        if (typeof notify === 'function' && body.status !== undefined && ['dispatched', 'in_review', 'done', 'failed'].includes(issue.status)) {
          const opinionText = [body.note, body.opinion, body.result].find(v => typeof v === 'string' && v.trim())?.trim();
          const summary = typeof body.rejection === 'string' && body.rejection.trim()
            ? `被打回重做：${body.rejection.trim()}`
            : `状态变更为「${STATUS_LABELS[issue.status] || issue.status}」${opinionText ? `：${opinionText}` : ''}`;
          try { await notify(issue, { body: summary, statusChange: true }, null); } catch { /* best-effort */ }
        }
        return { ok: true, value: { issue } };
      }
      if (action === 'assign') {
        if (typeof body.id !== 'string' || !body.id) return fail('INVALID_ID', '缺少 issue id');
        if (typeof body.sessionId !== 'string' || !body.sessionId) return fail('INVALID_ID', '缺少执行人 sessionId');
        const issue = resolve().assign(body.id, {
          sessionId: body.sessionId,
          name: typeof body.name === 'string' ? body.name : body.sessionId,
        }, { kind: 'user', name: '用户' });
        return { ok: true, value: { issue } };
      }
      if (action === 'comment') {
        if (typeof body.id !== 'string' || !body.id) return fail('INVALID_ID', '缺少 issue id');
        const issue = resolve().get(body.id);
        const replyToId = body.replyToId !== undefined ? body.replyToId : (body.replyTo !== undefined ? body.replyTo : null);
        const value = resolve().comment(body.id, {
          body: body.body,
          authorKind: author.kind,
          authorName: author.name,
          authorSessionId: typeof body.authorSessionId === 'string' ? body.authorSessionId : null,
          replyToId,
        });
        if (typeof notify === 'function') {
          try { await notify(issue, value, null); } catch { /* mention notification is best-effort */ }
        }
        return { ok: true, value: { comment: value } };
      }
      if (action === 'tag_create') {
        if (typeof body.name !== 'string' || !body.name.trim()) return fail('INVALID_TAG', '标签名不能为空');
        return { ok: true, value: { tags: resolve().createTag(body.name) } };
      }
      if (action === 'tag_delete') {
        if (typeof body.name !== 'string' || !body.name.trim()) return fail('INVALID_TAG', '标签名不能为空');
        return { ok: true, value: resolve().deleteTag(body.name) };
      }
      // 依赖：A 依赖 B（B 完成之后 A 才能完成）。后置那栏挂的是反方向，同一个动作。
      if (action === 'link' || action === 'unlink') {
        if (typeof body.id !== 'string' || !body.id) return fail('INVALID_ID', '缺少 issue id');
        if (typeof body.dependsOn !== 'string' || !body.dependsOn) return fail('INVALID_ID', '缺少 dependsOn');
        const issue = action === 'link'
          ? resolve().link(body.id, body.dependsOn)
          : resolve().unlink(body.id, body.dependsOn);
        return { ok: true, value: { issue } };
      }
      // 上传一张图（base64）→ 返回可直接塞进 markdown 的 url。
      if (action === 'upload') {
        const value = resolve().addAttachment({
          issueId: typeof body.id === 'string' && body.id ? body.id : null,
          name: body.name,
          mime: body.mime,
          data: body.data,
        });
        return { ok: true, value: { image: value } };
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
