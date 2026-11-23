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

export function createIssueHandler({ store, start, mainBot = null, notify = null, rosterOf = null, diagnostics = null, discussRoom = null }) {
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
        // 状态推进要知会对侧：验收不通过/打回/验收/交结果时，通知执行人或主 Bot（面板这次之前漏了）。
        const hasRejection = typeof body.rejection === 'string' && body.rejection.trim();
        if (typeof notify === 'function' && body.status !== undefined && (['dispatched', 'in_review', 'done', 'failed'].includes(issue.status) || hasRejection)) {
          const opinionText = [body.rejection, body.note, body.opinion, body.result].find(v => typeof v === 'string' && v.trim())?.trim() || '';
          const summary = hasRejection
            ? `验收不通过（被打回重做）：${body.rejection.trim()}`
            : `状态变更为「${STATUS_LABELS[issue.status] || issue.status}」${opinionText ? `：${opinionText}` : ''}`;
          try { await notify(issue, { body: summary, statusChange: true }, null); } catch { /* best-effort */ }
        }
        // 人为终态（已闭环 / 已取消）：若关联了临时讨论群，自动用完即焚。
        let finalIssue = issue;
        if ((issue.status === 'done' || issue.status === 'cancelled') && issue.discussionRoom?.id && typeof discussRoom?.destroy === 'function') {
          const reason = issue.status === 'done'
            ? '临时讨论群已自动销毁（验收通过，结论已沉淀在事务记录中）'
            : '临时讨论群已自动销毁（事务已取消）';
          try { finalIssue = await discussRoom.destroy(issue, reason) || resolve().get(issue.id); } catch { /* best-effort */ }
        }
        return { ok: true, value: { issue: finalIssue } };
      }
      if (action === 'discuss') {
        if (typeof body.id !== 'string' || !body.id) return fail('INVALID_ID', '缺少 issue id');
        let issue = resolve().get(body.id);
        const note = typeof body.note === 'string' ? body.note.trim() : '';
        const autoStart = body.autoStart === true;
        if (issue.status === 'open') {
          if (!note) return fail('OPINION_REQUIRED', '发起讨论必须填写讨论焦点或待澄清问题');
          issue = resolve().update(issue.id, { status: 'discussing', note }, author);
        } else if (issue.status !== 'discussing' && issue.status !== 'dispatched') {
          return fail('FORBIDDEN_TRANSITION', `当前处于「${STATUS_LABELS[issue.status] || issue.status}」，不能发起讨论群`);
        }
        if (issue.status === 'discussing') {
          issue = resolve().setDiscussionRoom(issue.id, { autoStart });
        }
        let room = issue.discussionRoom || null;
        if (!room && typeof discussRoom?.create === 'function') {
          const created = await discussRoom.create(issue, {
            members: Array.isArray(body.members) ? body.members : [],
            topic: note,
            autoStart,
          });
          if (created?.id) {
            issue = resolve().setDiscussionRoom(issue.id, { roomId: created.id, roomName: created.name || null, autoStart });
            room = issue.discussionRoom;
          }
        }
        return { ok: true, value: { issue, room } };
      }
      if (action === 'close_room') {
        if (typeof body.id !== 'string' || !body.id) return fail('INVALID_ID', '缺少 issue id');
        const issue = resolve().get(body.id);
        if (!issue.discussionRoom?.id) return { ok: true, value: { issue } };
        const updated = typeof discussRoom?.destroy === 'function'
          ? (await discussRoom.destroy(issue, '临时讨论群已手动销毁') || resolve().get(issue.id))
          : resolve().clearDiscussionRoom(issue.id, '临时讨论群已手动销毁');
        return { ok: true, value: { issue: updated } };
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
        let issue = resolve().get(body.id);
        const note = typeof body.note === 'string' ? body.note.trim() : '';
        if (issue.status === 'discussing' && note) {
          resolve().comment(issue.id, {
            body: `已确认共识并启动：${note}`,
            authorKind: author.kind,
            authorName: author.name,
            kind: 'agree',
          });
          issue = resolve().get(issue.id);
        }
        const result = await start(issue);
        return { ok: true, value: result };
      }
      return fail('UNKNOWN_ACTION', `未知操作：${action || '(空)'}`);
    } catch (error) {
      return fail(error.code || 'INTERNAL', error.message || String(error));
    }
  };
}
