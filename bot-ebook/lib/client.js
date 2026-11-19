/**
 * Client half of the ebook module (电子书).
 *
 * A plain script served to the DSH Web GUI. It registers a sidebar entry
 * 「电子书」 and a main panel: a shelf of books, the chapter list of the
 * selected book, and a reading view that renders the chapter's markdown.
 *
 * Reading position (chapter + scroll offset) is stored server-side, so it
 * follows the reader across reloads and browsers.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-bot-ebook',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const CSS = `
.eb-root{position:relative;display:flex;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;-webkit-font-smoothing:antialiased}
.eb-side{width:252px;flex:none;border-right:1px solid var(--dsw-alias-border-l1);background:var(--dsw-specific-sidebar-fill);display:flex;flex-direction:column;min-height:0}
.eb-side-scroll{flex:1;overflow:auto;padding:12px 10px}
.eb-side-title{font-size:11px;font-weight:700;letter-spacing:.04em;color:var(--dsw-alias-label-secondary);padding:2px 8px 8px;text-transform:uppercase}
.eb-book{display:block;width:100%;text-align:left;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-primary);padding:8px 10px;border-radius:9px;cursor:pointer;margin-bottom:4px}
.eb-book:hover{background:var(--dsw-alias-bg-layer-2)}
.eb-book[data-active="true"]{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}
.eb-book-name{font-weight:600;line-height:1.4}
.eb-book-meta{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:3px;display:flex;gap:8px;align-items:center}
.eb-read-dot{width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-state-success-primary);flex:none}
.eb-search{padding:0 10px 10px}
.eb-search input{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 9px;font-size:12.5px;font-family:inherit}
.eb-search input:focus{outline:0;border-color:var(--dsw-alias-brand-primary)}
.eb-hits{margin:0 0 10px;padding:0 10px}
.eb-hit{display:block;width:100%;text-align:left;border:0;background:transparent;color:var(--dsw-alias-label-primary);padding:7px 8px;border-radius:8px;cursor:pointer;margin-bottom:2px}
.eb-hit:hover{background:var(--dsw-alias-bg-layer-2)}
.eb-hit-title{font-size:12px;font-weight:600;line-height:1.4}
.eb-hit-snippet{font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.45;margin-top:2px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.eb-lib{flex:1;overflow:auto;padding:24px 30px 70px}
.eb-lib-head{display:flex;align-items:baseline;gap:10px;margin:0 0 16px}
.eb-lib-title{font-weight:700;font-size:14px}
.eb-lib-search{width:280px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:9px;padding:6px 11px;font-size:12.5px;font-family:inherit}
.eb-lib-search:focus{outline:0;border-color:var(--dsw-alias-brand-primary)}
.eb-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(252px,1fr));gap:14px}
.eb-card{display:block;text-align:left;border:1px solid var(--dsw-alias-border-l1);border-radius:14px;padding:16px 18px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer;font-family:inherit;transition:border-color .12s,box-shadow .12s,transform .12s}
.eb-card:hover{border-color:var(--dsw-alias-border-l2);box-shadow:0 6px 18px color-mix(in srgb, #000 9%, transparent);transform:translateY(-1px)}
.eb-card-title{font-weight:700;font-size:14.5px;line-height:1.45}
.eb-card-author{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:7px;line-height:1.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.eb-card-meta{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:11px;display:flex;gap:7px;align-items:center;flex-wrap:wrap}
.eb-bar{height:3px;border-radius:2px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;margin-top:12px}
.eb-bar>i{display:block;height:100%;background:var(--dsw-alias-brand-primary);border-radius:2px}
.eb-card-cta{font-size:11.5px;color:var(--dsw-alias-brand-primary);font-weight:600;margin-top:11px}
.eb-hit-wide{padding:11px 13px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;margin-bottom:8px;background:var(--dsw-alias-bg-layer-1)}
.eb-hit-wide:hover{border-color:var(--dsw-alias-brand-primary)}
.eb-back{display:inline-flex;align-items:center;gap:5px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12.5px;font-family:inherit;padding:4px 8px;border-radius:7px;margin:0 2px 8px}
.eb-back:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-brand-primary)}
.eb-side-book{font-size:12.5px;font-weight:600;line-height:1.45;padding:0 8px 10px;color:var(--dsw-alias-label-primary)}
.eb-toc-group{margin:10px 0 2px;padding:0 8px;font-size:11px;font-weight:700;color:var(--dsw-alias-label-secondary);letter-spacing:.02em}
.eb-toc-item{display:flex;gap:7px;align-items:baseline;width:100%;text-align:left;border:0;background:transparent;color:var(--dsw-alias-label-primary);padding:5px 8px;border-radius:7px;cursor:pointer;font-size:12.5px;line-height:1.45}
.eb-toc-item:hover{background:var(--dsw-alias-bg-layer-2)}
.eb-toc-item[data-active="true"]{background:color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent);color:var(--dsw-alias-brand-primary);font-weight:600}
.eb-toc-num{font-size:10.5px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;flex:none;min-width:16px;text-align:right}
.eb-toc-item[data-active="true"] .eb-toc-num{color:inherit}
.eb-main{flex:1;min-width:0;display:flex;flex-direction:column;min-height:0}
.eb-head{display:flex;align-items:center;gap:10px;padding:11px 20px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}
.eb-head-book{font-size:11.5px;color:var(--dsw-alias-label-secondary);max-width:34%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.eb-head-title{font-weight:700;font-size:14.5px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.eb-btn{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);padding:4px 11px;border-radius:8px;cursor:pointer;font-size:12.5px;font-family:inherit}
.eb-btn:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.eb-btn:disabled{opacity:.4;cursor:default}
.eb-body{flex:1;overflow:auto;padding:26px 30px 80px;min-height:0}
.eb-article{max-width:800px;margin:0 auto;line-height:1.85;font-size:14.5px;color:var(--dsw-alias-label-primary)}
.eb-article h1{font-size:23px;margin:0 0 16px}
.eb-article h2{font-size:19px;margin:30px 0 12px;padding-bottom:6px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.eb-article h3{font-size:16px;margin:24px 0 10px}
.eb-article h4{font-size:14.5px;margin:20px 0 8px}
.eb-article p{margin:0 0 15px}
.eb-article strong{font-weight:700}
.eb-article ul,.eb-article ol{margin:0 0 15px;padding-left:24px}
.eb-article li{margin:5px 0}
.eb-article a{color:var(--dsw-alias-brand-primary);text-decoration:none}
.eb-article a:hover{text-decoration:underline}
.eb-article code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.8px}
.eb-article p code,.eb-article li code,.eb-article td code{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:5px;padding:1px 5px}
.eb-article pre{margin:0 0 16px;padding:13px 15px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;overflow:auto;line-height:1.55}
.eb-article pre code{font-size:12.5px;white-space:pre}
.eb-article blockquote{margin:0 0 16px;padding:2px 0 2px 14px;border-left:3px solid var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-secondary)}
.eb-article blockquote p{margin:0 0 6px}
.eb-article hr{border:0;border-top:1px solid var(--dsw-alias-border-l1);margin:22px 0}
.eb-article table{border-collapse:collapse;margin:0 0 18px;font-size:13px;display:block;overflow:auto;max-width:100%}
.eb-article th,.eb-article td{border:1px solid var(--dsw-alias-border-l1);padding:6px 11px;text-align:left;vertical-align:top}
.eb-article th{background:var(--dsw-alias-bg-layer-2);font-weight:600;white-space:nowrap}
.eb-math{margin:0 0 16px;padding:12px 15px;background:var(--dsw-alias-bg-layer-2);border-radius:10px;border:1px solid var(--dsw-alias-border-l1);font-family:ui-monospace,Menlo,monospace;font-size:12.5px;white-space:pre-wrap;color:var(--dsw-alias-label-secondary)}
.eb-empty{color:var(--dsw-alias-label-secondary);padding:60px 20px;text-align:center;line-height:1.8}
.eb-empty code{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:5px;padding:1px 6px;font-size:12px}
.eb-error{margin:32px auto;max-width:520px;border:1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, transparent);background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent);border-radius:12px;padding:16px}
.eb-error-title{color:var(--dsw-alias-state-error-primary);font-weight:700;margin-bottom:8px}
.eb-error-detail{font-size:12px;color:var(--dsw-alias-label-secondary);word-break:break-all}
.eb-foot{display:flex;justify-content:space-between;align-items:center;padding:12px 20px;border-top:1px solid var(--dsw-alias-border-l1);font-size:12px;color:var(--dsw-alias-label-secondary);flex:none}
.eb-sec-menu{position:absolute;right:20px;top:52px;z-index:30;width:320px;max-height:340px;overflow:auto;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;box-shadow:0 14px 34px color-mix(in srgb, #000 22%, transparent);padding:6px}
.eb-sec-item{display:block;width:100%;text-align:left;border:0;background:transparent;color:var(--dsw-alias-label-primary);padding:6px 9px;border-radius:7px;cursor:pointer;font-size:12.5px;font-family:inherit;line-height:1.45}
.eb-sec-item:hover{background:color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent);color:var(--dsw-alias-brand-primary)}
.eb-sec-item[data-level="3"]{padding-left:22px}
.eb-spacer{flex:1;min-width:8px}
.eb-scrim{display:none}
@media (min-width:769px){.eb-side[data-collapsed="true"]{display:none}}
@media (max-width:768px){
.eb-head{flex-wrap:wrap;gap:6px;padding:8px 12px}
.eb-head-title{flex-basis:100%;order:-1}
.eb-head-count,.eb-sec-toggle,.eb-spacer{display:none}
.eb-lib-search{width:100%}
.eb-lib{padding:16px 14px 48px}
.eb-grid{grid-template-columns:1fr}
.eb-body{padding:18px 14px 64px}
.eb-article{font-size:15px}
.eb-foot{padding:10px 14px}
.eb-side{position:absolute;top:0;bottom:0;left:0;width:min(82vw,300px);z-index:2;transform:translateX(-100%);transition:transform .22s ease;box-shadow:8px 0 32px rgba(0,0,0,.35)}
.eb-side[data-open="true"]{transform:translateX(0)}
.eb-scrim{display:block;position:absolute;inset:0;z-index:1;background:rgba(0,0,0,.42)}
}
.eb-btn[data-kind="primary"]{border-color:transparent;background:var(--dsw-alias-brand-primary);color:#fff;font-weight:600}
.eb-btn[data-kind="primary"]:hover{color:#fff;filter:brightness(1.08)}
.eb-modal{position:absolute;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(0,0,0,.42)}
.eb-modal-card{width:min(560px,100%);max-height:88%;overflow:auto;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.3);padding:20px}
.eb-modal-head{display:flex;align-items:center;gap:10px;margin-bottom:14px}
.eb-modal-title{font-weight:700;font-size:15px;flex:1}
.eb-modal-close{border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:16px;padding:2px 8px;border-radius:7px}
.eb-modal-close:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.eb-tabs{display:flex;gap:8px;margin-bottom:14px}
.eb-tabbtn{border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:8px;padding:6px 14px;font-size:12.5px;cursor:pointer;font-family:inherit}
.eb-tabbtn[data-active="true"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);font-weight:600}
.eb-drop{border:2px dashed var(--dsw-alias-border-l2);border-radius:12px;padding:28px 16px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:13px;cursor:pointer}
.eb-drop:hover{border-color:var(--dsw-alias-brand-primary)}
.eb-field{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border-radius:9px;padding:9px 12px;font-size:13px;font-family:inherit}
.eb-field:focus{outline:0;border-color:var(--dsw-alias-brand-primary)}
.eb-hint{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:8px;line-height:1.6}
.eb-preview{margin-top:14px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:12px 14px;background:var(--dsw-alias-bg-base)}
.eb-preview-title{font-weight:600;font-size:13.5px}
.eb-preview-meta{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:4px}
.eb-preview-chapters{margin-top:10px;max-height:200px;overflow:auto;font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.6}
.eb-spinner{display:inline-block;width:14px;height:14px;border-radius:50%;border:2px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 30%, transparent);border-top-color:var(--dsw-alias-brand-primary);animation:eb-spin .8s linear infinite;vertical-align:-2px;margin-right:6px}
@keyframes eb-spin{to{transform:rotate(360deg)}}
@media (max-width:768px){
.eb-modal-card{padding:16px}
}
`;

    async function call(action, payload) {
      const response = await fetch('/api/bot-ebook', {
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
      if (typeof ms !== 'number') return '';
      try { return new Date(ms).toLocaleDateString('zh-CN'); } catch { return ''; }
    }

    // 手机断点与侧栏抽屉共用：桌面收起的侧栏，手机上变成滑出抽屉。
    const isMobile = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(max-width: 768px)').matches : false);

    // ---- markdown: a small parser good enough for book chapters ----
    // Blocks: heading / para / code / math / quote / list / table / hr.
    // Inline runs: text / code / strong / em / del / link.
    const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
    const FENCE_RE = /^\s*(```+|~~~+)\s*([\w+#.-]*)\s*$/;
    const HR_RE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
    const UL_RE = /^(\s*)([-*+])\s+(.*)$/;
    const OL_RE = /^(\s*)(\d+)[.)]\s+(.*)$/;
    const QUOTE_RE = /^\s{0,3}>\s?(.*)$/;
    const TABLE_SEP_RE = /^\s*\|?[\s:|-]*-[\s:|-]*\|[\s:|-]*$/;

    const INLINE_RE = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|~~([^~\n]+)~~|\[([^\]\n]+)\]\(([^)\s]+)\)/g;

    function parseInline(source) {
      const text = String(source || '');
      const runs = [];
      let cursor = 0;
      INLINE_RE.lastIndex = 0;
      let match;
      while ((match = INLINE_RE.exec(text))) {
        if (match.index > cursor) runs.push({ type: 'text', text: text.slice(cursor, match.index) });
        if (match[1] !== undefined) runs.push({ type: 'code', text: match[1] });
        else if (match[2] !== undefined) runs.push({ type: 'strong', text: match[2] });
        else if (match[3] !== undefined) runs.push({ type: 'strong', text: match[3] });
        else if (match[4] !== undefined) runs.push({ type: 'em', text: match[4] });
        else if (match[5] !== undefined) runs.push({ type: 'del', text: match[5] });
        else runs.push({ type: 'link', text: match[6], href: match[7] });
        cursor = INLINE_RE.lastIndex;
      }
      if (cursor < text.length) runs.push({ type: 'text', text: text.slice(cursor) });
      return runs;
    }

    function splitRow(line) {
      return line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'));
    }

    function parseMarkdown(source) {
      const lines = String(source || '').replace(/\r\n?/g, '\n').split('\n');
      const blocks = [];
      const isBlockStart = line => HEADING_RE.test(line) || FENCE_RE.test(line) || HR_RE.test(line)
        || QUOTE_RE.test(line) || UL_RE.test(line) || OL_RE.test(line) || /^\s*\|/.test(line) || /^\s*\$\$/.test(line);
      let i = 0;
      while (i < lines.length) {
        const line = lines[i];
        if (!line.trim()) { i += 1; continue; }

        // 行间公式：单独一行的 $$ … $$
        if (/^\s*\$\$/.test(line)) {
          const body = [];
          const rest = line.replace(/^\s*\$\$/, '');
          if (rest.trim() && !/\$\$\s*$/.test(rest)) body.push(rest.trim());
          const closesHere = /\$\$\s*$/.test(line) && line.replace(/^\s*\$\$/, '').trim() !== '';
          i += 1;
          if (!closesHere) {
            while (i < lines.length && !/^\s*\$\$\s*$/.test(lines[i])) { body.push(lines[i]); i += 1; }
            i += 1;
          }
          blocks.push({ type: 'math', text: body.join('\n').trim() });
          continue;
        }

        const fence = FENCE_RE.exec(line);
        if (fence) {
          const marker = fence[1].startsWith('~~~') ? '~~~' : '```';
          const lang = fence[2] || '';
          const code = [];
          i += 1;
          while (i < lines.length && !new RegExp(`^\\s*${marker}\\s*$`).test(lines[i])) { code.push(lines[i]); i += 1; }
          i += 1;
          blocks.push({ type: 'code', lang, code: code.join('\n') });
          continue;
        }

        const heading = HEADING_RE.exec(line);
        if (heading) {
          blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].trim() });
          i += 1;
          continue;
        }

        if (HR_RE.test(line)) { blocks.push({ type: 'hr' }); i += 1; continue; }

        if (/^\s*\|/.test(line) && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
          const head = splitRow(line);
          i += 2;
          const rows = [];
          while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(splitRow(lines[i])); i += 1; }
          blocks.push({ type: 'table', head, rows });
          continue;
        }

        if (QUOTE_RE.test(line)) {
          const quoted = [];
          while (i < lines.length) {
            const match = QUOTE_RE.exec(lines[i]);
            if (!match) break;
            quoted.push(match[1]);
            i += 1;
          }
          blocks.push({ type: 'quote', text: quoted.join('\n').trim() });
          continue;
        }

        const ul = UL_RE.exec(line);
        const ol = OL_RE.exec(line);
        if (ul || ol) {
          const ordered = Boolean(ol);
          const items = [];
          while (i < lines.length) {
            const bullet = (ordered ? OL_RE : UL_RE).exec(lines[i]);
            if (!bullet) break;
            const indent = bullet[1].replace(/\t/g, '    ').length;
            items.push({ level: Math.min(3, Math.floor(indent / 2)), text: bullet[3].trim() });
            i += 1;
            // 续行：缩进但没有新 bullet 的行
            while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !UL_RE.test(lines[i]) && !OL_RE.test(lines[i]) && !/^\s*\|/.test(lines[i])) {
              items[items.length - 1].text += ` ${lines[i].trim()}`;
              i += 1;
            }
          }
          blocks.push({ type: 'list', ordered, items });
          continue;
        }

        const para = [line.trim()];
        i += 1;
        while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) { para.push(lines[i].trim()); i += 1; }
        blocks.push({ type: 'para', text: para.join(' ') });
      }
      return blocks;
    }

    /** 把扁平的 list items（带 level）拼成 ul/ol 的树。 */
    function listTree(items) {
      const tree = [];
      const stack = [{ level: -1, list: tree }];
      for (const item of items) {
        while (stack.length > 1 && stack[stack.length - 1].level >= item.level) stack.pop();
        const node = { text: item.text, level: item.level, children: [] };
        stack[stack.length - 1].list.push(node);
        stack.push({ level: item.level, list: node.children });
      }
      return tree;
    }

    /** 章节内的小节（h2/h3），给「本章目录」用。 */
    function sectionOutline(blocks) {
      return blocks
        .map((block, index) => ({ block, index }))
        .filter(({ block }) => block.type === 'heading' && block.level >= 2 && block.level <= 3)
        .map(({ block, index }) => ({ level: block.level, text: block.text, anchor: `eb-sec-${index}` }));
    }

    function renderInline(source) {
      return parseInline(source).map((run, index) => {
        if (run.type === 'code') return h('code', { key: index }, run.text);
        if (run.type === 'strong') return h('strong', { key: index }, run.text);
        if (run.type === 'em') return h('em', { key: index }, run.text);
        if (run.type === 'del') return h('del', { key: index }, run.text);
        if (run.type === 'link') return h('a', { key: index, href: run.href, target: '_blank', rel: 'noreferrer' }, run.text);
        return run.text;
      });
    }

    function renderListNodes(nodes, ordered, keyPrefix) {
      const children = nodes.map((node, index) => h('li', { key: `${keyPrefix}-${index}` },
        renderInline(node.text),
        node.children.length ? renderListNodes(node.children, ordered, `${keyPrefix}-${index}`) : null));
      return h(ordered ? 'ol' : 'ul', { key: keyPrefix }, children);
    }

    function renderBlocks(blocks) {
      return blocks.map((block, index) => {
        if (block.type === 'heading') {
          const level = Math.max(1, Math.min(6, block.level));
          return h(`h${level}`, { key: index, id: `eb-sec-${index}`, className: 'eb-h' }, renderInline(block.text));
        }
        if (block.type === 'para') return h('p', { key: index }, renderInline(block.text));
        if (block.type === 'code') return h('pre', { key: index }, h('code', null, block.code));
        if (block.type === 'math') return h('div', { key: index, className: 'eb-math' }, block.text);
        if (block.type === 'quote') return h('blockquote', { key: index }, renderBlocks(parseMarkdown(block.text)));
        if (block.type === 'hr') return h('hr', { key: index });
        if (block.type === 'list') {
          return h(React.Fragment, { key: index }, renderListNodes(listTree(block.items), block.ordered, `l${index}`));
        }
        if (block.type === 'table') {
          return h('table', { key: index },
            h('thead', null, h('tr', null, block.head.map((cell, cellIndex) => h('th', { key: cellIndex }, renderInline(cell))))),
            h('tbody', null, block.rows.map((row, rowIndex) => h('tr', { key: rowIndex },
              row.map((cell, cellIndex) => h('td', { key: cellIndex }, renderInline(cell)))))));
        }
        return null;
      });
    }

    function ErrorBox({ error, onRetry }) {
      return h('div', { className: 'eb-error' },
        h('div', { className: 'eb-error-title' }, error.code === 'NOT_FOUND' ? '找不到内容' : '操作失败'),
        h('div', { className: 'eb-error-detail' }, error.message),
        onRetry ? h('button', { className: 'eb-btn', type: 'button', onClick: onRetry, style: { marginTop: 10 } }, '重试') : null);
    }

    function Icon({ size }) {
      const s = size || 16;
      return h('svg', { width: s, height: s, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('path', { d: 'M4 5.5A1.5 1.5 0 0 1 5.5 4H10v16H5.5A1.5 1.5 0 0 1 4 18.5z' }),
        h('path', { d: 'M14 4h4.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H14z' }),
        h('path', { d: 'M10 4h4v16h-4z' }));
    }

    function groupChapters(chapters) {
      const groups = [];
      for (const chapter of chapters || []) {
        const name = chapter.groupName || '正文';
        let group = groups.find(item => item.name === name);
        if (!group) { group = { name, items: [] }; groups.push(group); }
        group.items.push(chapter);
      }
      return groups;
    }

    function BookCard({ book, onOpen }) {
      const total = book.chapterCount || 1;
      const read = book.progress ? Math.min(total, book.progress.idx + 1) : 0;
      const percent = Math.round((read / total) * 100);
      return h('button', { type: 'button', className: 'eb-card', onClick: () => onOpen(book.id) },
        h('div', { className: 'eb-card-title' }, book.title),
        book.author ? h('div', { className: 'eb-card-author' }, book.author) : null,
        h('div', { className: 'eb-card-meta' },
          h('span', null, `${book.chapterCount} 章`),
          h('span', null, `${Math.max(1, Math.round(book.chars / 1000))}k 字`),
          read ? h('span', { className: 'eb-read-dot' }) : null,
          read ? h('span', null, `读到 ${read}/${book.chapterCount}`) : null),
        h('div', { className: 'eb-bar' }, h('i', { style: { width: `${percent}%` } })),
        h('div', { className: 'eb-card-cta' }, read ? '继续阅读 →' : '开始阅读 →'));
    }

    /** 首页：先选书。搜索也在这一层，搜到哪一章可以直接点进去。 */
    function Library({ meta, error, onReload, onOpen }) {
      const [query, setQuery] = React.useState('');
      const [hits, setHits] = React.useState(null);
      const [importing, setImporting] = React.useState(false);
      const timer = React.useRef(null);
      const search = (text) => {
        setQuery(text);
        if (timer.current) clearTimeout(timer.current);
        const keyword = text.trim();
        if (!keyword) { setHits(null); return; }
        timer.current = setTimeout(async () => {
          try {
            const value = await call('search', { query: keyword, limit: 20 });
            setHits(value.hits || []);
          } catch { setHits([]); }
        }, 220);
      };
      const books = meta?.books || [];
      const chapters = books.reduce((sum, book) => sum + (book.chapterCount || 0), 0);
      return h('div', { className: 'eb-root' },
        h('div', { className: 'eb-main' },
          h('div', { className: 'eb-head' },
            h('span', { className: 'eb-head-title' }, '电子书'),
            books.length ? h('span', { className: 'eb-head-count' }, `${books.length} 本 · ${chapters} 章`) : null,
            h('button', { className: 'eb-btn', type: 'button', onClick: () => setImporting(true) }, '导入'),
            h('span', { className: 'eb-spacer' }),
            h('input', {
              className: 'eb-lib-search', value: query, placeholder: '全书搜索…',
              onChange: event => search(event.target.value),
            })),
          h('div', { className: 'eb-lib' },
            error ? h(ErrorBox, { error, onRetry: onReload }) : null,
            hits
              ? h('div', null,
                h('div', { className: 'eb-lib-head' },
                  h('span', { className: 'eb-lib-title' }, `“${query.trim()}” 搜到 ${hits.length} 处`)),
                hits.length
                  ? hits.map((hit, index) => h('button', {
                    key: `${hit.bookId}-${hit.idx}-${index}`, type: 'button', className: 'eb-hit eb-hit-wide',
                    onClick: () => onOpen(hit.bookId, hit.idx),
                  },
                    h('div', { className: 'eb-hit-title' }, hit.title),
                    h('div', { className: 'eb-hit-snippet' }, hit.snippet)))
                  : h('div', { className: 'eb-empty' }, '没搜到。'))
              : books.length
                ? h('div', null,
                  h('div', { className: 'eb-lib-head' }, h('span', { className: 'eb-lib-title' }, '书库')),
                  h('div', { className: 'eb-grid' }, books.map(book => h(BookCard, { key: book.id, book, onOpen }))))
                : h('div', { className: 'eb-empty' },
                  '书库是空的。',
                  h('div', { style: { marginTop: 10 } }, '点右上角「导入」，上传 PDF / 贴网页链接，或跑 ',
                    h('code', null, 'node scripts/import-pmpp.mjs'), ' 导入 markdown 书稿。')))),
        importing ? h(ImportDialog, {
          onClose: () => setImporting(false),
          onDone: () => { setImporting(false); onReload(); },
        }) : null);
    }

    /** 阅读器：左侧目录 + 正文；一进来回到上次读到的位置。 */
    function Reader({ bookId, startIdx, onBack, onOpenOther }) {
      const [bookData, setBookData] = React.useState(null);
      const [content, setContent] = React.useState(null);
      const [query, setQuery] = React.useState('');
      const [hits, setHits] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [sectionsOpen, setSectionsOpen] = React.useState(false);
      const [navOpen, setNavOpen] = React.useState(false); // 手机：目录抽屉
      const [tocCollapsed, setTocCollapsed] = React.useState(false); // 桌面：目录收起
      const bodyRef = React.useRef(null);
      const saveTimer = React.useRef(null);
      const searchTimer = React.useRef(null);

      const openChapter = React.useCallback(async (idx, options = {}) => {
        setError(null);
        try {
          const value = await call('chapter', { bookId, idx });
          setContent(value);
          setSectionsOpen(false);
          setNavOpen(false);
          requestAnimationFrame(() => {
            const element = bodyRef.current;
            if (element) element.scrollTop = options.offset || 0;
          });
          if (!options.keepProgress) call('progress', { bookId, idx: value.chapter.idx, offset: 0 }).catch(() => {});
        } catch (caught) { setError(caught); }
      }, [bookId]);

      // 同一个「目录」按钮：桌面切换收起/展开，手机切换抽屉开/关。
      const toggleToc = () => {
        if (isMobile()) setNavOpen(open => !open);
        else setTocCollapsed(collapsed => !collapsed);
      };

      React.useEffect(() => {
        let cancelled = false;
        (async () => {
          setError(null);
          try {
            const value = await call('book', { id: bookId });
            if (cancelled) return;
            setBookData(value);
            const fromList = typeof startIdx === 'number' && startIdx >= 0;
            const idx = fromList ? startIdx : (value.progress ? value.progress.idx : 0);
            const offset = fromList ? 0 : (value.progress ? value.progress.offset : 0);
            // 恢复上次位置时不要重置进度（keepProgress），否则刚还原又被写回 0。
            await openChapter(idx, { offset, keepProgress: true });
          } catch (caught) { if (!cancelled) setError(caught); }
        })();
        return () => { cancelled = true; };
      }, [bookId, startIdx, openChapter]);

      const onBodyScroll = () => {
        if (!content) return;
        if (saveTimer.current) clearTimeout(saveTimer.current);
        const idx = content.chapter.idx;
        saveTimer.current = setTimeout(() => {
          const element = bodyRef.current;
          call('progress', { bookId, idx, offset: element ? Math.round(element.scrollTop) : 0 }).catch(() => {});
        }, 500);
      };

      const onSearch = (text) => {
        setQuery(text);
        if (searchTimer.current) clearTimeout(searchTimer.current);
        const keyword = text.trim();
        if (!keyword) { setHits(null); return; }
        searchTimer.current = setTimeout(async () => {
          try {
            const value = await call('search', { query: keyword, limit: 20 });
            setHits(value.hits || []);
          } catch { setHits([]); }
        }, 220);
      };

      const jumpToHit = (hit) => {
        if (hit.bookId === bookId) openChapter(hit.idx, {});
        else onOpenOther(hit.bookId, hit.idx);
      };

      React.useEffect(() => {
        if (!content) return undefined;
        const onKey = (event) => {
          const tag = event.target && event.target.tagName;
          if (tag === 'INPUT' || tag === 'TEXTAREA' || event.target?.isContentEditable) return;
          if (event.key === 'ArrowLeft' && content.prev) openChapter(content.prev.idx, {});
          if (event.key === 'ArrowRight' && content.next) openChapter(content.next.idx, {});
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [content, openChapter]);

      const groups = groupChapters(bookData?.chapters || []);
      const blocks = React.useMemo(() => (content ? parseMarkdown(content.chapter.body) : []), [content]);
      const outline = React.useMemo(() => sectionOutline(blocks), [blocks]);

      return h('div', { className: 'eb-root' },
        h('div', { className: 'eb-side', 'data-collapsed': String(tocCollapsed), 'data-open': String(navOpen) },
          h('div', { style: { padding: '10px 10px 0' } },
            bookData ? h('div', { className: 'eb-side-book' }, bookData.book.title) : null),
          h('div', { className: 'eb-search' }, h('input', {
            value: query, placeholder: '全书搜索…',
            onChange: event => onSearch(event.target.value),
          })),
          hits && hits.length ? h('div', { className: 'eb-hits' }, hits.map((hit, index) => h('button', {
            key: `${hit.bookId}-${hit.idx}-${index}`, type: 'button', className: 'eb-hit', onClick: () => jumpToHit(hit),
          },
            h('div', { className: 'eb-hit-title' }, hit.title),
            h('div', { className: 'eb-hit-snippet' }, hit.snippet)))) : null,
          hits && !hits.length ? h('div', { className: 'eb-hits' }, h('div', { className: 'eb-book-meta' }, '没搜到')) : null,
          h('div', { className: 'eb-side-scroll' },
            h('div', { className: 'eb-side-title' }, '目录'),
            groups.map(group => h('div', { key: group.name },
              h('div', { className: 'eb-toc-group' }, group.name),
              group.items.map(chapter => h('button', {
                key: chapter.idx, type: 'button', className: 'eb-toc-item',
                'data-active': String(content && content.chapter.idx === chapter.idx),
                onClick: () => openChapter(chapter.idx, {}),
              },
                h('span', { className: 'eb-toc-num' }, String(chapter.idx + 1)),
                h('span', null, chapter.title))))))),
        navOpen ? h('div', { className: 'eb-scrim', onClick: () => setNavOpen(false) }) : null,
        h('div', { className: 'eb-main' },
          h('div', { className: 'eb-head' },
            h('button', { className: 'eb-btn', type: 'button', onClick: onBack, title: '返回书库' }, '← 书库'),
            h('button', { className: 'eb-btn eb-toc-toggle', type: 'button', onClick: toggleToc, title: '目录' }, '☰ 目录'),
            h('button', { className: 'eb-btn', type: 'button', disabled: !content || !content.prev, onClick: () => content && content.prev && openChapter(content.prev.idx, {}) }, '← 上一章'),
            h('span', { className: 'eb-head-title' }, content ? content.chapter.title : (bookData ? bookData.book.title : '正在读取…')),
            outline.length ? h('button', { className: 'eb-btn eb-sec-toggle', type: 'button', onClick: () => setSectionsOpen(open => !open) }, '本章目录') : null,
            h('button', { className: 'eb-btn', type: 'button', disabled: !content || !content.next, onClick: () => content && content.next && openChapter(content.next.idx, {}) }, '下一章 →')),
          sectionsOpen && outline.length ? h('div', { className: 'eb-sec-menu' }, outline.map(section => h('button', {
            key: section.anchor, type: 'button', className: 'eb-sec-item', 'data-level': String(section.level),
            onClick: () => {
              setSectionsOpen(false);
              const target = document.getElementById(section.anchor);
              if (target) target.scrollIntoView({ block: 'start', behavior: 'smooth' });
            },
          }, section.text))) : null,
          h('div', { className: 'eb-body', ref: bodyRef, onScroll: onBodyScroll },
            error ? h(ErrorBox, { error, onRetry: () => openChapter(content ? content.chapter.idx : 0, {}) }) : null,
            content
              ? h('div', { className: 'eb-article' }, renderBlocks(blocks))
              : h('div', { className: 'eb-empty' }, '正在读取…')),
          content ? h('div', { className: 'eb-foot' },
            h('span', null, `${content.position.index + 1} / ${content.position.total} · ${Math.round(content.chapter.chars / 1000) || 1}k 字`),
            h('span', null, content.book.author || '')) : null));
    }

    /** 导入对话框：上传文件 / 贴链接 → 模型转换 → 预览 → 确认入库。 */
    function ImportDialog({ onClose, onDone }) {
      const [tab, setTab] = React.useState('file');
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);
      const [preview, setPreview] = React.useState(null);
      const [url, setUrl] = React.useState('');
      const [dragging, setDragging] = React.useState(false);
      const fileRef = React.useRef(null);

      const doImportFile = async (file) => {
        if (!file) return;
        setBusy(true); setError(null); setPreview(null);
        try {
          const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = () => reject(new Error('读取文件失败'));
            reader.readAsDataURL(file);
          });
          const value = await call('import_file', { name: file.name, mime: file.type, data: dataUrl });
          setPreview(value.preview);
        } catch (caught) { setError(caught); } finally { setBusy(false); }
      };

      const doImportUrl = async () => {
        if (!url.trim()) return;
        setBusy(true); setError(null); setPreview(null);
        try {
          const value = await call('import_url', { url: url.trim() });
          setPreview(value.preview);
        } catch (caught) { setError(caught); } finally { setBusy(false); }
      };

      const commit = async () => {
        if (!preview) return;
        setBusy(true); setError(null);
        try {
          await call('import_commit', { preview });
          onDone();
        } catch (caught) { setError(caught); } finally { setBusy(false); }
      };

      return h('div', { className: 'eb-modal', onClick: event => { if (event.target === event.currentTarget) onClose(); } },
        h('div', { className: 'eb-modal-card' },
          h('div', { className: 'eb-modal-head' },
            h('span', { className: 'eb-modal-title' }, '导入一本书'),
            h('button', { className: 'eb-modal-close', type: 'button', onClick: onClose }, '✕')),
          h('div', { className: 'eb-tabs' },
            h('button', { className: 'eb-tabbtn', 'data-active': String(tab === 'file'), type: 'button', onClick: () => setTab('file') }, '上传文件'),
            h('button', { className: 'eb-tabbtn', 'data-active': String(tab === 'url'), type: 'button', onClick: () => setTab('url') }, '贴链接')),
          tab === 'file'
            ? h('div', null,
              h('div', {
                className: 'eb-drop', style: dragging ? { borderColor: 'var(--dsw-alias-brand-primary)' } : null,
                onClick: () => fileRef.current && fileRef.current.click(),
                onDragOver: event => { event.preventDefault(); setDragging(true); },
                onDragLeave: () => setDragging(false),
                onDrop: event => { event.preventDefault(); setDragging(false); doImportFile(event.dataTransfer.files[0]); },
              }, busy ? h('span', null, h('span', { className: 'eb-spinner' }), '正在用模型转换…') : '点这里选文件，或拖进来（PDF / EPUB / markdown / txt）'),
              h('input', {
                ref: fileRef, type: 'file', accept: '.pdf,.epub,.md,.markdown,.txt,.html,.htm', style: { display: 'none' },
                onChange: event => { doImportFile(event.target.files[0]); event.target.value = ''; },
              }),
              h('div', { className: 'eb-hint' }, 'PDF 只吃「文字版」（能选中复制的那种）；纯扫描件抽不出字。'))
            : h('div', null,
              h('input', {
                className: 'eb-field', value: url, placeholder: 'https://…（一篇网页 / 文档页）',
                onChange: event => setUrl(event.target.value),
                onKeyDown: event => { if (event.key === 'Enter') doImportUrl(); },
              }),
              h('div', { style: { marginTop: 10 } },
                h('button', { className: 'eb-btn', type: 'button', disabled: busy || !url.trim(), onClick: doImportUrl }, '抓取并转换'))),
          error ? h('div', { style: { marginTop: 12 } }, h(ErrorBox, { error })) : null,
          preview ? h('div', { className: 'eb-preview' },
            h('div', { className: 'eb-preview-title' }, preview.book.title || '（未命名）'),
            h('div', { className: 'eb-preview-meta' }, `${preview.chapters.length} 章 · ${preview.book.source || ''}`),
            h('div', { className: 'eb-preview-chapters' },
              preview.chapters.slice(0, 60).map((chapter, index) => h('div', { key: index }, chapter.title))),
            h('div', { style: { marginTop: 12 } },
              h('button', { className: 'eb-btn', 'data-kind': 'primary', type: 'button', disabled: busy, onClick: commit }, '确认入库'))) : null));
    }

    function Panel() {
      const [meta, setMeta] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [route, setRoute] = React.useState(null); // null = 书库首页

      const loadMeta = React.useCallback(async () => {
        setError(null);
        try {
          const value = await call('meta');
          setMeta(value);
          return value;
        } catch (caught) { setError(caught); return null; }
      }, []);

      React.useEffect(() => { loadMeta(); }, [loadMeta]);

      const openBook = React.useCallback((nextBookId, idx) => {
        setRoute({
          bookId: nextBookId,
          idx: typeof idx === 'number' ? idx : null,
          stamp: Date.now(),
        });
        // 回到阅读器顶部：不同书/同一本书换章都重新挂载 Reader。
      }, []);

      const back = React.useCallback(() => { setRoute(null); loadMeta(); }, [loadMeta]);

      if (error && !meta) return h('div', { className: 'eb-root' }, h('div', { className: 'eb-main' },
        h('div', { className: 'eb-head' }, h('span', { className: 'eb-head-title' }, '电子书')),
        h('div', { className: 'eb-body' }, h(ErrorBox, { error, onRetry: loadMeta }))));
      if (route) return h(Reader, {
        key: `${route.bookId}:${route.stamp}`, bookId: route.bookId, startIdx: route.idx,
        onBack: back, onOpenOther: openBook,
      });
      return h(Library, { meta, error, onReload: loadMeta, onOpen: openBook });
    }

    function apply(ctx) {
      const style = document.createElement('style');
      style.textContent = CSS;
      document.head.appendChild(style);
      ctx.effect(() => () => style.remove(), 'bot-ebook: styles');
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist', id: 'bot-ebook', label: () => '电子书', order: 40,
      }, Icon));
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main', key: 'bot-ebook',
      }, Panel));
    }

    return { inject: ['slots'], apply };
  },
});
