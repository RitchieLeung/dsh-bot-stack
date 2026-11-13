/**
 * Client half of the issue board (事务面板).
 *
 * A plain script served to the DSH Web GUI. It registers a sidebar entry
 * 「事务」 beside 「知识库」 and a main panel: issue list, new-issue form,
 * detail with timeline, comments and status actions.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-bot-issue',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const STATUS_LABEL = {
      open: '待处理', discussing: '讨论中', dispatched: '已派工',
      in_review: '待验收', done: '已闭环', failed: '失败', cancelled: '已取消',
    };
    const STATUS_TONE = {
      open: 'plain', discussing: 'plain', dispatched: 'info',
      in_review: 'warn', done: 'ok', failed: 'err', cancelled: 'muted',
    };
    // Actions available from each status. start = 派工（走 dispatch_work 桥接）。
    const ACTIONS = {
      open: [['start', '启动派工'], ['discussing', '标记讨论'], ['cancelled', '取消']],
      discussing: [['start', '启动派工'], ['open', '回待处理'], ['cancelled', '取消']],
      dispatched: [['cancelled', '取消']],
      in_review: [['done', '验收通过'], ['open', '打回重派'], ['cancelled', '取消']],
      done: [['open', '重开']],
      failed: [['open', '重试'], ['cancelled', '取消']],
      cancelled: [['open', '重开']],
    };

    const CSS = `
.is-root{display:flex;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px}
.is-side{width:200px;flex:none;border-right:1px solid var(--dsw-alias-border-l1);overflow:auto;padding:8px;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column}
.is-side-title{font-size:12px;color:var(--dsw-alias-label-secondary);padding:6px 8px}
.is-filter{display:block;width:100%;text-align:left;border:0;background:transparent;color:inherit;padding:7px 8px;border-radius:6px;cursor:pointer;font-size:13px}
.is-filter:hover{background:var(--dsw-alias-bg-layer-2)}
.is-filter[data-active="true"]{background:var(--dsw-alias-bg-layer-2);font-weight:600}
.is-filter-count{margin-left:auto;float:right;color:var(--dsw-alias-label-secondary);font-size:11px}
.is-new{border:1px solid var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);background:transparent;padding:6px 10px;border-radius:8px;cursor:pointer;font-size:13px;margin-top:10px}
.is-main{flex:1;min-width:0;display:flex;flex-direction:column}
.is-head{display:flex;gap:6px;align-items:center;padding:10px 16px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.is-head-title{font-weight:600;font-size:14px}
.is-body{flex:1;overflow:auto;padding:12px 16px}
.is-card{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:10px 12px;margin-bottom:10px;background:var(--dsw-alias-bg-layer-1);cursor:pointer}
.is-card:hover{border-color:var(--dsw-alias-border-l2)}
.is-card-top{display:flex;gap:8px;align-items:center;font-size:11px;color:var(--dsw-alias-label-secondary);margin-bottom:4px}
.is-card-title{font-weight:600;font-size:13px}
.is-badge{border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:1px 8px;font-size:11px;white-space:nowrap}
.is-badge[data-tone="info"]{color:var(--dsw-alias-state-info-primary);border-color:var(--dsw-alias-state-info-primary)}
.is-badge[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.is-badge[data-tone="ok"]{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.is-badge[data-tone="err"]{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.is-badge[data-tone="muted"]{color:var(--dsw-alias-label-secondary)}
.is-empty{color:var(--dsw-alias-label-secondary);padding:32px 0;text-align:center}
.is-error{margin:32px auto;max-width:520px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:8px;padding:16px}
.is-error-title{color:var(--dsw-alias-state-error-primary);font-weight:600;margin-bottom:8px}
.is-detail{font-size:11px;color:var(--dsw-alias-label-secondary);word-break:break-all;margin:8px 0}
.is-field{width:100%;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:inherit;padding:8px;border-radius:8px;font-size:13px;box-sizing:border-box;font-family:inherit}
.is-field:focus{outline:1px solid var(--dsw-alias-brand-primary)}
.is-label{font-size:12px;color:var(--dsw-alias-label-secondary);margin:12px 0 4px;display:block}
.is-btn{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:inherit;padding:4px 12px;border-radius:6px;cursor:pointer;font-size:12px;margin-right:6px}
.is-btn:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.is-btn[data-primary="true"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.is-btn:disabled{opacity:.5;cursor:default}
.is-body-text{white-space:pre-wrap;line-height:1.6;margin:8px 0}
.is-tl{border-left:2px solid var(--dsw-alias-border-l1);margin:12px 0 0 4px;padding-left:12px}
.is-tl-item{margin-bottom:10px}
.is-tl-meta{font-size:11px;color:var(--dsw-alias-label-secondary);margin-bottom:2px}
.is-tl-body{white-space:pre-wrap;line-height:1.5}
.is-note{color:var(--dsw-alias-state-success-primary);font-size:11px;margin-left:auto}
.is-err-note{color:var(--dsw-alias-state-error-primary);font-size:11px;margin-left:auto}
.is-sec{margin-top:16px;font-size:12px;color:var(--dsw-alias-label-secondary);font-weight:600}
.is-back{border:0;background:transparent;color:var(--dsw-alias-brand-primary);cursor:pointer;font-size:12px;padding:0}
`;

    async function call(action, payload) {
      const response = await fetch('/api/bot-issue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ action }, payload || {})),
      });
      let json;
      try { json = await response.json(); } catch {
        throw Object.assign(new Error(`接口返回无法解析（HTTP ${response.status}）`), { code: 'BAD_RESPONSE' });
      }
      if (!json || json.ok !== true) {
        throw Object.assign(new Error(json?.error?.message || '未知错误'), { code: json?.error?.code || 'INTERNAL' });
      }
      return json.value;
    }

    function formatTime(ms) {
      if (typeof ms !== 'number') return '时间未知';
      try { return new Date(ms).toLocaleString('zh-CN', { hour12: false }); } catch { return '时间未知'; }
    }

    function Badge({ status }) {
      return h('span', { className: 'is-badge', 'data-tone': STATUS_TONE[status] || 'plain' }, STATUS_LABEL[status] || status);
    }

    function ErrorBox({ error, onRetry }) {
      const titles = { HOST_STALE: '需要重启 dsh web', DISPATCH_UNAVAILABLE: '派工桥接尚未启用' };
      return h('div', { className: 'is-error' },
        h('div', { className: 'is-error-title' }, titles[error.code] || '操作失败'),
        h('div', { className: 'is-detail' }, error.message),
        onRetry ? h('button', { className: 'is-btn', type: 'button', onClick: onRetry }, '重试') : null);
    }

    function Icon({ size }) {
      const s = size || 16;
      return h('svg', { width: s, height: s, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('path', { d: 'M4 5.5A2.5 2.5 0 0 1 6.5 3H19v13h-8' }),
        h('path', { d: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H19' }),
        h('path', { d: 'M7 7h8M7 11h5' }));
    }

    function NewForm({ onDone, onBack }) {
      const [title, setTitle] = React.useState('');
      const [body, setBody] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);
      const submit = async () => {
        setBusy(true); setError(null);
        try {
          await call('create', { title, body, authorKind: 'user' });
          onDone();
        } catch (caught) { setError(caught); } finally { setBusy(false); }
      };
      return h('div', null,
        h('div', { className: 'is-head' },
          h('button', { className: 'is-back', type: 'button', onClick: onBack }, '← 返回'),
          h('span', { className: 'is-head-title', style: { marginLeft: 8 } }, '新建事务')),
        h('div', { className: 'is-body' },
          error ? h(ErrorBox, { error }) : null,
          h('label', { className: 'is-label' }, '标题'),
          h('input', { className: 'is-field', value: title, onChange: e => setTitle(e.target.value), placeholder: '一句话说清要做什么' }),
          h('label', { className: 'is-label' }, '说明'),
          h('textarea', { className: 'is-field', rows: 8, value: body, onChange: e => setBody(e.target.value), placeholder: '背景、要做到什么程度、验收标准…' }),
          h('div', { style: { marginTop: 14 } },
            h('button', { className: 'is-btn', 'data-primary': 'true', type: 'button', disabled: busy || !title.trim(), onClick: submit }, busy ? '创建中…' : '创建'),
            h('button', { className: 'is-btn', type: 'button', onClick: onBack }, '取消'))));
    }

    function Detail({ id, onBack, onChanged }) {
      const [issue, setIssue] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [note, setNote] = React.useState(null);
      const [comment, setComment] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [started, setStarted] = React.useState(false);

      const refresh = React.useCallback(async () => {
        setError(null);
        try { setIssue((await call('get', { id })).issue); }
        catch (caught) { setError(caught); }
      }, [id]);

      React.useEffect(() => { refresh(); }, [refresh]);

      const act = async (status) => {
        setBusy(true); setNote(null); setError(null);
        try {
          if (status === 'start') {
            const value = await call('start', { id });
            if (value?.dispatched) { setStarted(true); setNote(value.note || '已派工'); }
            else setNote(`未派工：${value?.reason || '未知原因'}`);
          } else {
            await call('update', { id, status, authorKind: 'user' });
            setNote(`已更新为「${STATUS_LABEL[status]}」`);
            onChanged?.();
          }
          await refresh();
        } catch (caught) { setError(caught); } finally { setBusy(false); }
      };

      const post = async () => {
        if (!comment.trim()) return;
        setBusy(true); setNote(null); setError(null);
        try {
          await call('comment', { id, body: comment, authorKind: 'user' });
          setComment('');
          await refresh();
        } catch (caught) { setError(caught); } finally { setBusy(false); }
      };

      if (error) return h('div', { className: 'is-root' }, h('div', { className: 'is-main' },
        h('div', { className: 'is-head' }, h('button', { className: 'is-back', type: 'button', onClick: onBack }, '← 返回')),
        h('div', { className: 'is-body' }, h(ErrorBox, { error, onRetry: refresh }))));
      if (!issue) return h('div', { className: 'is-root' }, h('div', { className: 'is-main' },
        h('div', { className: 'is-head' }, h('button', { className: 'is-back', type: 'button', onClick: onBack }, '← 返回')),
        h('div', { className: 'is-body' }, h('div', { className: 'is-empty' }, '正在读取…'))));

      const timeline = (issue.comments || []).map(c => ({ ...c, label: c.kind }));
      return h('div', { className: 'is-root' }, h('div', { className: 'is-main' },
        h('div', { className: 'is-head' },
          h('button', { className: 'is-back', type: 'button', onClick: onBack }, '← 返回'),
          h('span', { className: 'is-head-title', style: { marginLeft: 8 } }, issue.title),
          h(Badge, { status: issue.status }),
          note ? h('span', { className: 'is-note' }, note) : null),
        h('div', { className: 'is-body' },
          error ? h(ErrorBox, { error }) : null,
          h('div', { className: 'is-detail' }, `${issue.id} · 创建于 ${formatTime(issue.createdAt)} · 由 ${issue.createdByName || issue.createdBy}`),
          issue.body ? h('div', { className: 'is-body-text' }, issue.body) : h('div', { className: 'is-empty' }, '（无正文）'),
          issue.result ? h('div', { className: 'is-body-text', style: { color: 'var(--dsw-alias-state-success-primary)' } }, `结果：${issue.result}`) : null,
          h('div', { style: { margin: '12px 0' } },
            (ACTIONS[issue.status] || []).map(([status, label]) =>
              h('button', { key: status, className: 'is-btn', 'data-primary': status === 'start' || status === 'done' ? 'true' : undefined, type: 'button', disabled: busy || (status === 'start' && started), onClick: () => act(status) }, label))),
          (issue.dispatches && issue.dispatches.length) ? h('div', { className: 'is-sec' }, `派工记录（${issue.dispatches.length}）`) : null,
          (issue.dispatches || []).map(d => h('div', { key: d.id, className: 'is-detail' }, `${d.taskId} · ${STATUS_LABEL[d.status] || d.status} · ${formatTime(d.at)}`)),
          h('div', { className: 'is-sec' }, '评论与时间线'),
          h('div', { className: 'is-tl' },
            timeline.length ? timeline.map(c => h('div', { key: c.id, className: 'is-tl-item' },
              h('div', { className: 'is-tl-meta' }, `${formatTime(c.at)} · ${c.authorName || c.authorKind}${c.kind === 'status' ? '（状态）' : c.kind === 'result' ? '（结果）' : ''}`),
              h('div', { className: 'is-tl-body' }, c.body))) : h('div', { className: 'is-empty' }, '还没有评论。')),
          h('div', { className: 'is-sec' }, '写评论'),
          h('textarea', { className: 'is-field', rows: 3, value: comment, onChange: e => setComment(e.target.value), placeholder: '补充说明、结论或交接信息…' }),
          h('div', { style: { marginTop: 8 } },
            h('button', { className: 'is-btn', 'data-primary': 'true', type: 'button', disabled: busy || !comment.trim(), onClick: post }, '提交评论')))));
    }

    function Panel() {
      const [statuses, setStatuses] = React.useState(null);
      const [filter, setFilter] = React.useState('open');
      const [view, setView] = React.useState('list'); // list | new | detail
      const [detailId, setDetailId] = React.useState(null);
      const [items, setItems] = React.useState([]);
      const [error, setError] = React.useState(null);

      const refresh = React.useCallback(async () => {
        setError(null);
        try {
          const meta = await call('meta');
          setStatuses(Array.isArray(meta.statuses) ? meta.statuses : ['open']);
          const list = await call('list', { status: filter, limit: 100 });
          setItems(Array.isArray(list.items) ? list.items : []);
        } catch (caught) { setError(caught); setItems([]); }
      }, [filter]);

      React.useEffect(() => { refresh(); }, [refresh]);

      if (error && view === 'list') return h('div', { className: 'is-root' }, h('div', { className: 'is-main' },
        h('div', { className: 'is-head' }, h('span', { className: 'is-head-title' }, '事务')),
        h('div', { className: 'is-body' }, h(ErrorBox, { error, onRetry: refresh }))));

      if (view === 'new') return h(NewForm, { onDone: () => { setView('list'); refresh(); }, onBack: () => setView('list') });
      if (view === 'detail') return h(Detail, { id: detailId, onBack: () => { setView('list'); refresh(); }, onChanged: refresh });

      const filters = statuses || ['open', 'discussing', 'dispatched', 'in_review', 'done', 'failed', 'cancelled'];
      return h('div', { className: 'is-root' },
        h('div', { className: 'is-side' },
          h('div', { className: 'is-side-title' }, '按状态'),
          filters.map(s => h('button', { key: s, type: 'button', className: 'is-filter', 'data-active': String(s === filter), onClick: () => setFilter(s) },
            STATUS_LABEL[s] || s,
            h('span', { className: 'is-filter-count' }, null))),
          h('button', { className: 'is-new', type: 'button', onClick: () => setView('new') }, '＋ 新建事务')),
        h('div', { className: 'is-main' },
          h('div', { className: 'is-head' },
            h('span', { className: 'is-head-title' }, `事务（${STATUS_LABEL[filter] || filter}）`),
            h('span', { className: 'is-note' }, `${items.length} 条`)),
          h('div', { className: 'is-body' },
            items.length ? items.map(issue => h('div', { key: issue.id, className: 'is-card', onClick: () => { setDetailId(issue.id); setView('detail'); } },
              h('div', { className: 'is-card-top' },
                h(Badge, { status: issue.status }),
                h('span', null, issue.id),
                h('span', null, formatTime(issue.updatedAt))),
              h('div', { className: 'is-card-title' }, issue.title),
              issue.body ? h('div', { className: 'is-detail' }, issue.body.slice(0, 80)) : null))
              : h('div', { className: 'is-empty' }, '这个状态下还没有事务。点左上角「新建事务」开始。'))));
    }

    function apply(ctx) {
      const style = document.createElement('style');
      style.textContent = CSS;
      document.head.appendChild(style);
      ctx.effect(() => () => style.remove(), 'bot-issue: styles');
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist', id: 'bot-issue', label: () => '事务', order: 35,
      }, Icon));
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main', key: 'bot-issue',
      }, Panel));
    }

    return { inject: ['slots'], apply };
  },
});
