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
      open: '待处理', discussing: '讨论中', dispatched: '进行中',
      in_review: '待验收', done: '已闭环', failed: '失败', cancelled: '已取消',
    };
    // 每个状态一种主题色；in_review 用实心强调（它需要人动作）。
    const STATUS_META = {
      open: { color: 'var(--dsw-alias-state-idle-primary)', solid: false },
      discussing: { color: 'var(--dsw-alias-brand-primary)', solid: false },
      dispatched: { color: 'var(--dsw-alias-state-warn-primary)', solid: false },
      in_review: { color: 'var(--dsw-alias-state-warn-primary)', solid: true },
      done: { color: 'var(--dsw-alias-state-success-primary)', solid: false },
      failed: { color: 'var(--dsw-alias-state-error-primary)', solid: false },
      cancelled: { color: 'var(--dsw-alias-state-idle-primary)', solid: false },
    };
    // Actions available from each status. start = 派工（走 dispatch_work 桥接）。
    const ACTIONS = {
      open: [['start', '启动'], ['discussing', '标记讨论'], ['cancelled', '取消']],
      discussing: [['start', '启动'], ['open', '回待处理'], ['cancelled', '取消']],
      dispatched: [['open', '打回待处理'], ['cancelled', '取消']],
      in_review: [['done', '验收通过'], ['open', '打回重派'], ['cancelled', '取消']],
      done: [['open', '重开']],
      failed: [['open', '重试'], ['cancelled', '取消']],
      cancelled: [['open', '重开']],
    };

    const CSS = `
.is-root{display:flex;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;-webkit-font-smoothing:antialiased}
.is-side{width:216px;flex:none;border-right:1px solid var(--dsw-alias-border-l1);overflow:auto;padding:14px 10px;background:var(--dsw-specific-sidebar-fill);display:flex;flex-direction:column}
.is-side-title{font-size:11px;font-weight:700;letter-spacing:.04em;color:var(--dsw-alias-label-secondary);padding:2px 8px 8px;text-transform:uppercase}
.is-new{display:flex;align-items:center;justify-content:center;gap:6px;border:0;color:#fff;background:var(--dsw-alias-brand-primary);padding:8px 12px;border-radius:9px;cursor:pointer;font-size:13px;font-weight:600;margin:0 2px 14px;box-shadow:0 1px 2px color-mix(in srgb, var(--dsw-alias-brand-primary) 30%, transparent)}
.is-new:hover{filter:brightness(1.06)}
.is-new:active{filter:brightness(.96)}
.is-filter{display:flex;align-items:center;gap:8px;width:100%;text-align:left;border:0;background:transparent;color:var(--dsw-alias-label-primary);padding:7px 8px;border-radius:8px;cursor:pointer;font-size:13px}
.is-filter:hover{background:var(--dsw-alias-bg-layer-2)}
.is-filter[data-active="true"]{background:var(--dsw-alias-bg-layer-2);font-weight:600}
.is-filter-dot{width:7px;height:7px;border-radius:50%;flex:none}
.is-filter-count{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border-radius:999px;padding:0 7px;line-height:18px;font-variant-numeric:tabular-nums}
.is-filter[data-active="true"] .is-filter-count{background:var(--dsw-alias-brand-primary);color:#fff}
.is-main{flex:1;min-width:0;display:flex;flex-direction:column}
.is-head{display:flex;gap:10px;align-items:center;padding:14px 20px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.is-head-title{font-weight:700;font-size:15px}
.is-head-count{font-size:12px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:1px 9px;line-height:18px}
.is-body{flex:1;overflow:auto;padding:16px 20px 24px}
.is-card{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:12px 14px;margin-bottom:10px;background:var(--dsw-alias-bg-layer-1);cursor:pointer;transition:border-color .12s,box-shadow .12s,transform .12s}
.is-card:hover{border-color:var(--dsw-alias-border-l2);box-shadow:0 4px 14px color-mix(in srgb, #000 8%, transparent);transform:translateY(-1px)}
.is-card-top{display:flex;gap:8px;align-items:center;font-size:11px;color:var(--dsw-alias-label-secondary);margin-bottom:6px}
.is-card-id{font-variant-numeric:tabular-nums}
.is-card-time{margin-left:auto}
.is-card-title{font-weight:600;font-size:13.5px;line-height:1.4}
.is-card-body{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:4px;line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.is-badge{display:inline-flex;align-items:center;gap:5px;border-radius:999px;padding:2px 9px;font-size:11px;font-weight:600;line-height:1.6;white-space:nowrap;background:color-mix(in srgb, var(--sc) 12%, transparent);color:var(--sc)}
.is-badge-dot{width:6px;height:6px;border-radius:50%;background:var(--sc);flex:none}
.is-badge[data-solid="true"]{background:var(--sc);color:#fff}
.is-badge[data-solid="true"] .is-badge-dot{background:rgba(255,255,255,.9)}
.is-empty{color:var(--dsw-alias-label-secondary);padding:48px 0;text-align:center;font-size:13px}
.is-empty-hint{font-size:12px;opacity:.75;margin-top:6px}
.is-error{margin:32px auto;max-width:520px;border:1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, transparent);background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent);border-radius:12px;padding:16px}
.is-error-title{color:var(--dsw-alias-state-error-primary);font-weight:700;margin-bottom:8px;font-size:13px}
.is-detail{font-size:11px;color:var(--dsw-alias-label-secondary);word-break:break-all;margin:8px 0;line-height:1.5}
.is-field{width:100%;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:9px 11px;border-radius:9px;font-size:13px;box-sizing:border-box;font-family:inherit;line-height:1.5}
.is-field:focus{outline:0;border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary) 16%, transparent)}
.is-label{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);margin:14px 0 6px;display:block}
.is-btn{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);padding:6px 14px;border-radius:8px;cursor:pointer;font-size:12.5px;font-weight:500;margin-right:8px;transition:filter .1s}
.is-btn:hover{filter:brightness(.96);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.is-btn:disabled{opacity:.45;cursor:default}
.is-btn[data-kind="primary"]{border-color:transparent;background:var(--dsw-alias-brand-primary);color:#fff;font-weight:600}
.is-btn[data-kind="primary"]:hover{filter:brightness(1.08);color:#fff}
.is-btn[data-kind="danger"]{border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, transparent);color:var(--dsw-alias-state-error-primary)}
.is-btn[data-kind="danger"]:hover{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.is-body-text{white-space:pre-wrap;line-height:1.7;margin:10px 0;font-size:13px}
.is-result{margin:12px 0;padding:11px 14px;border-radius:10px;background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 9%, transparent);border:1px solid color-mix(in srgb, var(--dsw-alias-state-success-primary) 22%, transparent)}
.is-result-label{font-size:11px;font-weight:700;color:var(--dsw-alias-state-success-primary);margin-bottom:4px;letter-spacing:.02em}
.is-result-text{white-space:pre-wrap;line-height:1.6;font-size:13px}
.is-sec{margin-top:20px;font-size:12px;font-weight:700;color:var(--dsw-alias-label-secondary);letter-spacing:.02em}
.is-tl{position:relative;margin:12px 0 0;padding-left:18px}
.is-tl::before{content:"";position:absolute;left:4px;top:5px;bottom:5px;width:1px;background:var(--dsw-alias-border-l1)}
.is-tl-item{position:relative;margin-bottom:14px}
.is-tl-item::before{content:"";position:absolute;left:-18px;top:5px;width:9px;height:9px;border-radius:50%;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2)}
.is-tl-meta{font-size:11px;color:var(--dsw-alias-label-secondary);margin-bottom:3px}
.is-tl-kind{display:inline-block;margin-left:6px;font-size:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:4px;padding:0 4px;line-height:14px;vertical-align:1px}
.is-tl-body{white-space:pre-wrap;line-height:1.6;font-size:13px}
.is-note{color:var(--dsw-alias-state-success-primary);font-size:12px;margin-left:auto}
.is-back{border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:13px;padding:4px 6px;border-radius:6px;display:inline-flex;align-items:center;gap:2px}
.is-back:hover{color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2)}
.is-actions{margin:14px 0;display:flex;flex-wrap:wrap;gap:0}
.is-form{max-width:640px}
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

    function statusColor(status) {
      return (STATUS_META[status] || STATUS_META.open).color;
    }

    function Badge({ status }) {
      const meta = STATUS_META[status] || STATUS_META.open;
      return h('span', { className: 'is-badge', 'data-solid': String(meta.solid), style: { '--sc': meta.color } },
        h('span', { className: 'is-badge-dot' }),
        STATUS_LABEL[status] || status);
    }

    function actionKind(status) {
      if (status === 'start' || status === 'done') return 'primary';
      if (status === 'cancelled') return 'danger';
      return 'secondary';
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
      return h('svg', { width: s, height: s, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' },
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
      return h('div', { className: 'is-root' }, h('div', { className: 'is-main' },
        h('div', { className: 'is-head' },
          h('button', { className: 'is-back', type: 'button', onClick: onBack }, '← 返回'),
          h('span', { className: 'is-head-title' }, '新建事务')),
        h('div', { className: 'is-body' },
          h('div', { className: 'is-form' },
            error ? h(ErrorBox, { error }) : null,
            h('label', { className: 'is-label' }, '标题'),
            h('input', { className: 'is-field', value: title, onChange: e => setTitle(e.target.value), placeholder: '一句话说清要做什么' }),
            h('label', { className: 'is-label' }, '说明'),
            h('textarea', { className: 'is-field', rows: 8, value: body, onChange: e => setBody(e.target.value), placeholder: '背景、要做到什么程度、验收标准…' }),
            h('div', { style: { marginTop: 16 } },
              h('button', { className: 'is-btn', 'data-kind': 'primary', type: 'button', disabled: busy || !title.trim(), onClick: submit }, busy ? '创建中…' : '创建'),
              h('button', { className: 'is-btn', type: 'button', onClick: onBack }, '取消'))))));
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
            if (value?.dispatched) { setStarted(true); setNote(value.note || '已交给主 Bot'); }
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

      const head = onBack => h('div', { className: 'is-head' },
        h('button', { className: 'is-back', type: 'button', onClick: onBack }, '← 返回'));

      if (error) return h('div', { className: 'is-root' }, h('div', { className: 'is-main' },
        head(onBack),
        h('div', { className: 'is-body' }, h(ErrorBox, { error, onRetry: refresh }))));
      if (!issue) return h('div', { className: 'is-root' }, h('div', { className: 'is-main' },
        head(onBack),
        h('div', { className: 'is-body' }, h('div', { className: 'is-empty' }, '正在读取…'))));

      const timeline = issue.comments || [];
      return h('div', { className: 'is-root' }, h('div', { className: 'is-main' },
        h('div', { className: 'is-head' },
          h('button', { className: 'is-back', type: 'button', onClick: onBack }, '← 返回'),
          h('span', { className: 'is-head-title' }, issue.title),
          h(Badge, { status: issue.status }),
          note ? h('span', { className: 'is-note' }, note) : null),
        h('div', { className: 'is-body' },
          error ? h(ErrorBox, { error }) : null,
          h('div', { className: 'is-detail' }, `${issue.id} · 创建于 ${formatTime(issue.createdAt)} · 由 ${issue.createdByName || issue.createdBy}`),
          issue.body ? h('div', { className: 'is-body-text' }, issue.body) : h('div', { className: 'is-empty' }, '（无正文）'),
          issue.result ? h('div', { className: 'is-result' },
            h('div', { className: 'is-result-label' }, '闭环结果'),
            h('div', { className: 'is-result-text' }, issue.result)) : null,
          h('div', { className: 'is-actions' },
            (ACTIONS[issue.status] || []).map(([status, label]) =>
              h('button', { key: status, className: 'is-btn', 'data-kind': actionKind(status), type: 'button', disabled: busy || (status === 'start' && started), onClick: () => act(status) }, label))),
          (issue.dispatches && issue.dispatches.length) ? h('div', { className: 'is-sec' }, `派工记录（${issue.dispatches.length}）`) : null,
          (issue.dispatches || []).map(d => h('div', { key: d.id, className: 'is-detail' }, `${d.taskId} · ${STATUS_LABEL[d.status] || d.status} · ${formatTime(d.at)}`)),
          h('div', { className: 'is-sec' }, '评论与时间线'),
          h('div', { className: 'is-tl' },
            timeline.length ? timeline.map(c => h('div', { key: c.id, className: 'is-tl-item' },
              h('div', { className: 'is-tl-meta' },
                `${formatTime(c.at)} · ${c.authorName || c.authorKind}`,
                c.kind !== 'comment' ? h('span', { className: 'is-tl-kind' }, c.kind === 'status' ? '状态' : c.kind === 'result' ? '结果' : c.kind) : null),
              h('div', { className: 'is-tl-body' }, c.body))) : h('div', { className: 'is-empty' }, '还没有评论。')),
          h('div', { className: 'is-sec' }, '写评论'),
          h('textarea', { className: 'is-field', rows: 3, value: comment, onChange: e => setComment(e.target.value), placeholder: '补充说明、结论或交接信息…' }),
          h('div', { style: { marginTop: 10 } },
            h('button', { className: 'is-btn', 'data-kind': 'primary', type: 'button', disabled: busy || !comment.trim(), onClick: post }, '提交评论')))));
    }

    function Panel() {
      const [statuses, setStatuses] = React.useState(null);
      const [counts, setCounts] = React.useState({});
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
          let c = meta.counts && typeof meta.counts === 'object' ? meta.counts : null;
          if (!c || Object.keys(c).length === 0) {
            // 兜底：host 旧版本还不返回 counts 时，自己拉全量列表算计数。
            const all = await call('list', { limit: 1000 });
            c = {};
            for (const issue of (all.items || [])) c[issue.status] = (c[issue.status] || 0) + 1;
          }
          setCounts(c);
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
          h('button', { className: 'is-new', type: 'button', onClick: () => setView('new') },
            h('span', null, '＋'), h('span', null, '新建事务')),
          h('div', { className: 'is-side-title' }, '状态'),
          filters.map(s => h('button', { key: s, type: 'button', className: 'is-filter', 'data-active': String(s === filter), onClick: () => setFilter(s) },
            h('span', { className: 'is-filter-dot', style: { background: statusColor(s) } }),
            h('span', null, STATUS_LABEL[s] || s),
            h('span', { className: 'is-filter-count' }, String(counts[s] || 0))))),
        h('div', { className: 'is-main' },
          h('div', { className: 'is-head' },
            h('span', { className: 'is-head-title' }, STATUS_LABEL[filter] || filter),
            h('span', { className: 'is-head-count' }, `${items.length} 条`)),
          h('div', { className: 'is-body' },
            items.length ? items.map(issue => h('div', { key: issue.id, className: 'is-card', onClick: () => { setDetailId(issue.id); setView('detail'); } },
              h('div', { className: 'is-card-top' },
                h(Badge, { status: issue.status }),
                h('span', { className: 'is-card-id' }, issue.id),
                h('span', { className: 'is-card-time' }, formatTime(issue.updatedAt))),
              h('div', { className: 'is-card-title' }, issue.title),
              issue.body ? h('div', { className: 'is-card-body' }, issue.body) : null))
              : h('div', { className: 'is-empty' },
                '这个状态下还没有事务。',
                h('div', { className: 'is-empty-hint' }, '点左侧「新建事务」开始，或换个状态看看。')))));
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
