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
      { id: 'private', label: '私有记忆' },
      { id: 'journal', label: '日记' },
      { id: 'knowledge', label: '知识（公开）' },
      { id: 'daily-report', label: '日报' },
    ];
    const CATEGORY_LABEL = { private: '私有记忆', journal: '日记', knowledge: '知识（公开）', 'daily-report': '日报' };
    const CATEGORY_TONE = { private: 'private', journal: 'journal', knowledge: 'knowledge', 'daily-report': 'daily-report' };
    function avatarHue(name) {
      let hash = 0;
      for (const ch of String(name || '')) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
      return hash % 5;
    }

    const CSS = `
.bk-root{position:relative;display:flex;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;-webkit-font-smoothing:antialiased}
.bk-side{width:240px;flex:none;border-right:1px solid var(--dsw-alias-border-l1);overflow-y:auto;padding:14px 10px;background:var(--dsw-specific-sidebar-fill,var(--dsw-alias-bg-layer-1));display:flex;flex-direction:column;gap:2px}
.bk-side-head{display:flex;align-items:center;justify-content:space-between;padding:0 8px 10px}
.bk-side-title{font-size:11px;font-weight:700;letter-spacing:.05em;color:var(--dsw-alias-label-secondary);text-transform:uppercase}
.bk-side-count{font-size:11px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border-radius:999px;padding:1px 8px;line-height:16px;font-variant-numeric:tabular-nums}
.bk-bot{display:flex;align-items:center;gap:10px;width:100%;text-align:left;border:1px solid transparent;background:transparent;color:inherit;padding:8px 9px;border-radius:10px;cursor:pointer;font-family:inherit;transition:background .1s,border-color .1s}
.bk-bot:hover{background:var(--dsw-alias-bg-layer-2)}
.bk-bot[data-active="true"]{background:color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-brand-primary) 24%, transparent)}
.bk-avatar{width:30px;height:30px;flex:none;border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;color:#fff}
.bk-avatar[data-hue="0"]{background:#4f8ef7}
.bk-avatar[data-hue="1"]{background:#2fbf8f}
.bk-avatar[data-hue="2"]{background:#e0a13c}
.bk-avatar[data-hue="3"]{background:#c2699f}
.bk-avatar[data-hue="4"]{background:#7a6ef0}
.bk-bot-body{flex:1;min-width:0}
.bk-bot-name{font-weight:600;font-size:13px;line-height:1.35;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bk-bot-meta{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:2px;line-height:1.45;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bk-main{flex:1;min-width:0;display:flex;flex-direction:column}
.bk-head{display:flex;gap:10px;align-items:center;padding:12px 18px;border-bottom:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap;flex:none}
.bk-tabs{display:flex;gap:2px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:3px}
.bk-tab{border:0;background:transparent;color:var(--dsw-alias-label-secondary);padding:5px 13px;border-radius:8px;cursor:pointer;font-size:12.5px;font-family:inherit;font-weight:500}
.bk-tab:hover{color:var(--dsw-alias-label-primary)}
.bk-tab[data-active="true"]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-brand-primary);font-weight:600}
.bk-body{flex:1;overflow:auto;padding:18px 20px 40px;max-width:880px;width:100%;margin:0 auto;box-sizing:border-box}
.bk-entry{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:14px 16px;margin-bottom:12px;background:var(--dsw-alias-bg-layer-1);transition:border-color .12s,box-shadow .12s}
.bk-entry:hover{border-color:var(--dsw-alias-border-l2);box-shadow:0 3px 12px color-mix(in srgb, #000 6%, transparent)}
.bk-entry-top{display:flex;gap:6px;align-items:center;font-size:11px;color:var(--dsw-alias-label-secondary);margin-bottom:8px;flex-wrap:wrap}
.bk-time{display:inline-flex;align-items:center;font-variant-numeric:tabular-nums}
.bk-badge{display:inline-flex;align-items:center;gap:5px;border-radius:999px;padding:2px 9px;font-size:11px;font-weight:600;line-height:1.5;white-space:nowrap;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.bk-badge::before{content:"";width:5px;height:5px;border-radius:50%;background:currentColor;flex:none}
.bk-badge[data-tone="private"]{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}
.bk-badge[data-tone="knowledge"]{color:var(--dsw-alias-brand-primary);background:color-mix(in srgb, var(--dsw-alias-brand-primary) 11%, transparent)}
.bk-badge[data-tone="journal"]{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 13%, transparent)}
.bk-badge[data-tone="daily-report"]{color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 15%, transparent)}
.bk-badge[data-tone="warn"]{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent)}
.bk-badge[data-tone="muted"]{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}
.bk-text{white-space:pre-wrap;line-height:1.75;font-size:13.5px}
.bk-src{margin-top:12px;padding-top:10px;border-top:1px dashed var(--dsw-alias-border-l1);font-size:11px;color:var(--dsw-alias-label-secondary);word-break:break-all;line-height:1.55}
.bk-empty{color:var(--dsw-alias-label-secondary);padding:64px 16px;text-align:center;line-height:1.8}
.bk-error{margin:32px auto;max-width:520px;border:1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, transparent);background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent);border-radius:12px;padding:16px}
.bk-error-title{color:var(--dsw-alias-state-error-primary);font-weight:700;margin-bottom:8px}
.bk-btn{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:inherit;padding:5px 13px;border-radius:8px;cursor:pointer;font-size:12px;font-family:inherit}
.bk-btn:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.bk-btn:disabled{opacity:.45;cursor:default}
.bk-detail{font-size:11px;color:var(--dsw-alias-label-secondary);word-break:break-all;margin:8px 0}
.bk-date{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:inherit;padding:4px 9px;border-radius:8px;font-size:12px;font-family:inherit}
.bk-ok{color:var(--dsw-alias-state-success-primary);font-size:11px}
.bk-sched{display:flex;gap:8px;align-items:center;font-size:11px;color:var(--dsw-alias-label-secondary);margin-left:auto;flex-wrap:wrap}
.bk-report-bot{font-weight:700;font-size:13.5px;margin:18px 0 8px;display:flex;align-items:center;gap:8px}
.bk-scrim{display:none}
.bk-nav-btn{display:none}
@media (max-width:768px){
.bk-head{flex-wrap:wrap;gap:8px;padding:10px 12px}
.bk-body{padding:14px 14px 32px}
.bk-side{position:absolute;top:0;bottom:0;left:0;width:min(82vw,280px);z-index:2;transform:translateX(-100%);transition:transform .22s ease;box-shadow:8px 0 32px rgba(0,0,0,.35)}
.bk-side[data-open="true"]{transform:translateX(0)}
.bk-scrim{display:block;position:absolute;inset:0;z-index:1;background:rgba(0,0,0,.42)}
.bk-nav-btn{display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);width:34px;height:34px;border-radius:8px;cursor:pointer;font-size:16px;font-family:inherit}
}
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
      return h('span', { className: 'bk-badge', 'data-tone': tone || 'muted' }, children);
    }

    function BotAvatar({ name }) {
      const initial = String(name || '?').trim().charAt(0).toUpperCase() || '?';
      return h('span', { className: 'bk-avatar', 'data-hue': String(avatarHue(name)) }, initial);
    }

    function Entry({ entry }) {
      const stale = entry.status !== 'active';
      return h('div', { className: 'bk-entry' },
        h('div', { className: 'bk-entry-top' },
          h('span', { className: 'bk-time' }, formatTime(entry.observedAt)),
          h(Badge, { tone: CATEGORY_TONE[entry.category] || 'muted' }, CATEGORY_LABEL[entry.category] || entry.category),
          entry.subtype ? h(Badge, { tone: 'muted' }, entry.subtype === 'decision' ? '决定' : '偏好') : null,
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
      const [navOpen, setNavOpen] = React.useState(false); // 手机：Bot 列表抽屉

      const refreshSchedules = React.useCallback(async () => {
        try {
          const value = await call('schedules');
          setSchedules({
            items: Array.isArray(value?.items) ? value.items : [],
            reportBots: Array.isArray(value?.reportBots) ? value.reportBots : [],
            reportBotIds: Array.isArray(value?.reportBotIds) ? value.reportBotIds : [],
          });
        } catch (caught) { setSchedules({ items: [], reportBots: [], reportBotIds: [], error: caught }); }
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
          const count = action => value.results.filter(r => r.action === action).length;
          const parts = [`新建 ${count('created')}`, `更新 ${count('updated')}`];
          if (count('pruned')) parts.push(`清理 ${count('pruned')}`);
          if (count('skipped')) parts.push(`跳过 ${count('skipped')}`);
          setNote(`已排程：${parts.join('、')}、其余未变（定时器已挂好，触发时才通知 Bot）`);
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
      // Only the coordinating Bot writes a daily report; the others just keep memories.
      const reportBotCount = Array.isArray(schedules?.reportBots) ? schedules.reportBots.length : 0;
      // Arming a task only sets a timer: the Bot is not told until it fires, so show the
      // next fire time here instead of leaving the user to ask the Bot.
      const nextRun = Array.isArray(schedules?.items)
        ? schedules.items.filter(item => item.status === 'active' && item.nextRunAt)
          .map(item => item.nextRunAt).sort()[0]
        : undefined;
      const isReports = tab === 'daily-report';
      const shown = entries.items.filter(entry => (tab === 'all' ? true : entry.category === tab));

      return h('div', { className: 'bk-root' },
        h('div', { className: 'bk-side', 'data-open': String(navOpen) },
          h('div', { className: 'bk-side-head' },
            h('span', { className: 'bk-side-title' }, 'Bot'),
            h('span', { className: 'bk-side-count' }, String(bots.length))),
          bots.map(bot => h('button', {
            key: bot.id, type: 'button', className: 'bk-bot',
            'data-active': String(bot.id === selectedBot.id),
            onClick: () => { setSelected(bot.id); setNavOpen(false); },
          },
          h(BotAvatar, { name: bot.name }),
          h('div', { className: 'bk-bot-body' },
            h('div', { className: 'bk-bot-name' }, bot.name),
            h('div', { className: 'bk-bot-meta' },
              `${bot.memoryCount} 条记忆${bot.reportCount ? ` · 今日 ${bot.reportCount} 篇日报` : ''}`),
            bot.role ? h('div', { className: 'bk-bot-meta' }, bot.role) : null)))),
        navOpen ? h('div', { className: 'bk-scrim', onClick: () => setNavOpen(false) }) : null,
        h('div', { className: 'bk-main' },
          h('div', { className: 'bk-head' },
            h('button', { className: 'bk-nav-btn', type: 'button', onClick: () => setNavOpen(open => !open), 'aria-label': '选择 Bot' }, '☰'),
            h('div', { className: 'bk-tabs' },
              TABS.map(item => h('button', {
                key: item.id, type: 'button', className: 'bk-tab',
                'data-active': String(tab === item.id),
                onClick: () => setTab(item.id),
              }, item.label))),
            isReports ? h('input', {
              className: 'bk-date', type: 'date', value: reportDate,
              onChange: event => setReportDate(event.target.value),
            }) : null,
            h('span', { className: 'bk-sched' },
              `日报排程：${armed}/${reportBotCount}`,
              armed > reportBotCount
                ? h('span', { style: { color: 'var(--dsw-alias-state-warn-primary)' } },
                  `多出 ${armed - reportBotCount} 条，点「重新排程」清理`)
                : null,
              nextRun ? h('span', null, `下次 ${formatTime(Date.parse(nextRun))}`) : null,
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
