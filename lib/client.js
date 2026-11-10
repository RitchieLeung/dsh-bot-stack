/**
 * Client half of the Bot knowledge panel.
 *
 * A plain script served to the DSH Web GUI: the shell calls the registered
 * factory with a `require` bound to the host's module table. No build step.
 */
window.__ModuleLoader__.load({
  // The loader keys client modules by package name; a different id fails to load.
  id: 'dsh-plugin-bot-knowledge',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const TABS = [
      { id: 'all', label: '全部' },
      { id: 'journal', label: '日记' },
      { id: 'knowledge', label: '知识' },
      { id: 'daily-report', label: '日报' },
    ];
    const CATEGORY_LABEL = { 'daily-report': '日报', journal: '日记', knowledge: '知识' };

    const CSS = `
.bk-root{display:flex;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px}
.bk-side{width:220px;flex:none;border-right:1px solid var(--dsw-alias-border-l1);overflow:auto;padding:8px;background:var(--dsw-alias-bg-layer-1)}
.bk-side-title{font-size:12px;color:var(--dsw-alias-label-secondary);padding:6px 8px}
.bk-bot{display:block;width:100%;text-align:left;border:0;background:transparent;color:inherit;padding:8px;border-radius:6px;cursor:pointer}
.bk-bot:hover{background:var(--dsw-alias-bg-layer-2)}
.bk-bot[data-active="true"]{background:var(--dsw-alias-bg-layer-2)}
.bk-bot-name{font-weight:600}
.bk-bot-meta{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:2px}
.bk-main{flex:1;min-width:0;display:flex;flex-direction:column}
.bk-head{display:flex;gap:6px;align-items:center;padding:10px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap}
.bk-tab{border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);padding:4px 10px;border-radius:999px;cursor:pointer;font-size:12px}
.bk-tab[data-active="true"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.bk-body{flex:1;overflow:auto;padding:12px 16px}
.bk-entry{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:10px 12px;margin-bottom:10px;background:var(--dsw-alias-bg-layer-1)}
.bk-entry-top{display:flex;gap:8px;align-items:center;font-size:11px;color:var(--dsw-alias-label-secondary);margin-bottom:6px;flex-wrap:wrap}
.bk-badge{border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:1px 8px;font-size:11px}
.bk-badge[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.bk-text{white-space:pre-wrap;line-height:1.6}
.bk-src{margin-top:8px;font-size:11px;color:var(--dsw-alias-label-secondary);word-break:break-all}
.bk-empty{color:var(--dsw-alias-label-secondary);padding:32px 0;text-align:center}
.bk-error{margin:32px auto;max-width:520px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:8px;padding:16px}
.bk-error-title{color:var(--dsw-alias-state-error-primary);font-weight:600;margin-bottom:8px}
.bk-btn{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:inherit;padding:4px 12px;border-radius:6px;cursor:pointer;font-size:12px}
.bk-detail{font-size:11px;color:var(--dsw-alias-label-secondary);word-break:break-all;margin:8px 0}
.bk-date{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:inherit;padding:3px 8px;border-radius:6px;font-size:12px}
.bk-ok{color:var(--dsw-alias-state-success-primary);font-size:11px}
.bk-sched{display:flex;gap:8px;align-items:center;font-size:11px;color:var(--dsw-alias-label-secondary);margin-left:auto}
.bk-report-bot{font-weight:600;margin:16px 0 6px}
`;

    async function call(action, payload) {
      const response = await fetch('/api/bot-knowledge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ action }, payload || {})),
      });
      let json;
      try {
        json = await response.json();
      } catch {
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

    function todayShanghai() {
      try { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date()); }
      catch { return new Date().toISOString().slice(0, 10); }
    }

    function Badge({ children, tone }) {
      return h('span', { className: 'bk-badge', 'data-tone': tone || 'plain' }, children);
    }

    function Entry({ entry }) {
      const stale = entry.status !== 'active';
      return h('div', { className: 'bk-entry' },
        h('div', { className: 'bk-entry-top' },
          h('span', null, formatTime(entry.observedAt)),
          h(Badge, null, CATEGORY_LABEL[entry.category] || entry.category),
          entry.subtype ? h(Badge, null, entry.subtype === 'decision' ? '决定' : '偏好') : null,
          entry.predicate ? h('code', null, entry.predicate) : null,
          stale ? h(Badge, { tone: 'warn' }, entry.status) : null),
        h('div', { className: 'bk-text' }, entry.text),
        h('div', { className: 'bk-src' },
          entry.sources && entry.sources.length
            ? `来源：${entry.sources.map(s => [s.authorId, s.roomId, s.eventId].filter(Boolean).join(' · ') || s.id).join('；')}`
            : '来源：来源信息缺失'));
    }

    function ErrorBox({ error, onRetry }) {
      const titles = {
        KNOWLEDGE_DB_MISSING: '找不到记忆库',
        HOST_STALE: '需要重启 dsh web',
        SCHEDULE_UNAVAILABLE: '宿主未提供排程服务',
      };
      const retryable = error.code !== 'HOST_STALE';
      return h('div', { className: 'bk-error' },
        h('div', { className: 'bk-error-title' }, titles[error.code] || '读取失败'),
        h('div', { className: 'bk-detail' }, error.message),
        retryable ? h('button', { className: 'bk-btn', type: 'button', onClick: onRetry }, '重试') : null);
    }

    function Icon({ size }) {
      const s = size || 16;
      return h('svg', { width: s, height: s, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('path', { d: 'M4 5.5A2.5 2.5 0 0 1 6.5 3H19v15.5H6.5A2.5 2.5 0 0 0 4 21V5.5Z' }),
        h('path', { d: 'M19 18.5V21H6.5' }));
    }

    function Panel() {
      const [bots, setBots] = React.useState(null);
      const [selected, setSelected] = React.useState(null);
      const [tab, setTab] = React.useState('all');
      const [entries, setEntries] = React.useState({ items: [], total: 0 });
      const [reportDate, setReportDate] = React.useState(todayShanghai());
      const [reports, setReports] = React.useState([]);
      const [schedules, setSchedules] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [note, setNote] = React.useState('');

      const refreshSchedules = React.useCallback(async () => {
        try {
          const value = await call('schedules');
          setSchedules({ items: Array.isArray(value?.items) ? value.items : [], bots: Array.isArray(value?.bots) ? value.bots : [] });
        } catch (caught) { setSchedules({ items: [], bots: [], error: caught }); }
      }, []);

      const refreshBots = React.useCallback(async () => {
        setError(null);
        try {
          const value = await call('bots');
          if (!value || !Array.isArray(value.bots)) {
            // The Host half is whatever was loaded when the profile started. An older
            // Host answers with a different shape, and only a restart can replace it.
            throw Object.assign(new Error('宿主侧的插件仍是旧版本，重启 dsh web 后才会生效。'), { code: 'HOST_STALE' });
          }
          setBots(value.bots);
          setSelected(current => current || (value.bots[0] ? value.bots[0].id : null));
        } catch (caught) {
          setError(caught);
          setBots([]);
        }
      }, []);

      React.useEffect(() => { refreshBots(); refreshSchedules(); }, [refreshBots, refreshSchedules]);

      React.useEffect(() => {
        if (!selected) return undefined;
        let live = true;
        setNote('');
        call('entries', { botId: selected })
          .then(value => { if (live && Array.isArray(value?.items)) setEntries({ items: value.items, total: value.total || 0 }); })
          .catch(caught => { if (live) setError(caught); });
        return () => { live = false; };
      }, [selected]);

      React.useEffect(() => {
        let live = true;
        call('reports', { date: reportDate })
          .then(value => { if (live && Array.isArray(value?.reports)) setReports(value.reports); })
          .catch(caught => { if (live) setError(caught); });
        return () => { live = false; };
      }, [reportDate]);

      const rearm = async () => {
        setBusy(true); setNote('');
        try {
          const value = await call('ensure-schedules');
          const created = value.results.filter(r => r.action === 'created').length;
          const updated = value.results.filter(r => r.action === 'updated').length;
          setNote(`已排程：新建 ${created}、更新 ${updated}、其余未变`);
          await refreshSchedules();
        } catch (caught) {
          setError(caught);
        } finally { setBusy(false); }
      };

      if (error) return h('div', { className: 'bk-root' }, h('div', { className: 'bk-main' },
        h(ErrorBox, { error, onRetry: () => { setError(null); refreshBots(); refreshSchedules(); } })));

      if (!bots) return h('div', { className: 'bk-root' }, h('div', { className: 'bk-main' }, h('div', { className: 'bk-empty' }, '正在读取…')));

      if (!bots.length) return h('div', { className: 'bk-root' }, h('div', { className: 'bk-main' },
        h('div', { className: 'bk-empty' }, '还没有任何 Bot 记录。')));

      const selectedBot = bots.find(bot => bot.id === selected) || bots[0];
      // Only a live task will actually fire; ended or paused ones must not inflate the count.
      const armed = Array.isArray(schedules?.items) ? schedules.items.filter(item => item.status === 'active').length : 0;
      const isReports = tab === 'daily-report';
      const shown = entries.items.filter(entry => (tab === 'all' ? true : entry.category === tab));

      return h('div', { className: 'bk-root' },
        h('div', { className: 'bk-side' },
          h('div', { className: 'bk-side-title' }, `Bot（${bots.length}）`),
          bots.map(bot => h('button', {
            key: bot.id, type: 'button', className: 'bk-bot',
            'data-active': String(bot.id === selectedBot.id),
            onClick: () => setSelected(bot.id),
          },
          h('div', { className: 'bk-bot-name' }, bot.name),
          h('div', { className: 'bk-bot-meta' },
            `${bot.memoryCount} 条记忆${bot.reportCount ? ` · 今日 ${bot.reportCount} 篇日报` : ''}`),
          bot.role ? h('div', { className: 'bk-bot-meta' }, bot.role) : null))),
        h('div', { className: 'bk-main' },
          h('div', { className: 'bk-head' },
            TABS.map(item => h('button', {
              key: item.id, type: 'button', className: 'bk-tab',
              'data-active': String(tab === item.id),
              onClick: () => setTab(item.id),
            }, item.label)),
            isReports ? h('input', {
              className: 'bk-date', type: 'date', value: reportDate,
              onChange: event => setReportDate(event.target.value),
            }) : null,
            h('span', { className: 'bk-sched' },
              `日报排程：${armed}/${bots.length}`,
              note ? h('span', { className: 'bk-ok' }, note) : null,
              h('button', { className: 'bk-btn', type: 'button', disabled: busy, onClick: rearm },
                busy ? '排程中…' : '重新排程'))),
          h('div', { className: 'bk-body' },
            isReports
              ? (reports.length
                ? reports.map(report => h('div', { key: report.memoryId },
                  h('div', { className: 'bk-report-bot' }, `${report.botName} · ${report.date}`),
                  h(Entry, { entry: { text: report.text, observedAt: report.observedAt, category: 'daily-report',
                    sources: [], status: 'active', predicate: 'daily-report', facets: [] } })))
                : h('div', { className: 'bk-empty' }, `${reportDate} 还没有任何 Bot 写日报。`))
              : (shown.length
                ? shown.map(entry => h(Entry, { key: entry.id, entry }))
                : h('div', { className: 'bk-empty' },
                  entries.total === 0 ? '这只 Bot 还没有记忆。' : '这个分类下暂时没有内容。')))));
    }

    function apply(ctx) {
      const style = document.createElement('style');
      style.textContent = CSS;
      document.head.appendChild(style);
      ctx.effect(() => () => style.remove(), 'bot-knowledge: styles');
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist', id: 'bot-knowledge', label: () => '知识库', order: 30,
      }, Icon));
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main', key: 'bot-knowledge',
      }, Panel));
    }

    return { inject: ['slots'], apply };
  },
});
