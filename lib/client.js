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
    // 聊天里点 #N 后、事务面板挂载前，先记下要打开的编号。
    let pendingOpen = null;

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
.is-mention{color:var(--dsw-alias-brand-primary);font-weight:600}
.is-mfield{position:relative}
.is-mmenu{position:absolute;left:0;right:0;top:calc(100% - 1px);z-index:30;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:9px;box-shadow:0 12px 30px color-mix(in srgb, #000 20%, transparent);padding:4px;max-height:216px;overflow:auto}
.is-mitem{display:flex;align-items:center;gap:8px;width:100%;border:0;background:transparent;color:var(--dsw-alias-label-primary);text-align:left;padding:6px 9px;border-radius:7px;cursor:pointer;font-size:13px;font-family:inherit}
.is-mitem[data-active="true"],.is-mitem:hover{background:var(--dsw-alias-brand-primary);color:#fff}
.is-mitem-name{font-weight:600}
.is-mitem-id{margin-left:auto;font-size:11px;opacity:.6}
.is-tagrow{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.is-tag{display:inline-flex;align-items:center;gap:3px;border:1px solid var(--dsw-alias-border-l1);background:transparent;border-radius:999px;padding:2px 8px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer;user-select:none;transition:border-color .1s,color .1s}
.is-tag:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.is-tag[data-active="true"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);background:color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent);font-weight:600}
.is-tag-del{display:none;border:0;background:transparent;color:inherit;cursor:pointer;font-size:12px;line-height:1;padding:0 0 0 1px;opacity:.65}
.is-tag:hover .is-tag-del{display:inline-block}
.is-tag-del:hover{opacity:1;color:var(--dsw-alias-state-error-primary)}
.is-taginput{border:1px dashed var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:999px;padding:3px 10px;font-size:12px;font-family:inherit;min-width:110px}
.is-taginput:focus{outline:0;border-style:solid;border-color:var(--dsw-alias-brand-primary)}
.is-tag-hint{font-size:11px;color:var(--dsw-alias-label-secondary);opacity:.7;margin-top:6px}
.is-deps{display:flex;flex-direction:column;gap:14px;max-width:640px}
.is-dep-head{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-bottom:6px}
.is-dep{display:flex;align-items:center;gap:8px;font-size:12.5px;padding:5px 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);margin-bottom:5px}
.is-dep-ref{font-weight:700;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);flex:none}
.is-dep-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.is-dep-status{font-size:11px;color:var(--dsw-alias-state-warn-primary);flex:none}
.is-dep-status[data-done="true"]{color:var(--dsw-alias-state-success-primary)}
.is-dep-x{border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:13px;padding:0 2px;flex:none}
.is-dep-x:hover{color:var(--dsw-alias-state-error-primary)}
.is-dep-empty{font-size:12px;color:var(--dsw-alias-label-secondary);opacity:.7;margin-bottom:5px}
.is-dep-add{position:relative}
.is-dep-hint{font-size:11px;color:var(--dsw-alias-label-secondary);opacity:.75;margin-top:5px}
.is-dep-input{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 10px;font-size:12.5px;font-family:inherit}
.is-dep-input:focus{outline:0;border-color:var(--dsw-alias-brand-primary)}
.is-dep-addbtn{border:1px dashed var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:8px;padding:4px 10px;font-size:12px;cursor:pointer}
.is-dep-addbtn:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.is-blocked{font-size:12px;color:var(--dsw-alias-state-warn-primary);margin:8px 0 0}
.is-card-tags{display:flex;flex-wrap:wrap;gap:5px;margin-top:6px}
.is-note{color:var(--dsw-alias-state-success-primary);font-size:12px;margin-left:auto}
.is-back{border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:13px;padding:4px 6px;border-radius:6px;display:inline-flex;align-items:center;gap:2px}
.is-back:hover{color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2)}
.is-actions{margin:14px 0;display:flex;flex-wrap:wrap;gap:0}
.is-form{max-width:640px}
.is-type-tag{display:inline-block;font-size:10.5px;font-weight:600;color:var(--dsw-alias-brand-primary);background:color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent);border-radius:6px;padding:1px 7px;line-height:16px;white-space:nowrap}
.is-card-actions{display:flex;justify-content:flex-end;margin-top:8px}
.is-btn-sm{padding:4px 12px;font-size:12px;margin-right:0}
.is-type-row{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.is-chip{border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:999px;padding:3px 10px;font-size:12px;cursor:pointer}
.is-chip:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.is-chip[data-active="true"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);background:color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent)}
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

    function authorLabel(c) {
      if (c.authorKind === 'user') return '我';
      if (c.authorKind === 'system') return c.authorName || '系统';
      return c.authorName || 'Bot';
    }

    // 历史状态评论存的是变量名（dispatched → in_review），显示时翻成人话。
    // 新写入的评论已经在 host 侧写中文，这里只是给老数据兜底。
    const STATUS_WORD_RE = /\b(open|discussing|dispatched|in_review|done|failed|cancelled)\b/g;
    function localizeStatusText(text) {
      if (typeof text !== 'string' || !text) return text;
      return text.replace(STATUS_WORD_RE, word => STATUS_LABEL[word] || word);
    }

    // 把评论里的 @同事 高亮出来（真正的通知由 host 在写入时 prompt 该同事）。
    function renderMentions(text, roster) {
      if (typeof text !== 'string' || !text.includes('@')) return text;
      const names = (roster || []).map(bot => bot.name).filter(Boolean).sort((a, b) => b.length - a.length);
      if (!names.length) return text;
      const nodes = [];
      let cursor = 0;
      let key = 0;
      for (let at = text.indexOf('@'); at !== -1; at = text.indexOf('@', at + 1)) {
        const hit = names.find(name => text.startsWith(name, at + 1));
        if (!hit) continue;
        if (at > cursor) nodes.push(text.slice(cursor, at));
        nodes.push(h('span', { key: key++, className: 'is-mention' }, `@${hit}`));
        cursor = at + 1 + hit.length;
        at = cursor - 1;
      }
      if (!nodes.length) return text;
      if (cursor < text.length) nodes.push(text.slice(cursor));
      return nodes;
    }

    // 光标前正在输入的 @token（行首或空白/标点后开始，中间不含空格）。
    const MENTION_RE = /(^|[\s,.;:!?()[\]{}<>"'`，。；：！？、（）【】「」《》])(@[^\s@]{0,20})$/;

    function mentionMenuItems(names, query) {
      const q = query.toLowerCase();
      const hits = names.filter(name => name.toLowerCase().includes(q));
      // 前缀命中的排前面，短的优先（@小 更容易先出「小欣」）。
      hits.sort((a, b) => {
        const pa = a.toLowerCase().startsWith(q) ? 0 : 1;
        const pb = b.toLowerCase().startsWith(q) ? 0 : 1;
        return pa - pb || a.length - b.length || a.localeCompare(b);
      });
      return hits.slice(0, 8);
    }

    /**
     * 评论框：textarea + @同事 候选弹层。
     * 面板里的输入框是普通的 textarea，不在 dsh 的输入补全管线里，
     * 所以这里自己实现：打 @ 弹候选，↑↓ 选、Enter/Tab 插入、Esc 关掉。
     */
    function MentionField({ value, onChange, roster, rows, placeholder }) {
      const ref = React.useRef(null);
      const menuRef = React.useRef(null);
      const composing = React.useRef(false);
      const [menu, setMenu] = React.useState(null); // { at, query, items, active }
      const names = React.useMemo(
        () => (roster || []).map(bot => bot.name).filter(Boolean).filter((name, i, all) => all.indexOf(name) === i),
        [roster]);

      const scan = (el) => {
        if (composing.current) return;
        const caret = el.selectionStart ?? el.value.length;
        const matched = MENTION_RE.exec(el.value.slice(0, caret));
        if (!matched) { setMenu(null); return; }
        const query = matched[2].slice(1);
        const items = mentionMenuItems(names, query);
        if (!items.length) { setMenu(null); return; }
        // 评论框常在面板底部，下面放不下就往上翻，否则会被滚动容器裁掉。
        const rect = el.getBoundingClientRect();
        const up = (window.innerHeight - rect.bottom) < 230;
        const at = caret - matched[2].length;
        // 同一个 @token 上重复 scan（onSelect/onKeyUp 会反复触发）时保留键盘选中项，
        // 否则按 ↓ 后立刻被重置回第一条。
        setMenu(prev => ({
          at, query, items, up,
          active: prev && prev.at === at && prev.query === query ? Math.min(prev.active, items.length - 1) : 0,
        }));
      };

      const pick = (name) => {
        const el = ref.current;
        if (!el || !menu) return;
        const caret = el.selectionStart ?? el.value.length;
        const insert = `@${name} `;
        const next = el.value.slice(0, menu.at) + insert + el.value.slice(caret);
        const pos = menu.at + insert.length;
        setMenu(null);
        onChange(next);
        // 等 React 把新值写回 textarea 再放光标，否则会被重置到末尾。
        requestAnimationFrame(() => {
          el.focus();
          try { el.setSelectionRange(pos, pos); } catch { /* ignore */ }
        });
      };

      const onKeyDown = (event) => {
        if (!menu || composing.current || event.isComposing) return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const step = event.key === 'ArrowDown' ? 1 : -1;
          setMenu(m => ({ ...m, active: (m.active + step + m.items.length) % m.items.length }));
          return;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          event.preventDefault();
          pick(menu.items[menu.active]);
          return;
        }
        if (event.key === 'Escape') { event.preventDefault(); setMenu(null); }
      };

      // 候选弹层滚动跟随键盘选中项。
      React.useEffect(() => {
        const box = menuRef.current;
        if (!box || !menu) return;
        const row = box.children[menu.active];
        row?.scrollIntoView?.({ block: 'nearest' });
      }, [menu]);

      return h('div', { className: 'is-mfield' },
        h('textarea', {
          ref, className: 'is-field', rows: rows || 3, value,
          placeholder: placeholder || '',
          onChange: e => { onChange(e.target.value); scan(e.target); },
          onKeyDown,
          onCompositionStart: () => { composing.current = true; },
          onCompositionEnd: e => { composing.current = false; scan(e.target); },
          onKeyUp: () => { if (!menu && ref.current) scan(ref.current); },
          onSelect: () => { if (ref.current) scan(ref.current); },
          onBlur: () => setTimeout(() => setMenu(null), 120),
        }),
        menu ? h('div', { className: 'is-mmenu', ref: menuRef, style: menu.up ? { top: 'auto', bottom: 'calc(100% - 1px)' } : null },
          menu.items.map((name, index) => h('button', {
            key: name, type: 'button', className: 'is-mitem',
            'data-active': String(index === menu.active),
            onMouseEnter: () => setMenu(m => (m ? { ...m, active: index } : m)),
            onMouseDown: e => { e.preventDefault(); pick(name); },
          },
            h('span', { className: 'is-mitem-name' }, `@${name}`),
            h('span', { className: 'is-mitem-id' }, '同事')))) : null);
    }

    /**
     * 标签条：库里的标签点一下选中/取消，悬停 chip 右边的 × 从标签库删除
     * （会问一次——删库会把它从所有事务上摘掉）。输入框里回车 = 新建并选中。
     */
    function TagPicker({ value, library, onChange, onCreate, onDelete }) {
      const [draft, setDraft] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const selected = value || [];
      const toggle = (name) => onChange(selected.includes(name) ? selected.filter(tag => tag !== name) : [...selected, name]);
      const commit = async () => {
        const name = draft.trim().slice(0, 40);
        if (!name || busy) return;
        setBusy(true);
        try {
          if (!(library || []).includes(name)) await onCreate?.(name);
          if (!selected.includes(name)) onChange([...selected, name]);
          setDraft('');
        } finally { setBusy(false); }
      };
      const drop = async (name) => {
        const used = selected.includes(name);
        const question = `从标签库删除「${name}」？${used ? '\n\n本事务上的这个标签也会被摘掉。' : '\n\n用到它的事务都会失去这个标签。'}`;
        if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(question)) return;
        await onDelete?.(name);
        if (used) onChange(selected.filter(tag => tag !== name));
      };
      return h('div', null,
        h('div', { className: 'is-tagrow' },
          (library || []).map(name => h('span', {
            key: name, className: 'is-tag', 'data-active': String(selected.includes(name)),
            title: selected.includes(name) ? '点一下取消' : '点一下选中',
            onClick: () => toggle(name),
          },
            name,
            h('button', {
              type: 'button', className: 'is-tag-del', title: '从标签库删除',
              onClick: event => { event.stopPropagation(); drop(name); },
            }, '×'))),
          h('input', {
            className: 'is-taginput', value: draft, disabled: busy,
            placeholder: '＋ 新标签，回车创建',
            onChange: event => setDraft(event.target.value),
            onKeyDown: event => {
              if (event.key === 'Enter') { event.preventDefault(); commit(); }
              else if (event.key === 'Escape') setDraft('');
            },
          })),
        h('div', { className: 'is-tag-hint' }, '点标签选中/取消；悬停标签右边的 × 从标签库删除（会问一次）'));
    }

    /** 依赖选择器：打 #编号或标题关键词，回车/点击挂上前一条。 */
    /** 还在流转中的状态；`done/failed/cancelled` 算收尾（闭环/结束）。 */
    const ACTIVE_STATUSES = ['open', 'discussing', 'dispatched', 'in_review'];

    /**
     * 依赖候选过滤。
     *
     * - 空输入或单个 `#` → 全部候选（不用先打字）
     * - `#3` → 按编号前缀；其他 → 标题/标签关键词
     * - `openOnly`：「后置」那栏要的——已闭环/已取消的事务不可能再「等我完成」，
     *   列出来就是坑（服务端也会用 ISSUE_CLOSED 拒绝），所以直接不列
     * - 排序：还在流转的排前面，收尾的排后面
     */
    function filterIssueCandidates(pool, query, exclude, options = {}) {
      const skip = new Set(exclude || []);
      let candidates = (pool || []).filter(item => !skip.has(item.id));
      if (options.openOnly) candidates = candidates.filter(item => ACTIVE_STATUSES.includes(item.status));
      const text = String(query || '').trim();
      let matched = candidates;
      let byNumber = false;
      if (text && text !== '#') {
        if (text.startsWith('#')) {
          const digits = text.slice(1).trim();
          if (digits) {
            // 打 '#2' 就是想要 #2、#21 这种，按编号大小排，不要被状态排序打乱
            matched = candidates.filter(item => String(item.number || '').startsWith(digits));
            byNumber = true;
          }
        } else {
          const keyword = text.toLowerCase();
          matched = candidates.filter(item => String(item.title || '').toLowerCase().includes(keyword)
            || String(item.type || '').toLowerCase().includes(keyword));
        }
      }
      const closing = item => (ACTIVE_STATUSES.includes(item.status) ? 0 : 1);
      const compare = byNumber
        ? (a, b) => (Number(a.number) || 0) - (Number(b.number) || 0)
        : (a, b) => closing(a) - closing(b) || (Number(a.number) || 0) - (Number(b.number) || 0);
      return matched.slice().sort(compare).slice(0, 8);
    }

    /**
     * 依赖选择器：打开就列候选（不用先打字），
     * 打 `#` 只剩编号、打 `#3` 按编号前缀过滤、打别的词按标题过滤。
     * 之前是「空输入不查、且把 #3 当标题去 LIKE」，所以打 # 什么也出不来。
     */
    function DepPicker({ mode, exclude, onPick, onCancel }) {
      const [query, setQuery] = React.useState('');
      const [all, setAll] = React.useState([]);
      const [active, setActive] = React.useState(0);
      const [error, setError] = React.useState(null);
      const excludeKey = (exclude || []).join(',');

      React.useEffect(() => {
        let alive = true;
        (async () => {
          try {
            const list = await call('list', { limit: 500 });
            if (alive) setAll(Array.isArray(list.items) ? list.items : []);
          } catch (caught) {
            if (alive) { setAll([]); setError(caught); }
          }
        })();
        return () => { alive = false; };
      }, []);

      const items = React.useMemo(
        () => filterIssueCandidates(all, query, excludeKey ? excludeKey.split(',') : [], { openOnly: mode === 'blocks' }),
        [all, query, excludeKey, mode]);

      React.useEffect(() => { setActive(0); }, [query]);

      const pick = (item) => { if (item) onPick(item); };
      const placeholder = mode === 'dependsOn'
        ? '加前置：直接回车选第一条，或打 #编号 / 标题关键词'
        : '加后置：直接回车选第一条，或打 #编号 / 标题关键词';

      return h('div', { className: 'is-dep-add' },
        h('input', {
          className: 'is-dep-input', autoFocus: true, value: query, placeholder,
          onChange: event => setQuery(event.target.value),
          onKeyDown: event => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              const step = event.key === 'ArrowDown' ? 1 : -1;
              setActive(index => (index + step + Math.max(1, items.length)) % Math.max(1, items.length));
            } else if (event.key === 'Enter') { event.preventDefault(); pick(items[active]); }
            else if (event.key === 'Escape') { event.preventDefault(); onCancel?.(); }
          },
        }),
        items.length
          ? h('div', { className: 'is-mmenu', style: { top: 'calc(100% + 2px)' } },
            items.map((item, index) => h('button', {
              key: item.id, type: 'button', className: 'is-mitem', 'data-active': String(index === active),
              onMouseEnter: () => setActive(index),
              onMouseDown: event => { event.preventDefault(); pick(item); },
            },
              h('span', { className: 'is-mitem-name' }, item.number ? `#${item.number}` : item.id),
              h('span', { style: { opacity: .75, marginLeft: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.title),
              h('span', { className: 'is-mitem-id' }, STATUS_LABEL[item.status] || item.status))))
          : h('div', { className: 'is-dep-hint' },
            error
              ? `读取事务失败：${error.message}`
              : mode === 'blocks'
                ? (all.length ? '没有可选的：已闭环/已取消的事务不可能再「等本事务完成」，所以不在候选里' : '还没有别的事务可以依赖')
                : (all.length ? '没有可选的（已挂上的、本事务自己都排除掉了）' : '还没有别的事务可以依赖')),
        h('div', { className: 'is-dep-hint' }, 'Esc 取消'));
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

    function NewForm({ onDone, onBack, tags, onCreateTag, onDeleteTag, roster }) {
      const [title, setTitle] = React.useState('');
      const [body, setBody] = React.useState('');
      const [chosen, setChosen] = React.useState([]);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);
      const submit = async () => {
        setBusy(true); setError(null);
        try {
          await call('create', { title, body, tags: chosen, authorKind: 'user' });
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
            h('label', { className: 'is-label' }, '标签'),
            h(TagPicker, { value: chosen, library: tags, onChange: setChosen, onCreate: onCreateTag, onDelete: onDeleteTag }),
            h('label', { className: 'is-label' }, '说明'),
            h(MentionField, { rows: 8, value: body, onChange: setBody, roster, placeholder: '背景、要做到什么程度、验收标准…（@同事 会通知他）' }),
            h('div', { style: { marginTop: 16 } },
              h('button', { className: 'is-btn', 'data-kind': 'primary', type: 'button', disabled: busy || !title.trim(), onClick: submit }, busy ? '创建中…' : '创建'),
              h('button', { className: 'is-btn', type: 'button', onClick: onBack }, '取消'))))));
    }

    function Detail({ id, onBack, onChanged, roster, tags, onCreateTag, onDeleteTag }) {
      const [issue, setIssue] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [note, setNote] = React.useState(null);
      const [comment, setComment] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [started, setStarted] = React.useState(false);
      const [depMode, setDepMode] = React.useState(null); // null | 'dependsOn' | 'blocks'
      const [depBusy, setDepBusy] = React.useState(false);

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

      const saveTags = async (next) => {
        setBusy(true); setError(null);
        try {
          await call('update', { id, tags: next, authorKind: 'user' });
          await refresh();
          onChanged?.();
        } catch (caught) { setError(caught); } finally { setBusy(false); }
      };

      const dropTag = async (name) => {
        try {
          await onDeleteTag?.(name);
          await refresh();
          onChanged?.();
        } catch (caught) { setError(caught); }
      };

      const addDep = async (other) => {
        setDepBusy(true); setError(null);
        try {
          await call('link', depMode === 'dependsOn' ? { id, dependsOn: other.id } : { id: other.id, dependsOn: id });
          setDepMode(null);
          await refresh();
          onChanged?.();
        } catch (caught) { setError(caught); } finally { setDepBusy(false); }
      };

      const removeDep = async (dep, side) => {
        setDepBusy(true); setError(null);
        try {
          await call('unlink', side === 'dependsOn' ? { id, dependsOn: dep.id } : { id: dep.id, dependsOn: id });
          await refresh();
          onChanged?.();
        } catch (caught) { setError(caught); } finally { setDepBusy(false); }
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
      const blocking = (issue.dependsOn || []).filter(dep => dep.status !== 'done');

      const depRow = (dep, side) => h('div', { key: `${side}:${dep.id}`, className: 'is-dep' },
        h('span', { className: 'is-dep-ref' }, dep.number ? `#${dep.number}` : dep.id),
        h('span', { className: 'is-dep-title' }, dep.title),
        h('span', { className: 'is-dep-status', 'data-done': String(dep.status === 'done') }, STATUS_LABEL[dep.status] || dep.status),
        h('button', {
          type: 'button', className: 'is-dep-x', title: side === 'dependsOn' ? '解除这个前置' : '解除这个后置',
          disabled: depBusy, onClick: () => removeDep(dep, side),
        }, '×'));

      const depBlock = (title, list, side) => h('div', null,
        h('div', { className: 'is-dep-head' }, title),
        list.length ? list.map(dep => depRow(dep, side)) : h('div', { className: 'is-dep-empty' }, '（无）'),
        depMode === side
          ? h(DepPicker, {
            mode: side,
            exclude: [issue.id, ...list.map(dep => dep.id)],
            onPick: addDep,
            onCancel: () => setDepMode(null),
          })
          : h('button', { type: 'button', className: 'is-dep-addbtn', onClick: () => setDepMode(side) }, '＋ 添加'));
      return h('div', { className: 'is-root' }, h('div', { className: 'is-main' },
        h('div', { className: 'is-head' },
          h('button', { className: 'is-back', type: 'button', onClick: onBack }, '← 返回'),
          h('span', { className: 'is-head-title' }, issue.title),
          h(Badge, { status: issue.status }),
          note ? h('span', { className: 'is-note' }, note) : null),
        h('div', { className: 'is-body' },
          error ? h(ErrorBox, { error }) : null,
          h('div', { className: 'is-detail' },
            `${issue.number ? `#${issue.number}` : issue.id} · 创建于 ${formatTime(issue.createdAt)} · 由 ${issue.createdByName || issue.createdBy}`),
          h(TagPicker, { value: issue.tags || [], library: tags, onChange: saveTags, onCreate: onCreateTag, onDelete: dropTag }),
          issue.body ? h('div', { className: 'is-body-text' }, issue.body) : h('div', { className: 'is-empty' }, '（无正文）'),
          issue.result ? h('div', { className: 'is-result' },
            h('div', { className: 'is-result-label' }, '闭环结果'),
            h('div', { className: 'is-result-text' }, issue.result)) : null,
          h('div', { className: 'is-actions' },
            (ACTIONS[issue.status] || []).map(([status, label]) =>
              h('button', {
                key: status, className: 'is-btn', 'data-kind': actionKind(status), type: 'button',
                disabled: busy || (status === 'start' && started) || (status === 'done' && blocking.length > 0),
                onClick: () => act(status),
              }, label))),
          blocking.length ? h('div', { className: 'is-blocked' },
            `还有 ${blocking.length} 个前置没闭环：${blocking.map(dep => (dep.number ? `#${dep.number}` : dep.title)).join('、')}，先完成它们才能验收`) : null,
          h('div', { className: 'is-sec' }, '依赖'),
          h('div', { className: 'is-deps' },
            depBlock('前置（它们完成，本事务才能完成）', issue.dependsOn || [], 'dependsOn'),
            depBlock('后置（本事务完成，它们才能完成）', issue.blocks || [], 'blocks')),
          (issue.dispatches && issue.dispatches.length) ? h('div', { className: 'is-sec' }, `派工记录（${issue.dispatches.length}）`) : null,
          (issue.dispatches || []).map(d => h('div', { key: d.id, className: 'is-detail' }, `${d.taskId} · ${STATUS_LABEL[d.status] || d.status} · ${formatTime(d.at)}`)),
          h('div', { className: 'is-sec' }, '评论与时间线'),
          h('div', { className: 'is-tl' },
            timeline.length ? timeline.map(c => h('div', { key: c.id, className: 'is-tl-item' },
              h('div', { className: 'is-tl-meta' },
                `${formatTime(c.at)} · ${authorLabel(c)}`,
                c.kind !== 'comment' ? h('span', { className: 'is-tl-kind' }, c.kind === 'status' ? '状态' : c.kind === 'result' ? '结果' : c.kind) : null),
              h('div', { className: 'is-tl-body' }, renderMentions(c.kind === 'status' ? localizeStatusText(c.body) : c.body, roster)))) : h('div', { className: 'is-empty' }, '还没有评论。')),
          h('div', { className: 'is-sec' }, '写评论'),
          h(MentionField, { rows: 3, value: comment, onChange: setComment, roster, placeholder: '补充说明、结论或交接信息…（@同事 会通知他）' }),
          h('div', { style: { marginTop: 10 } },
            h('button', { className: 'is-btn', 'data-kind': 'primary', type: 'button', disabled: busy || !comment.trim(), onClick: post }, '提交评论')))));
    }

    function Panel() {
      const [statuses, setStatuses] = React.useState(null);
      const [counts, setCounts] = React.useState({});
      const [tags, setTags] = React.useState([]);
      const [filter, setFilter] = React.useState('open');
      const [view, setView] = React.useState('list'); // list | new | detail
      const [detailId, setDetailId] = React.useState(null);
      const [items, setItems] = React.useState([]);
      const [error, setError] = React.useState(null);
      const [busyId, setBusyId] = React.useState(null);
      const [note, setNote] = React.useState(null);
      const [roster, setRoster] = React.useState([]);

      // 聊天里点 #N（或别处派发 bot-issue:focus）→ 打开对应事务。
      React.useEffect(() => {
        const focus = (number) => {
          if (!Number.isFinite(number) || number <= 0) return;
          pendingOpen = null;
          setView('detail');
          setDetailId(String(number));
        };
        if (pendingOpen !== null) focus(pendingOpen);
        const onFocus = (event) => focus(Number(event?.detail?.number));
        window.addEventListener('bot-issue:focus', onFocus);
        return () => window.removeEventListener('bot-issue:focus', onFocus);
      }, []);

      const refresh = React.useCallback(async () => {
        setError(null);
        try {
          const meta = await call('meta');
          setStatuses(Array.isArray(meta.statuses) ? meta.statuses : ['open']);
          setTags(Array.isArray(meta.tags) ? meta.tags : (Array.isArray(meta.types) ? meta.types : []));
          setRoster(Array.isArray(meta.roster) ? meta.roster : []);
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

      // 标签库的增删：面板持有库，编辑完标签后各视图跟着刷新。
      const createTag = React.useCallback(async (name) => {
        const value = await call('tag_create', { name });
        setTags(Array.isArray(value?.tags) ? value.tags : []);
      }, []);

      const deleteTag = React.useCallback(async (name) => {
        const value = await call('tag_delete', { name });
        setTags(Array.isArray(value?.tags) ? value.tags : []);
        await refresh();
      }, [refresh]);

      // 列表上直接一键启动，不用点进详情页。
      const startIssue = async (event, id) => {
        event.stopPropagation();
        setBusyId(id); setNote(null); setError(null);
        try {
          const value = await call('start', { id });
          setNote(value?.dispatched ? (value.note || '已交给主 Bot') : `未启动：${value?.reason || '未知原因'}`);
          await refresh();
        } catch (caught) { setError(caught); } finally { setBusyId(null); }
      };

      if (error && view === 'list') return h('div', { className: 'is-root' }, h('div', { className: 'is-main' },
        h('div', { className: 'is-head' }, h('span', { className: 'is-head-title' }, '事务')),
        h('div', { className: 'is-body' }, h(ErrorBox, { error, onRetry: refresh }))));

      if (view === 'new') return h(NewForm, {
        onDone: () => { setView('list'); refresh(); }, onBack: () => setView('list'),
        tags, onCreateTag: createTag, onDeleteTag: deleteTag, roster,
      });
      if (view === 'detail') return h(Detail, {
        id: detailId, onBack: () => { setView('list'); refresh(); }, onChanged: refresh, roster,
        tags, onCreateTag: createTag, onDeleteTag: deleteTag,
      });

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
            h('span', { className: 'is-head-count' }, `${items.length} 条`),
            note ? h('span', { className: 'is-note' }, note) : null),
          h('div', { className: 'is-body' },
            items.length ? items.map(issue => {
              const canStart = issue.status === 'open' || issue.status === 'discussing';
              return h('div', { key: issue.id, className: 'is-card', onClick: () => { setDetailId(issue.id); setView('detail'); } },
                h('div', { className: 'is-card-top' },
                  h(Badge, { status: issue.status }),
                  (issue.tags || []).map(tag => h('span', { key: tag, className: 'is-type-tag' }, tag)),
                  issue.depsOpen ? h('span', { className: 'is-badge', style: { '--sc': 'var(--dsw-alias-state-warn-primary)' } },
                    h('span', { className: 'is-badge-dot' }), `等 ${issue.depsOpen} 个前置`) : null,
                  h('span', { className: 'is-card-id' }, issue.number ? `#${issue.number}` : issue.id),
                  h('span', { className: 'is-card-time' }, formatTime(issue.updatedAt))),
                h('div', { className: 'is-card-title' }, issue.title),
                issue.body ? h('div', { className: 'is-card-body' }, issue.body) : null,
                canStart ? h('div', { className: 'is-card-actions' },
                  h('button', { className: 'is-btn is-btn-sm', 'data-kind': 'primary', type: 'button', disabled: busyId === issue.id, onClick: e => startIssue(e, issue.id) }, busyId === issue.id ? '启动中…' : '启动')) : null);
            })
              : h('div', { className: 'is-empty' },
                '这个状态下还没有事务。',
                h('div', { className: 'is-empty-hint' }, '点左侧「新建事务」开始，或换个状态看看。')))));
    }

    // ---- 输入框里打 # 时的事务候选补全（需要 dsh input-trigger 支持 #） ----
    let issueHintCache = { at: 0, items: [] };
    async function issueHintItems() {
      if (Date.now() - issueHintCache.at < 5000 && issueHintCache.items.length) return issueHintCache.items;
      try {
        const list = await call('list', { limit: 200 });
        issueHintCache = { at: Date.now(), items: Array.isArray(list.items) ? list.items : [] };
      } catch { /* keep the last good list */ }
      return issueHintCache.items;
    }
    function issueHintSource() {
      return {
        trigger: '#',
        name: '事务',
        order: 10,
        async candidates(_session, req) {
          const items = await issueHintItems();
          const q = String(req?.query || '').trim().toLowerCase().replace(/^#/, '');
          return items
            .filter(it => !q || String(it.number).startsWith(q) || String(it.title || '').toLowerCase().includes(q) || String(it.type || '').toLowerCase().includes(q))
            .slice(0, 20)
            .map(it => ({
              name: `#${it.number}`,
              label: `#${it.number} ${it.title || ''}`.trim(),
              description: `${STATUS_LABEL[it.status] || it.status}${it.type ? ` · ${it.type}` : ''}`,
              value: String(it.number),
            }));
        },
        onPick(pick) {
          const n = pick?.candidate?.value || String(pick?.candidate?.name || '').replace(/^#/, '');
          return { text: `#${n}` };
        },
      };
    }

    function apply(ctx) {
      const style = document.createElement('style');
      style.textContent = CSS;
      document.head.appendChild(style);
      ctx.effect(() => () => style.remove(), 'bot-issue: styles');
      // 输入框里打 # → 事务候选补全（需 dsh input-trigger 已支持 #，见 patches/dsh-hash-trigger.md）。
      if (typeof ctx.inject === 'function') {
        ctx.inject(['inputTriggers'], inputCtx => {
          const dispose = inputCtx.inputTriggers.registerSource(issueHintSource());
          return () => { try { dispose(); } catch { /* already gone */ } };
        });
      }
      // 聊天里点 #N：dscord 派发 bot-issue:open，这里切到事务面板并打开对应事务。
      const onOpen = (event) => {
        const number = Number(event?.detail?.number);
        if (!Number.isFinite(number) || number <= 0) return;
        pendingOpen = number;
        const layout = ctx.get?.('layout') ?? ctx.layout;
        layout?.selectPanel?.('bot-issue');
        window.dispatchEvent(new CustomEvent('bot-issue:focus', { detail: { number } }));
      };
      window.addEventListener('bot-issue:open', onOpen);
      ctx.effect(() => () => window.removeEventListener('bot-issue:open', onOpen), 'bot-issue: open bridge');
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
