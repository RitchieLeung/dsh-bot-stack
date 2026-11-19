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
    const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
    const PRIORITY_META = {
      P0: { label: 'P0', desc: '紧急', color: 'var(--dsw-alias-state-error-primary)', solid: true },
      P1: { label: 'P1', desc: '高', color: 'var(--dsw-alias-state-warn-primary)', solid: false },
      P2: { label: 'P2', desc: '中', color: 'var(--dsw-alias-state-business-primary)', solid: false },
      P3: { label: 'P3', desc: '低', color: 'var(--dsw-alias-label-tertiary)', solid: false },
    };
    // Actions available from each status. start = 派工（走 dispatch_work 桥接）。
    const ACTIONS = {
      open: [['start', '启动'], ['discussing', '标记讨论'], ['cancelled', '取消']],
      discussing: [['start', '启动'], ['open', '回待处理'], ['cancelled', '取消']],
      dispatched: [['start', '重派'], ['open', '打回待处理'], ['cancelled', '取消']],
      in_review: [['done', '验收通过'], ['reject', '打回重做'], ['cancelled', '取消']],
      done: [['open', '重开']],
      failed: [['open', '重试'], ['cancelled', '取消']],
      cancelled: [['open', '重开']],
    };

    const CSS = `
.is-root{position:relative;display:flex;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;-webkit-font-smoothing:antialiased}
.is-side{width:216px;flex:none;border-right:1px solid var(--dsw-alias-border-l1);overflow:auto;padding:14px 10px;background:var(--dsw-specific-sidebar-fill);display:flex;flex-direction:column}
.is-side-title{font-size:11px;font-weight:700;letter-spacing:.04em;color:var(--dsw-alias-label-secondary);padding:2px 8px 8px;text-transform:uppercase}
.is-new{display:flex;align-items:center;justify-content:center;gap:6px;border:0;color:var(--dsw-alias-label-primary-foreground, #fff);background:var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary));padding:8px 12px;border-radius:9px;cursor:pointer;font-size:13px;font-weight:600;margin:0 2px 14px;box-shadow:0 1px 2px color-mix(in srgb, var(--dsw-alias-brand-primary) 24%, transparent)}
.is-new:hover{background:var(--dsw-alias-button-primary-hover, var(--dsw-alias-brand-primary))}
.is-new:active{opacity:.9}
.is-filter{display:flex;align-items:center;gap:8px;width:100%;text-align:left;border:0;background:transparent;color:var(--dsw-alias-label-primary);padding:7px 8px;border-radius:8px;cursor:pointer;font-size:13px}
.is-filter:hover{background:var(--dsw-alias-bg-layer-2)}
.is-filter[data-active="true"]{background:var(--dsw-alias-bg-layer-2);font-weight:600}
.is-filter-dot{width:7px;height:7px;border-radius:50%;flex:none}
.is-filter-count{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border-radius:999px;padding:0 7px;line-height:18px;font-variant-numeric:tabular-nums}
.is-filter[data-active="true"] .is-filter-count{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground, #fff)}
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
button:has(.is-unread){position:relative}
.is-unread{position:absolute;right:12px;top:50%;transform:translateY(-50%);min-width:16px;height:16px;padding:0 4px;border-radius:999px;background:var(--dsw-alias-state-error-primary);color:#fff;font-size:10px;font-weight:700;line-height:16px;text-align:center;font-variant-numeric:tabular-nums;box-sizing:border-box;box-shadow:0 1px 2px rgba(0,0,0,.2)}
button:has(.is-unread):not(:has(> span + span)) .is-unread{right:3px;top:1px;transform:none}
.is-empty{color:var(--dsw-alias-label-secondary);padding:48px 0;text-align:center;font-size:13px}
.is-error{margin:32px auto;max-width:520px;border:1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, transparent);background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent);border-radius:12px;padding:16px}
.is-error-title{color:var(--dsw-alias-state-error-primary);font-weight:700;margin-bottom:8px;font-size:13px}
.is-detail{font-size:11px;color:var(--dsw-alias-label-secondary);word-break:break-all;margin:8px 0;line-height:1.5}
.is-field{width:100%;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:9px 11px;border-radius:9px;font-size:13px;box-sizing:border-box;font-family:inherit;line-height:1.5}
.is-field:focus{outline:0;border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary) 16%, transparent)}
.is-label{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);margin:14px 0 6px;display:block}
.is-btn{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);padding:6px 14px;border-radius:8px;cursor:pointer;font-size:12.5px;font-weight:500;margin-right:8px;transition:background-color .1s,border-color .1s,color .1s}
.is-btn:hover{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.is-btn:disabled{opacity:.45;cursor:default}
.is-btn[data-kind="primary"]{border-color:transparent;background:var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary));color:var(--dsw-alias-label-primary-foreground, #fff);font-weight:600}
.is-btn[data-kind="primary"]:hover{background:var(--dsw-alias-button-primary-hover, var(--dsw-alias-brand-primary));color:var(--dsw-alias-label-primary-foreground, #fff)}
.is-btn[data-kind="danger"]{border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, transparent);color:var(--dsw-alias-state-error-primary)}
.is-btn[data-kind="danger"]:hover{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.is-body-text{white-space:pre-wrap;line-height:1.7;margin:10px 0;font-size:13px}
.is-result{margin:14px 0 0;padding:11px 14px;border-radius:10px;background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 9%, var(--dsw-alias-bg-base));border:1px solid color-mix(in srgb, var(--dsw-alias-state-success-primary) 24%, transparent)}
.is-result-label{font-size:11px;font-weight:700;color:var(--dsw-alias-state-success-primary);margin-bottom:4px;letter-spacing:.02em}
.is-result-text{white-space:pre-wrap;line-height:1.6;font-size:13px}
.is-sec{margin-top:20px;font-size:12px;font-weight:700;color:var(--dsw-alias-label-secondary);letter-spacing:.02em}
.is-tl{position:relative;margin:4px 0 0;padding-left:22px}
.is-tl::before{content:"";position:absolute;left:6px;top:12px;bottom:12px;width:2px;background:var(--dsw-alias-border-l1);border-radius:99px}
.is-tl-item{position:relative;margin-bottom:10px;padding:10px 13px;border-radius:10px;background:color-mix(in srgb, var(--tlc, var(--dsw-alias-brand-primary)) 8%, var(--dsw-alias-bg-base));border:1px solid color-mix(in srgb, var(--tlc, var(--dsw-alias-brand-primary)) 24%, var(--dsw-alias-border-l1));border-left:3px solid var(--tlc, var(--dsw-alias-brand-primary))}
.is-tl-item:last-child{margin-bottom:0}
.is-tl-item::before{content:"";position:absolute;left:-24px;top:14px;width:12px;height:12px;box-sizing:border-box;border-radius:50%;background:var(--tlc, var(--dsw-alias-bg-layer-2));border:2px solid var(--dsw-alias-bg-layer-1);box-shadow:0 0 0 1px color-mix(in srgb, var(--tlc, var(--dsw-alias-border-l2)) 55%, transparent)}
.is-tl-item[data-system="true"]{padding:7px 12px;background:var(--dsw-alias-bg-base);border:1px dashed color-mix(in srgb, var(--tlc) 35%, var(--dsw-alias-border-l1));border-left:3px solid var(--tlc)}
.is-tl-item[data-system="true"]::before{top:11px}
.is-tl-item[data-system="true"] .is-tl-body{font-size:12px;color:var(--dsw-alias-label-secondary)}
.is-tl-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-secondary);margin-bottom:5px}
.is-tl-author{display:inline-flex;align-items:center;gap:5px;font-weight:700;font-size:11.5px;color:color-mix(in srgb, var(--tlc) 76%, var(--dsw-alias-label-primary));background:color-mix(in srgb, var(--tlc) 14%, transparent);padding:1px 8px;border-radius:999px}
.is-tl-author-dot{width:6px;height:6px;border-radius:50%;background:var(--tlc);flex:none}
.is-tl-time{font-size:11px;color:var(--dsw-alias-label-secondary)}
.is-tl-kind{display:inline-block;font-size:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:4px;padding:0 5px;line-height:15px;font-weight:600}
.is-tl-kind[data-kind="status"],.is-tl-kind[data-kind="assign"]{color:color-mix(in srgb, var(--tlc) 76%, var(--dsw-alias-label-primary));background:color-mix(in srgb, var(--tlc) 14%, transparent);border-color:color-mix(in srgb, var(--tlc) 35%, transparent)}
.is-tl-kind[data-kind="result"]{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 30%, transparent)}
.is-tl-kind[data-kind="reject"]{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 30%, transparent)}
.is-tl-reply{margin-left:4px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:11px;padding:1px 6px;border-radius:5px;font-family:inherit}
.is-tl-reply:hover{color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2)}
.is-tl-quote{display:block;width:100%;text-align:left;border:0;border-left:2.5px solid var(--qtc, var(--dsw-alias-brand-primary));background:color-mix(in srgb, var(--qtc, var(--dsw-alias-brand-primary)) 8%, var(--dsw-alias-bg-base));color:var(--dsw-alias-label-secondary);padding:4px 9px;border-radius:0 6px 6px 0;font-size:11.5px;line-height:1.45;margin:3px 0 6px;cursor:pointer;font-family:inherit;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.is-tl-quote:hover{color:var(--dsw-alias-label-primary);background:color-mix(in srgb, var(--qtc, var(--dsw-alias-brand-primary)) 14%, var(--dsw-alias-bg-base))}
.is-tl-item[data-flash="true"]{box-shadow:0 0 0 2px var(--tlc, var(--dsw-alias-brand-primary));background:color-mix(in srgb, var(--tlc, var(--dsw-alias-brand-primary)) 18%, var(--dsw-alias-bg-layer-1));transition:background .3s,box-shadow .3s}
.is-reply-banner{display:flex;align-items:center;gap:8px;padding:6px 10px;margin:6px 0 8px;border-left:3px solid var(--dsw-alias-brand-primary);border-radius:0 8px 8px 0;background:var(--dsw-alias-bg-layer-1);font-size:12px;color:var(--dsw-alias-label-secondary)}
.is-reply-banner-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.is-reply-cancel{border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:15px;line-height:1;padding:0 3px}
.is-reply-cancel:hover{color:var(--dsw-alias-state-error-primary)}
.is-tl-body{white-space:pre-wrap;line-height:1.6;font-size:13px}
.is-mention{color:var(--dsw-alias-brand-primary);font-weight:600}
.is-mfield{position:relative}
.is-mmenu{position:absolute;left:0;right:0;top:calc(100% - 1px);z-index:30;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:9px;box-shadow:0 12px 30px color-mix(in srgb, #000 20%, transparent);padding:4px;max-height:216px;overflow:auto}
.is-mitem{display:flex;align-items:center;gap:8px;width:100%;border:0;background:transparent;color:var(--dsw-alias-label-primary);text-align:left;padding:6px 9px;border-radius:7px;cursor:pointer;font-size:13px;font-family:inherit}
.is-mitem[data-active="true"],.is-mitem:hover{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground, #fff)}
.is-mitem-name{font-weight:600}
.is-mitem-id{margin-left:auto;font-size:11px;opacity:.6}
.is-md{line-height:1.75;font-size:13px;word-break:break-word}
.is-md p{margin:0 0 10px}
.is-md p:last-child{margin-bottom:0}
.is-md h1,.is-md h2,.is-md h3,.is-md h4{margin:16px 0 8px;line-height:1.4}
.is-md h1{font-size:18px}.is-md h2{font-size:16px}.is-md h3{font-size:14.5px}.is-md h4{font-size:13.5px}
.is-md ul,.is-md ol{margin:0 0 10px;padding-left:22px}
.is-md li{margin:3px 0}
.is-md code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.3px}
.is-md p code,.is-md li code,.is-md td code{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:5px;padding:1px 5px}
.is-md pre{margin:0 0 12px;padding:11px 13px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:9px;overflow:auto;line-height:1.55}
.is-md pre code{font-size:12.3px;white-space:pre}
.is-md blockquote{margin:0 0 12px;padding:2px 0 2px 12px;border-left:3px solid var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-secondary)}
.is-md blockquote p{margin:0 0 4px}
.is-md hr{border:0;border-top:1px solid var(--dsw-alias-border-l1);margin:16px 0}
.is-md table{border-collapse:collapse;margin:0 0 12px;font-size:12.5px;display:block;overflow:auto;max-width:100%}
.is-md th,.is-md td{border:1px solid var(--dsw-alias-border-l1);padding:5px 10px;text-align:left;vertical-align:top}
.is-md th{background:var(--dsw-alias-bg-layer-2);font-weight:600;white-space:nowrap}
.is-md a{color:var(--dsw-alias-brand-primary);text-decoration:none}
.is-md a:hover{text-decoration:underline}
.is-md img{max-width:100%;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);margin:6px 0;display:block}
.is-md .is-math{padding:10px 12px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:9px;font-family:ui-monospace,Menlo,monospace;font-size:12.3px;white-space:pre-wrap;margin:0 0 12px;color:var(--dsw-alias-label-secondary)}
.is-ref{color:var(--dsw-alias-brand-primary);font-weight:600;cursor:pointer;font-variant-numeric:tabular-nums}
.is-ref:hover{text-decoration:underline}
.is-editor{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:9px;overflow:hidden;transition:border-color .12s,box-shadow .12s}
.is-editor:focus-within{border-color:var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary));box-shadow:0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)) 16%, transparent)}
.is-editor-bar{display:flex;align-items:center;gap:2px;flex-wrap:wrap;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.is-editor-sel{border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-primary);border-radius:6px;padding:3px 6px;font-size:12px;font-family:inherit;cursor:pointer;line-height:1.4}
.is-editor-sel:hover,.is-editor-sel:focus{outline:0;background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l1)}
.is-editor-sel option{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.is-editor-sep{width:1px;height:16px;background:var(--dsw-alias-border-l1);margin:0 4px;flex:none}
.is-editor-btn{display:inline-flex;align-items:center;justify-content:center;min-width:26px;height:26px;padding:0 6px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:6px;cursor:pointer;font-size:12.5px;font-family:inherit;line-height:1;transition:background-color .1s,color .1s}
.is-editor-btn:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.is-editor-input{display:block;width:100%;border:0;background:transparent;color:var(--dsw-alias-label-primary);padding:10px 12px;font-size:13px;font-family:inherit;line-height:1.6;box-sizing:border-box;resize:vertical;min-height:84px}
.is-editor-input:focus{outline:0}
.is-editor-foot{display:flex;align-items:center;gap:8px;padding:4px 12px;border-top:1px solid var(--dsw-alias-border-l1);font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.is-editor-md{margin-left:auto;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10.5px;font-weight:700;padding:1px 5px;border:1px solid var(--dsw-alias-border-l2);border-radius:4px;line-height:1.3;color:var(--dsw-alias-label-secondary);flex:none;cursor:help}
.is-upbusy{font-size:11.5px;color:var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary))}
.is-tagrow{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.is-tag{display:inline-flex;align-items:center;gap:3px;border:1px solid var(--dsw-alias-border-l1);background:transparent;border-radius:999px;padding:2px 8px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer;user-select:none;transition:border-color .1s,color .1s}
.is-tag:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.is-tag[data-active="true"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);background:color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent);font-weight:600}
.is-tag-del{display:none;border:0;background:transparent;color:inherit;cursor:pointer;font-size:12px;line-height:1;padding:0 0 0 1px;opacity:.65}
.is-tag:hover .is-tag-del{display:inline-block}
.is-tag-del:hover{opacity:1;color:var(--dsw-alias-state-error-primary)}
.is-taginput{border:1px dashed var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:999px;padding:3px 10px;font-size:12px;font-family:inherit;min-width:96px}
.is-taginput:focus{outline:0;border-style:solid;border-color:var(--dsw-alias-brand-primary)}
.is-blocks{display:flex;flex-direction:column;gap:14px;max-width:960px}
.is-block{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:12px;padding:16px 18px}
.is-block-head{display:flex;align-items:center;gap:8px;font-size:12.5px;font-weight:700;color:var(--dsw-alias-label-secondary);margin:0 0 12px;letter-spacing:.02em}
.is-block-count{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:0 7px;line-height:17px;font-variant-numeric:tabular-nums}
.is-meta-grid{display:flex;flex-direction:column;gap:8px}
.is-meta-row{display:flex;align-items:flex-start;gap:12px}
.is-meta-k{width:64px;flex:none;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);line-height:24px}
.is-meta-v{flex:1;min-width:0;display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-height:24px}
.is-block-body{margin-top:14px;padding-top:14px;border-top:1px solid var(--dsw-alias-border-l1)}
.is-composer{margin-top:16px;padding-top:14px;border-top:1px solid var(--dsw-alias-border-l1)}
.is-composer .is-editor{background:var(--dsw-alias-bg-base)}
.is-tl-empty{font-size:12.5px;color:var(--dsw-alias-label-secondary);opacity:.75;padding:6px 0 2px}
.is-deps{display:grid;grid-template-columns:repeat(2, minmax(0, 1fr));gap:12px}
.is-dep-col{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);border-radius:9px;padding:10px 12px;min-width:0}
.is-dep-col-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}
.is-dep-head{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);cursor:help}
.is-dep-none{font-size:12px;color:var(--dsw-alias-label-secondary);opacity:.65;padding:2px 0}
.is-dep{display:flex;align-items:center;gap:8px;font-size:12.5px;padding:5px 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);margin-bottom:6px}
.is-dep:last-child{margin-bottom:0}
.is-dep-ref{font-weight:700;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);flex:none}
.is-dep-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.is-dep-status{font-size:11px;color:var(--dsw-alias-state-warn-primary);flex:none}
.is-dep-status[data-done="true"]{color:var(--dsw-alias-state-success-primary)}
.is-dep-x{border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:13px;padding:0 2px;flex:none}
.is-dep-x:hover{color:var(--dsw-alias-state-error-primary)}
.is-dep-empty{padding:10px 12px;font-size:12px;line-height:1.65;color:var(--dsw-alias-label-secondary);opacity:.75;margin-bottom:5px}
.is-dep-add{position:relative}
.is-dep-actions{display:flex;align-items:center;gap:10px;margin-top:8px}
.is-dep-cancel{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:7px;padding:3px 11px;font-size:12px;font-family:inherit;cursor:pointer}
.is-dep-cancel:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.is-dep-input{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 10px;font-size:12.5px;font-family:inherit}
.is-dep-input:focus{outline:0;border-color:var(--dsw-alias-brand-primary)}
.is-dep-addbtn{border:1px dashed var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:6px;padding:2px 8px;font-size:11.5px;font-family:inherit;cursor:pointer}
.is-dep-addbtn:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.is-blocked{font-size:12px;color:var(--dsw-alias-state-warn-primary);margin:10px 0 0;cursor:help}
.is-card-tags{display:flex;flex-wrap:wrap;gap:5px;margin-top:6px}
.is-note{color:var(--dsw-alias-state-success-primary);font-size:12px;margin-left:auto}
.is-head-right{margin-left:auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.is-head-right .is-note{margin-left:0}
.is-notify-btn{border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:999px;padding:3px 10px;font-size:11.5px;font-family:inherit;cursor:pointer;white-space:nowrap}
.is-notify-btn:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.is-notify-btn[data-status="enabled"]{border-color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 45%, transparent);color:var(--dsw-alias-state-success-primary)}
.is-prio{display:inline-flex;align-items:center;border-radius:6px;padding:1px 7px;font-size:10.5px;font-weight:700;line-height:16px;white-space:nowrap;letter-spacing:.02em;background:color-mix(in srgb, var(--pc) 13%, transparent);color:var(--pc)}
.is-prio[data-solid="true"]{background:var(--pc);color:#fff}
.is-prio-bar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:8px 20px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base)}
.is-prio-bar-label{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-right:4px}
.is-prio-pick{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.is-prio-lock{font-size:11.5px;color:var(--dsw-alias-label-secondary);cursor:help}
.is-prio-chip{border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:999px;padding:2px 10px;font-size:11.5px;font-family:inherit;cursor:pointer;line-height:18px}
.is-prio-chip:hover{border-color:var(--pc, var(--dsw-alias-brand-primary));color:var(--pc, var(--dsw-alias-brand-primary))}
.is-prio-chip[data-active="true"]{border-color:var(--pc, var(--dsw-alias-brand-primary));background:color-mix(in srgb, var(--pc, var(--dsw-alias-brand-primary)) 14%, transparent);color:var(--pc, var(--dsw-alias-brand-primary));font-weight:600}
.is-prio-chip[data-prio="P0"][data-active="true"]{background:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);color:#fff}
.is-back{border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:13px;padding:4px 6px;border-radius:6px;display:inline-flex;align-items:center;gap:2px}
.is-back:hover{color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2)}
.is-actions{margin:14px 0 0;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l1);display:flex;flex-wrap:wrap;gap:8px}
.is-actions .is-btn{margin-right:0}
.is-form{max-width:640px}
.is-type-tag{display:inline-block;font-size:10.5px;font-weight:600;color:var(--dsw-alias-brand-primary);background:color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent);border-radius:6px;padding:1px 7px;line-height:16px;white-space:nowrap}
.is-card-actions{display:flex;justify-content:flex-end;margin-top:8px}
.is-btn-sm{padding:4px 12px;font-size:12px;margin-right:0}
.is-type-row{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.is-chip{border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:999px;padding:3px 10px;font-size:12px;cursor:pointer}
.is-chip:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.is-chip[data-active="true"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);background:color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent)}
.is-scrim{display:none}
.is-nav-btn{display:none}
.is-modal-scrim{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.42);padding:16px}
.is-modal{width:min(92vw,460px);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;box-shadow:0 18px 48px color-mix(in srgb,#000 30%,transparent);padding:16px 18px 14px}
.is-modal-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);margin-bottom:10px}
.is-modal-input{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:8px 10px;font-size:13px;font-family:inherit;resize:vertical;min-height:96px}
.is-modal-input:focus{outline:0;border-color:var(--dsw-alias-brand-primary)}
.is-modal-err{font-size:12px;color:var(--dsw-alias-state-error-primary);margin-top:6px}
.is-modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}
.is-modal-actions .is-btn{margin-right:0}
@media (max-width:768px){
.is-head{flex-wrap:wrap;gap:8px;padding:10px 14px}
.is-prio-bar{padding:8px 14px}
.is-body{padding:12px 14px 20px}
.is-block{padding:13px 14px}
.is-deps{grid-template-columns:1fr}
.is-meta-row{flex-direction:column;gap:4px}
.is-meta-k{width:auto;line-height:1.4}
.is-side{position:absolute;top:0;bottom:0;left:0;width:min(82vw,280px);z-index:2;transform:translateX(-100%);transition:transform .22s ease;box-shadow:8px 0 32px rgba(0,0,0,.35)}
.is-side[data-open="true"]{transform:translateX(0)}
.is-scrim{display:block;position:absolute;inset:0;z-index:1;background:rgba(0,0,0,.42)}
.is-nav-btn{display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);width:34px;height:34px;border-radius:8px;cursor:pointer;font-size:16px;font-family:inherit}
}
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

    function PriorityBadge({ priority }) {
      const key = PRIORITY_META[priority] ? priority : 'P2';
      const meta = PRIORITY_META[key];
      return h('span', {
        className: 'is-prio',
        'data-solid': String(meta.solid),
        style: { '--pc': meta.color },
        title: `紧急程度：${meta.label}（${meta.desc}）`,
      }, meta.label);
    }

    function PriorityPicker({ value, onChange, disabled }) {
      const current = PRIORITY_META[value] ? value : 'P2';
      return h('div', { className: 'is-prio-pick' },
        PRIORITIES.map(p => {
          const meta = PRIORITY_META[p];
          return h('button', {
            key: p,
            type: 'button',
            className: 'is-prio-chip',
            'data-prio': p,
            'data-active': String(current === p),
            style: { '--pc': meta.color },
            disabled,
            onClick: () => onChange?.(p),
          }, `${meta.label} ${meta.desc}`);
        }));
    }

    function actionKind(status) {
      if (status === 'start' || status === 'done') return 'primary';
      if (status === 'cancelled' || status === 'reject') return 'danger';
      return 'secondary';
    }

    const KIND_LABEL = { status: '状态', result: '结果', reject: '打回', assign: '指派' };

    // ---- 时间线配色（timeline.test.js 从这里截取）----
    const SYSTEM_COLOR = '#64748b';
    const USER_COLOR = '#2563eb';
    const AUTHOR_PALETTE = [
      '#0d9488',
      '#d97706',
      '#9333ea',
      '#e11d48',
      '#059669',
      '#ea580c',
      '#4f46e5',
      '#0284c7',
      '#c026d3',
      '#65a30d',
    ];

    function buildAuthorColorMap(roster, timeline) {
      const map = new Map();
      const used = new Set();
      const assign = (raw) => {
        const name = typeof raw === 'string' ? raw.trim() : '';
        if (!name || map.has(name)) return;
        let hash = 0;
        for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
        const start = hash % AUTHOR_PALETTE.length;
        let picked = AUTHOR_PALETTE[start];
        for (let step = 0; step < AUTHOR_PALETTE.length; step++) {
          const candidate = AUTHOR_PALETTE[(start + step) % AUTHOR_PALETTE.length];
          if (!used.has(candidate)) { picked = candidate; break; }
        }
        used.add(picked);
        map.set(name, picked);
      };
      const rosterNames = (roster || []).map(b => b && b.name).filter(Boolean).sort((a, b) => a.localeCompare(b));
      for (const name of rosterNames) assign(name);
      for (const c of (timeline || [])) {
        if (!c || c.kind === 'status' || c.kind === 'assign' || c.authorKind !== 'agent') continue;
        assign(c.authorName || 'Bot');
      }
      return map;
    }

    function timelineTone(entry, authorColors) {
      if (!entry || entry.kind === 'status' || entry.kind === 'assign' || entry.authorKind === 'system') {
        return { isSystem: true, color: SYSTEM_COLOR };
      }
      if (entry.authorKind === 'user') {
        return { isSystem: false, color: USER_COLOR };
      }
      const name = (typeof entry.authorName === 'string' && entry.authorName.trim()) ? entry.authorName.trim() : 'Bot';
      return { isSystem: false, color: (authorColors && authorColors.get(name)) || AUTHOR_PALETTE[0] };
    }
    // ---- 时间线配色结束 ----

    function authorLabel(c) {
      if (!c) return '用户';
      if (c.authorKind === 'user') return '我';
      if (c.authorKind === 'system') return c.authorName || '系统';
      return c.authorName || 'Bot';
    }

    function resolveOpenTarget(detail) {
      const num = Number(detail?.number);
      if (Number.isFinite(num) && num > 0) return String(num);
      const rawId = typeof detail?.id === 'string' ? detail.id.trim() : '';
      return rawId || null;
    }

    // 历史状态评论存的是变量名（dispatched → in_review），显示时翻成人话。
    // 新写入的评论已经在 host 侧写中文，这里只是给老数据兜底。
    const STATUS_WORD_RE = /\b(open|discussing|dispatched|in_review|done|failed|cancelled)\b/g;
    function localizeStatusText(text) {
      if (typeof text !== 'string' || !text) return text;
      return text
        .replace(STATUS_WORD_RE, word => STATUS_LABEL[word] || word)
        // 「待验收 v10」→「待验收」：vN 是内部修改计数，别展示给人看。
        .replace(/(待处理|讨论中|进行中|待验收|已闭环|失败|已取消)\s+[vV]\d+\b/g, '$1');
    }

    function replyPreviewText(text, max = 80) {
      const clean = localizeStatusText(String(text || ''))
        .replace(/!\[[^\]]*\]\([^)]+\)/g, '[图片]')
        .replace(/\s+/g, ' ')
        .trim();
      if (!clean) return '（图片/空内容）';
      return clean.length > max ? `${clean.slice(0, max)}…` : clean;
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

    // ---- markdown：标题 / 段落 / 代码块 / 表格 / 引用 / 列表 / 图片 / 行间公式 ----
    const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
    const FENCE_RE = /^\s*(```+|~~~+)\s*([\w+#.-]*)\s*$/;
    const HR_RE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
    const UL_RE = /^(\s*)([-*+])\s+(.*)$/;
    const OL_RE = /^(\s*)(\d+)[.)]\s+(.*)$/;
    const QUOTE_RE = /^\s{0,3}>\s?(.*)$/;
    const TABLE_SEP_RE = /^\s*\|?[\s:|-]*-[\s:|-]*\|[\s:|-]*$/;
    // 行内：code / 图片 / 粗体 / 斜体 / 删除线 / 链接
    const INLINE_RE = /`([^`\n]+)`|!\[([^\]\n]*)\]\(([^)\s]+)\)|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|~~([^~\n]+)~~|\[([^\]\n]+)\]\(([^)\s]+)\)/g;

    function parseInline(source) {
      const text = String(source || '');
      const runs = [];
      let cursor = 0;
      INLINE_RE.lastIndex = 0;
      let match;
      while ((match = INLINE_RE.exec(text))) {
        if (match.index > cursor) runs.push({ type: 'text', text: text.slice(cursor, match.index) });
        if (match[1] !== undefined) runs.push({ type: 'code', text: match[1] });
        else if (match[2] !== undefined) runs.push({ type: 'image', alt: match[2], href: match[3] });
        else if (match[4] !== undefined) runs.push({ type: 'strong', text: match[4] });
        else if (match[5] !== undefined) runs.push({ type: 'strong', text: match[5] });
        else if (match[6] !== undefined) runs.push({ type: 'em', text: match[6] });
        else if (match[7] !== undefined) runs.push({ type: 'del', text: match[7] });
        else runs.push({ type: 'link', text: match[8], href: match[9] });
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
        if (heading) { blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].trim() }); i += 1; continue; }
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
            const q = QUOTE_RE.exec(lines[i]);
            if (!q) break;
            quoted.push(q[1]);
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
            while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !UL_RE.test(lines[i]) && !OL_RE.test(lines[i]) && !/^\s*\|/.test(lines[i])) {
              items[items.length - 1].text += ` ${lines[i].trim()}`;
              i += 1;
            }
          }
          blocks.push({ type: 'list', ordered, items });
          continue;
        }

        // 独占一行的图片：单独成段，免得被塞进 <p> 里
        const standalone = /^!\[([^\]\n]*)\]\(([^)\s]+)\)\s*$/.exec(line);
        if (standalone) { blocks.push({ type: 'image', alt: standalone[1], href: standalone[2] }); i += 1; continue; }

        const para = [line.trim()];
        i += 1;
        while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) { para.push(lines[i].trim()); i += 1; }
        blocks.push({ type: 'para', text: para.join(' ') });
      }
      return blocks;
    }

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

    const MENTION_SPLIT = /@([^\s@，。；：！？、（）【】「」《》,.;:!?()[\]{}<>"'`]+)/g;
    const REF_SPLIT = /(^|[^&\w/])#(\d{1,6})(?!\w)/g;

    /** 纯文本 → 节点：先把 @同事 高亮，再把 #N 做成可点（对标 GitLab 的引用）。 */
    function renderRichText(text, roster, openIssue) {
      const names = (roster || []).map(bot => bot.name).filter(Boolean).sort((a, b) => b.length - a.length);
      const nodes = [];
      let key = 0;
      const plain = (slice) => {
        if (!slice) return;
        const pieces = [];
        let last = 0;
        REF_SPLIT.lastIndex = 0;
        let match;
        while ((match = REF_SPLIT.exec(slice))) {
          const start = match.index + match[1].length;
          if (start > last) pieces.push(slice.slice(last, start));
          const number = Number(match[2]);
          pieces.push(h('span', {
            key: `ref-${key++}`, className: 'is-ref', title: `打开 #${number}`,
            onClick: event => { event.stopPropagation(); openIssue?.(number); },
          }, `#${number}`));
          last = start + match[0].length - match[1].length;
          REF_SPLIT.lastIndex = last;
        }
        if (last < slice.length) pieces.push(slice.slice(last));
        for (const piece of pieces) nodes.push(piece);
      };
      if (!names.length) { plain(String(text || '')); return nodes; }
      const source = String(text || '');
      let cursor = 0;
      MENTION_SPLIT.lastIndex = 0;
      let match;
      while ((match = MENTION_SPLIT.exec(source))) {
        // 取最长匹配的同事名
        const rest = source.slice(match.index + 1);
        const hit = names.find(name => rest.startsWith(name));
        if (!hit) continue;
        if (match.index > cursor) plain(source.slice(cursor, match.index));
        nodes.push(h('span', { key: `at-${key++}`, className: 'is-mention' }, `@${hit}`));
        cursor = match.index + 1 + hit.length;
        MENTION_SPLIT.lastIndex = cursor;
      }
      if (cursor < source.length) plain(source.slice(cursor));
      return nodes;
    }

    function renderInline(runs, ctx) {
      const nodes = [];
      let key = 0;
      for (const run of runs) {
        if (run.type === 'text') { nodes.push(...renderRichText(run.text, ctx?.roster, ctx?.openIssue)); continue; }
        if (run.type === 'code') nodes.push(h('code', { key: key++ }, run.text));
        else if (run.type === 'strong') nodes.push(h('strong', { key: key++ }, run.text));
        else if (run.type === 'em') nodes.push(h('em', { key: key++ }, run.text));
        else if (run.type === 'del') nodes.push(h('del', { key: key++ }, run.text));
        else if (run.type === 'link') nodes.push(h('a', { key: key++, href: run.href, target: '_blank', rel: 'noreferrer' }, run.text));
        else if (run.type === 'image') nodes.push(h('img', { key: key++, src: run.href, alt: run.alt || '', loading: 'lazy' }));
      }
      return nodes;
    }

    function renderListNodes(nodes, ordered, keyPrefix, ctx) {
      return h(ordered ? 'ol' : 'ul', { key: keyPrefix }, nodes.map((node, index) => h('li', { key: `${keyPrefix}-${index}` },
        renderInline(parseInline(node.text), ctx),
        node.children.length ? renderListNodes(node.children, ordered, `${keyPrefix}-${index}`, ctx) : null)));
    }

    function renderBlocks(blocks, ctx) {
      return blocks.map((block, index) => {
        if (block.type === 'heading') {
          const level = Math.max(1, Math.min(6, block.level));
          return h(`h${level}`, { key: index }, renderInline(parseInline(block.text), ctx));
        }
        if (block.type === 'para') return h('p', { key: index }, renderInline(parseInline(block.text), ctx));
        if (block.type === 'code') return h('pre', { key: index }, h('code', null, block.code));
        if (block.type === 'math') return h('div', { key: index, className: 'is-math' }, block.text);
        if (block.type === 'quote') return h('blockquote', { key: index }, renderBlocks(parseMarkdown(block.text), ctx));
        if (block.type === 'hr') return h('hr', { key: index });
        if (block.type === 'image') return h('img', { key: index, src: block.href, alt: block.alt || '', loading: 'lazy' });
        if (block.type === 'list') return renderListNodes(listTree(block.items), block.ordered, `l${index}`, ctx);
        if (block.type === 'table') {
          return h('table', { key: index },
            h('thead', null, h('tr', null, block.head.map((cell, cellIndex) => h('th', { key: cellIndex }, renderInline(parseInline(cell), ctx))))),
            h('tbody', null, block.rows.map((row, rowIndex) => h('tr', { key: rowIndex },
              row.map((cell, cellIndex) => h('td', { key: cellIndex }, renderInline(parseInline(cell), ctx)))))));
        }
        return null;
      });
    }

    /** 一段 markdown 文本 → 渲染好的节点（外层统一 .is-md 样式）。 */
    function Markdown({ text, roster, openIssue }) {
      const blocks = React.useMemo(() => parseMarkdown(text), [text]);
      return h('div', { className: 'is-md' }, renderBlocks(blocks, { roster, openIssue }));
    }

    // ---- 编辑器工具栏格式化（editor.test.js 从这里截取）----
    const LINE_FORMAT_PREFIX = {
      h1: '# ',
      h2: '## ',
      h3: '### ',
      quote: '> ',
      ul: '- ',
      task: '- [ ] ',
    };

    /**
     * Markdown 编辑器工具栏纯函数：给定全文与选区 [start, end]，应用一种格式并返回新文本及光标位置。
     */
    function applyMarkdownFormat(text, start, end, action) {
      const src = String(text ?? '');
      const s = Math.max(0, Math.min(src.length, start ?? src.length));
      const e = Math.max(s, Math.min(src.length, end ?? s));
      const selected = src.slice(s, e);

      const wrapInline = (before, after, placeholder) => {
        const inner = selected || placeholder;
        const next = src.slice(0, s) + before + inner + after + src.slice(e);
        return { text: next, start: s + before.length, end: s + before.length + inner.length };
      };

      if (action === 'bold') return wrapInline('**', '**', '粗体');
      if (action === 'italic') return wrapInline('*', '*', '斜体');
      if (action === 'strike') return wrapInline('~~', '~~', '删除线');

      if (action === 'link') {
        const label = selected || '链接文本';
        const url = 'https://';
        const snippet = `[${label}](${url})`;
        const urlStart = s + label.length + 3;
        return { text: src.slice(0, s) + snippet + src.slice(e), start: urlStart, end: urlStart + url.length };
      }

      if (action === 'code') {
        if (selected && !selected.includes('\n')) return wrapInline('`', '`', '代码');
        const inner = selected || '代码';
        const lead = s > 0 && src[s - 1] !== '\n' ? '\n' : '';
        const tail = e < src.length && src[e] !== '\n' ? '\n' : '';
        const open = `${lead}\`\`\`\n`;
        const close = `\n\`\`\`${tail}`;
        const next = src.slice(0, s) + open + inner + close + src.slice(e);
        return { text: next, start: s + open.length, end: s + open.length + inner.length };
      }

      if (action === 'table' || action === 'hr') {
        const block = action === 'table'
          ? '| 列1 | 列2 |\n| --- | --- |\n| 内容 | 内容 |'
          : '---';
        const lead = s === 0 || src[s - 1] === '\n' ? '' : '\n\n';
        const tail = e >= src.length || src[e] === '\n' ? '\n' : '\n\n';
        const inserted = `${lead}${block}${tail}`;
        const next = src.slice(0, s) + inserted + src.slice(e);
        const caret = s + lead.length + block.length;
        return { text: next, start: caret, end: caret };
      }

      if (action === 'p' || action === 'ol' || LINE_FORMAT_PREFIX[action]) {
        const lineStart = s === 0 ? 0 : src.lastIndexOf('\n', s - 1) + 1;
        const anchorEnd = e > s && src[e - 1] === '\n' ? e - 1 : e;
        const rawEnd = src.indexOf('\n', anchorEnd);
        const lineEnd = rawEnd === -1 ? src.length : rawEnd;
        const lines = src.slice(lineStart, lineEnd).split('\n');
        const outLines = lines.map((line, idx) => {
          if (action === 'p') return line.replace(/^#{1,6}\s+/, '');
          if (action === 'ol') return `${idx + 1}. ${line.replace(/^\d+\.\s+/, '')}`;
          const prefix = LINE_FORMAT_PREFIX[action];
          if (action === 'h1' || action === 'h2' || action === 'h3') {
            return `${prefix}${line.replace(/^#{1,6}\s+/, '')}`;
          }
          return `${prefix}${line}`;
        });
        const formatted = outLines.join('\n');
        const next = src.slice(0, lineStart) + formatted + src.slice(lineEnd);
        if (s === e) {
          const caret = lineStart + formatted.length;
          return { text: next, start: caret, end: caret };
        }
        return { text: next, start: lineStart, end: lineStart + formatted.length };
      }

      return { text: src, start: s, end: e };
    }
    // ---- 编辑器工具栏格式化结束 ----

    /** 编辑器工具栏 14×14 线性图标。 */
    function editorSvg(...shapes) {
      return h('svg', {
        width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true',
      }, ...shapes);
    }

    /**
     * 统一文本编辑框：顶部通用 Markdown 格式工具栏 + 无边框输入区 + 底部提示栏 + @同事 候选弹层；
     * 不再内置即时预览，提交后直接按 Markdown 渲染。
     */
    function MarkdownField({ value, onChange, roster, rows, placeholder, issueId }) {
      const ref = React.useRef(null);
      const menuRef = React.useRef(null);
      const fileRef = React.useRef(null);
      const composing = React.useRef(false);
      const selRef = React.useRef({ start: 0, end: 0 });
      const [menu, setMenu] = React.useState(null); // { at, query, items, active }
      const [heading, setHeading] = React.useState('p');
      const [uploading, setUploading] = React.useState(0);
      const [uploadError, setUploadError] = React.useState(null);
      const names = React.useMemo(
        () => (roster || []).map(bot => bot.name).filter(Boolean).filter((name, i, all) => all.indexOf(name) === i),
        [roster]);

      const syncCaretMeta = (el) => {
        if (!el) return;
        const pos = el.selectionStart ?? (value || '').length;
        const end = el.selectionEnd ?? pos;
        selRef.current = { start: pos, end };
        const txt = el.value ?? (value || '');
        const lineStart = pos === 0 ? 0 : txt.lastIndexOf('\n', pos - 1) + 1;
        const lineEndRaw = txt.indexOf('\n', pos);
        const line = txt.slice(lineStart, lineEndRaw === -1 ? txt.length : lineEndRaw);
        const matched = /^(#{1,3})\s/.exec(line);
        setHeading(matched ? `h${matched[1].length}` : 'p');
      };

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
        selRef.current = { start: pos, end: pos };
        // 等 React 把新值写回 textarea 再放光标，否则会被重置到末尾。
        requestAnimationFrame(() => {
          el.focus();
          try { el.setSelectionRange(pos, pos); } catch { /* ignore */ }
          syncCaretMeta(el);
        });
      };

      const applyEditorText = (next) => {
        setMenu(null);
        onChange(next.text);
        selRef.current = { start: next.start, end: next.end };
        requestAnimationFrame(() => {
          const node = ref.current;
          if (!node) return;
          node.focus();
          try { node.setSelectionRange(next.start, next.end); } catch { /* ignore */ }
          syncCaretMeta(node);
        });
      };

      const runFormat = (action) => {
        const element = ref.current;
        const text = value || '';
        const focused = typeof document !== 'undefined' && document.activeElement === element;
        const start = focused && element?.selectionStart != null ? element.selectionStart : Math.min(selRef.current.start ?? text.length, text.length);
        const end = focused && element?.selectionEnd != null ? element.selectionEnd : Math.min(selRef.current.end ?? start, text.length);
        applyEditorText(applyMarkdownFormat(text, start, end, action));
      };

      const onKeyDown = (event) => {
        if (menu && !composing.current && !event.isComposing) {
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
          if (event.key === 'Escape') { event.preventDefault(); setMenu(null); return; }
        }
        if ((event.metaKey || event.ctrlKey) && !event.altKey && !composing.current && !event.isComposing) {
          const key = event.key.toLowerCase();
          if (key === 'b') { event.preventDefault(); runFormat('bold'); return; }
          if (key === 'i') { event.preventDefault(); runFormat('italic'); return; }
          if (key === 'k') { event.preventDefault(); runFormat('link'); return; }
        }
      };

      const insertMarkdown = (snippet) => {
        const element = ref.current;
        const text = value || '';
        const focused = typeof document !== 'undefined' && document.activeElement === element;
        const start = focused && element?.selectionStart != null ? element.selectionStart : Math.min(selRef.current.start ?? text.length, text.length);
        const end = focused && element?.selectionEnd != null ? element.selectionEnd : Math.min(selRef.current.end ?? start, text.length);
        const pos = start + snippet.length;
        applyEditorText({ text: `${text.slice(0, start)}${snippet}${text.slice(end)}`, start: pos, end: pos });
      };

      /** 粘贴 / 拖入 / 点按钮：图片先传到 /api/bot-issue?action=upload，再把 markdown 插进正文。 */
      const uploadFiles = async (fileList) => {
        const files = Array.from(fileList || []).filter(file => file && typeof file.type === 'string' && file.type.startsWith('image/'));
        if (!files.length) return;
        setUploadError(null);
        for (const file of files) {
          setUploading(count => count + 1);
          try {
            const dataUrl = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(String(reader.result || ''));
              reader.onerror = () => reject(new Error('读取文件失败'));
              reader.readAsDataURL(file);
            });
            const mime = (/^data:([^;]+)/.exec(dataUrl) || [])[1] || file.type;
            const result = await call('upload', { id: issueId, name: file.name, mime, data: dataUrl });
            insertMarkdown(`\n![${result.image.name || '图片'}](${result.image.url})\n`);
          } catch (caught) {
            setUploadError(caught);
          } finally {
            setUploading(count => Math.max(0, count - 1));
          }
        }
      };

      // 候选弹层滚动跟随键盘选中项。
      React.useEffect(() => {
        const box = menuRef.current;
        if (!box || !menu) return;
        const row = box.children[menu.active];
        row?.scrollIntoView?.({ block: 'nearest' });
      }, [menu]);

      const fmtBtn = (key, title, label) => h('button', {
        key, type: 'button', className: 'is-editor-btn', title, 'aria-label': title,
        onMouseDown: event => event.preventDefault(),
        onClick: () => runFormat(key),
      }, label);

      return h('div', { className: 'is-mfield' },
        h('div', { className: 'is-editor' },
          h('div', { className: 'is-editor-bar' },
            h('select', {
              className: 'is-editor-sel',
              'aria-label': '段落格式',
              title: '段落格式',
              value: value ? heading : 'p',
              onChange: event => {
                const action = event.target.value;
                if (action) runFormat(action);
              },
            },
              h('option', { value: 'p' }, '普通文本'),
              h('option', { value: 'h1' }, '一级标题 H1'),
              h('option', { value: 'h2' }, '二级标题 H2'),
              h('option', { value: 'h3' }, '三级标题 H3')),
            h('span', { className: 'is-editor-sep' }),
            fmtBtn('bold', '加粗 (⌘/Ctrl+B)', h('strong', null, 'B')),
            fmtBtn('italic', '斜体 (⌘/Ctrl+I)', h('em', { style: { fontFamily: 'Georgia,serif' } }, 'I')),
            fmtBtn('strike', '删除线', h('span', { style: { textDecoration: 'line-through' } }, 'S')),
            h('span', { className: 'is-editor-sep' }),
            fmtBtn('quote', '引用', editorSvg(
              h('path', { d: 'M3 3v10' }),
              h('path', { d: 'M7 5h6M7 8h6M7 11h4' }),
            )),
            fmtBtn('code', '行内/块级代码', editorSvg(
              h('path', { d: 'M5 5 2 8l3 3' }),
              h('path', { d: 'M11 5l3 3-3 3' }),
              h('path', { d: 'M9 3 7 13' }),
            )),
            fmtBtn('link', '链接 (⌘/Ctrl+K)', editorSvg(
              h('path', { d: 'M6.5 9.5 9.5 6.5' }),
              h('path', { d: 'M8.5 11.5 7 13a2.8 2.8 0 0 1-4-4l1.5-1.5' }),
              h('path', { d: 'M7.5 4.5 9 3a2.8 2.8 0 0 1 4 4l-1.5 1.5' }),
            )),
            fmtBtn('ul', '无序列表', editorSvg(
              h('path', { d: 'M6 4h8M6 8h8M6 12h8' }),
              h('path', { d: 'M2.5 4h.5M2.5 8h.5M2.5 12h.5' }),
            )),
            fmtBtn('ol', '有序列表', editorSvg(
              h('path', { d: 'M7 4h7M7 8h7M7 12h7' }),
              h('path', { d: 'M2.5 3.5h1v2M2.5 8h1.5l-1.5 2h1.5M2.5 11.5h1.5v2.5H2.5' }),
            )),
            fmtBtn('task', '任务列表', editorSvg(
              h('path', { d: 'M2.5 4.5 4 6l2.5-2.5' }),
              h('path', { d: 'M8 5h6M8 11h6' }),
              h('rect', { x: 2.5, y: 9.5, width: 3.5, height: 3.5, rx: .6 }),
            )),
            h('span', { className: 'is-editor-sep' }),
            fmtBtn('table', '插入表格', editorSvg(
              h('rect', { x: 2, y: 3, width: 12, height: 10, rx: 1.2 }),
              h('path', { d: 'M2 6.5h12M2 10h12M8 6.5V13' }),
            )),
            h('button', {
              type: 'button', className: 'is-editor-btn', title: '插入图片（也支持粘贴或拖入）', 'aria-label': '插入图片',
              onMouseDown: event => event.preventDefault(),
              onClick: () => fileRef.current && fileRef.current.click(),
            }, editorSvg(
              h('path', { d: 'M12.5 7.5 7 13a3.2 3.2 0 0 1-4.5-4.5l6-6a2.1 2.1 0 0 1 3 3l-6 6a1 1 0 0 1-1.5-1.5l5.2-5.2' }),
            )),
            fmtBtn('hr', '插入分割线', editorSvg(
              h('path', { d: 'M2 8h12' }),
            )),
            h('input', {
              ref: fileRef, type: 'file', accept: 'image/*', multiple: true, style: { display: 'none' },
              onChange: event => { uploadFiles(event.target.files); event.target.value = ''; },
            })),
          h('textarea', {
            ref, className: 'is-editor-input', rows: rows || 3, value,
            placeholder: placeholder || '',
            onChange: e => { onChange(e.target.value); scan(e.target); syncCaretMeta(e.target); },
            onKeyDown,
            onCompositionStart: () => { composing.current = true; },
            onCompositionEnd: e => { composing.current = false; scan(e.target); syncCaretMeta(e.target); },
            onKeyUp: e => { syncCaretMeta(e.target); if (!menu && ref.current) scan(ref.current); },
            onMouseUp: e => { syncCaretMeta(e.target); },
            onSelect: e => { syncCaretMeta(e.target); if (ref.current) scan(ref.current); },
            onBlur: () => setTimeout(() => setMenu(null), 120),
            onPaste: event => {
              const files = event.clipboardData && event.clipboardData.files;
              if (files && files.length) { event.preventDefault(); uploadFiles(files); }
            },
            onDrop: event => {
              const files = event.dataTransfer && event.dataTransfer.files;
              if (files && files.length) { event.preventDefault(); uploadFiles(files); }
            },
            onDragOver: event => {
              if (event.dataTransfer && Array.from(event.dataTransfer.types || []).includes('Files')) event.preventDefault();
            },
          }),
          h('div', { className: 'is-editor-foot' },
            uploading ? h('span', { className: 'is-upbusy' }, `图片上传中 ${uploading}…`) : null,
            uploadError ? h('span', { className: 'is-upbusy', style: { color: 'var(--dsw-alias-state-error-primary)' } }, `上传失败：${uploadError.message}`) : null,
            h('span', { className: 'is-editor-md', title: '支持 Markdown 排版 · 图片可粘贴或拖入 · @同事 可触发通知' }, 'M↓'))),
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
      return h('div', { className: 'is-tagrow' },
        (library || []).map(name => h('span', {
          key: name, className: 'is-tag', 'data-active': String(selected.includes(name)),
          title: selected.includes(name) ? '点击取消' : '点击选中',
          onClick: () => toggle(name),
        },
          name,
          h('button', {
            type: 'button', className: 'is-tag-del', title: '从标签库删除',
            onClick: event => { event.stopPropagation(); drop(name); },
          }, '×'))),
        h('input', {
          className: 'is-taginput', value: draft, disabled: busy,
          placeholder: '＋ 新标签',
          title: '输入标签名后按回车创建',
          onChange: event => setDraft(event.target.value),
          onKeyDown: event => {
            if (event.key === 'Enter') { event.preventDefault(); commit(); }
            else if (event.key === 'Escape') setDraft('');
          },
        }));
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
     * 验收 / 打回意见的浮窗：替代 window.prompt。
     * 原生 prompt 是浏览器级弹窗，看着像系统事件、样式也不跟主题；这里做成面板内浮窗。
     */
    function ReviewDialog({ kind, onSubmit, onCancel }) {
      const [value, setValue] = React.useState('');
      const [error, setError] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const done = kind === 'done';
      const title = done ? '验收通过' : '打回重做';
      const placeholder = done ? '填写验收意见…' : '填写打回原因…';
      const inputTitle = done ? '提交后写入闭环结果' : '提交后写入时间线并通知经办人';

      React.useEffect(() => {
        const onKey = (event) => { if (event.key === 'Escape') onCancel?.(); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
      }, [onCancel]);

      const submit = async () => {
        const text = value.trim();
        if (!text) { setError(done ? '验收必须写意见' : '打回必须写意见'); return; }
        setError(null);
        setBusy(true);
        try { await onSubmit?.(text); }
        catch (caught) { setError(caught?.message || '提交失败，请重试'); }
        finally { setBusy(false); }
      };

      return h('div', {
        className: 'is-modal-scrim',
        onMouseDown: event => { if (event.target === event.currentTarget) onCancel?.(); },
      },
        h('div', { className: 'is-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
          h('div', { className: 'is-modal-title' }, title),
          h('textarea', {
            className: 'is-modal-input', rows: 4, autoFocus: true, value, placeholder, title: inputTitle,
            onChange: event => setValue(event.target.value),
            onKeyDown: event => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); submit(); }
            },
          }),
          error ? h('div', { className: 'is-modal-err' }, error) : null,
          h('div', { className: 'is-modal-actions' },
            h('button', { type: 'button', className: 'is-btn', onClick: () => onCancel?.() }, '取消'),
            h('button', {
              type: 'button', className: 'is-btn', 'data-kind': done ? 'primary' : 'danger',
              disabled: busy, onClick: submit,
            }, busy ? '提交中…' : (done ? '确认验收' : '确认打回')),
          ),
        ));
    }

    /**
     * 依赖选择器：打开就列候选（不用先打字），
     * 打 `#` 只剩编号、打 `#3` 按编号前缀过滤、打别的词按标题过滤。
     */
    function DepPicker({ mode, exclude, onPick, onCancel }) {
      const [query, setQuery] = React.useState('');
      const [all, setAll] = React.useState([]);
      const [active, setActive] = React.useState(0);
      const [error, setError] = React.useState(null);
      const excludeKey = (exclude || []).join(',');
      const boxRef = React.useRef(null);

      // 点面板外面也关掉：之前只能按 Esc，鼠标一移出去就卡在那儿了。
      React.useEffect(() => {
        const onDown = (event) => {
          if (boxRef.current && !boxRef.current.contains(event.target)) onCancel?.();
        };
        document.addEventListener('mousedown', onDown, true);
        return () => document.removeEventListener('mousedown', onDown, true);
      }, [onCancel]);

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

      return h('div', { className: 'is-dep-add', ref: boxRef },
        h('input', {
          className: 'is-dep-input', autoFocus: true, value: query,
          placeholder: '搜索 #编号 或标题',
          title: '输入 #编号 或关键词，回车选择',
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
        h('div', { className: 'is-mmenu', style: { top: 'calc(100% + 2px)' } },
          items.length
            ? items.map((item, index) => h('button', {
              key: item.id, type: 'button', className: 'is-mitem', 'data-active': String(index === active),
              onMouseEnter: () => setActive(index),
              onMouseDown: event => { event.preventDefault(); pick(item); },
            },
              h('span', { className: 'is-mitem-name' }, item.number ? `#${item.number}` : item.id),
              h('span', { style: { opacity: .75, marginLeft: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.title),
              h('span', { className: 'is-mitem-id' }, STATUS_LABEL[item.status] || item.status)))
            : h('div', { className: 'is-dep-empty' },
              error ? `读取失败：${error.message}` : (all.length ? '暂无可选事务' : '暂无其它事务'))),
        h('div', { className: 'is-dep-actions' },
          h('button', { className: 'is-dep-cancel', type: 'button', title: '取消 (Esc)', onClick: onCancel }, '取消')));
    }

    function ErrorBox({ error, onRetry }) {
      const titles = { HOST_STALE: '需要重启 dsh web', DISPATCH_UNAVAILABLE: '派工桥接尚未启用' };
      return h('div', { className: 'is-error' },
        h('div', { className: 'is-error-title' }, titles[error.code] || '操作失败'),
        h('div', { className: 'is-detail' }, error.message),
        onRetry ? h('button', { className: 'is-btn', type: 'button', onClick: onRetry }, '重试') : null);
    }

    // ---- 未读角标与浏览器桌面通知（badge.test.js 从这里截取）----
    const UNREAD_KEY = 'bot-issue:seen';
    const NOTIFY_MUTE_KEY = 'bot-issue:notify-muted';
    function unreadOf(versions, seen) {
      return (versions || []).filter(v => (v.version || 0) > ((seen && seen[v.id]) || 0)).length;
    }
    function markSeen(seen, id, version) {
      const next = Object.assign({}, seen || {});
      if ((version || 0) > (next[id] || 0)) next[id] = version;
      return next;
    }
    const readSeen = () => { try { return JSON.parse(localStorage.getItem(UNREAD_KEY) || '{}'); } catch { return {}; } };
    const readNotifyMuted = () => { try { return localStorage.getItem(NOTIFY_MUTE_KEY) === '1'; } catch { return false; } };
    const notifyStatusNow = () => {
      if (typeof Notification !== 'function') return 'unsupported';
      if (typeof window !== 'undefined' && window.isSecureContext === false) return 'insecure';
      if (Notification.permission === 'denied') return 'denied';
      if (Notification.permission === 'granted') return readNotifyMuted() ? 'muted' : 'enabled';
      return 'default';
    };
    const notifyState = { status: notifyStatusNow(), listeners: new Set() };
    const syncNotifyState = () => {
      const next = notifyStatusNow();
      if (notifyState.status === next) return;
      notifyState.status = next;
      for (const fn of notifyState.listeners) fn(next);
    };
    const toggleNotify = async () => {
      if (typeof Notification !== 'function') { syncNotifyState(); return notifyState.status; }
      if (typeof window !== 'undefined' && window.isSecureContext === false) { syncNotifyState(); return notifyState.status; }
      if (Notification.permission === 'granted') {
        try { localStorage.setItem(NOTIFY_MUTE_KEY, readNotifyMuted() ? '0' : '1'); } catch { /* ignore */ }
        syncNotifyState();
        return notifyState.status;
      }
      if (Notification.permission === 'denied') { syncNotifyState(); return notifyState.status; }
      try {
        const res = await Notification.requestPermission();
        if (res === 'granted') {
          try { localStorage.setItem(NOTIFY_MUTE_KEY, '0'); } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
      syncNotifyState();
      return notifyState.status;
    };

    let notifyBaselineReady = false;
    const prevStatusById = new Map();
    const seenReplyIds = new Set();

    function openIssueFromNotice(target) {
      if (typeof window === 'undefined') return;
      try { if (typeof window.focus === 'function') window.focus(); } catch { /* ignore */ }
      try {
        window.dispatchEvent(new CustomEvent('bot-issue:open', {
          detail: { id: target?.id || null, number: target?.number ?? null },
        }));
      } catch { /* ignore */ }
    }

    function sendBrowserNotice(title, options, target) {
      if (notifyStatusNow() !== 'enabled') return null;
      try {
        const note = new Notification(title, options);
        note.onclick = () => {
          openIssueFromNotice(target);
          try { note.close?.(); } catch { /* ignore */ }
        };
        return note;
      } catch {
        return null;
      }
    }

    function processMetaNotifications(meta) {
      const versions = Array.isArray(meta?.versions) ? meta.versions : [];
      const replies = Array.isArray(meta?.userReplies) ? meta.userReplies : [];
      if (!notifyBaselineReady) {
        notifyBaselineReady = true;
        for (const v of versions) {
          if (v && v.id && v.status) prevStatusById.set(v.id, v.status);
        }
        for (const r of replies) {
          if (r && r.id != null) seenReplyIds.add(r.id);
        }
        return;
      }
      const currentIds = new Set();
      for (const v of versions) {
        if (!v || !v.id || !v.status) continue;
        currentIds.add(v.id);
        const prev = prevStatusById.get(v.id);
        prevStatusById.set(v.id, v.status);
        if (v.status === 'in_review' && prev !== 'in_review') {
          const ref = v.number ? `#${v.number}` : v.id;
          const prio = v.priority === 'P0' || v.priority === 'P1' ? `[${v.priority}] ` : '';
          sendBrowserNotice(
            `事务待验收：${prio}${ref} ${v.title || ''}`.trim(),
            { body: '请前往事务面板查看结果并验收闭环', tag: `bot-issue-review-${v.id}-v${v.version || 0}` },
            { id: v.id, number: v.number },
          );
        }
      }
      for (const id of [...prevStatusById.keys()]) {
        if (!currentIds.has(id)) prevStatusById.delete(id);
      }
      for (const r of replies) {
        if (!r || r.id == null || seenReplyIds.has(r.id)) continue;
        seenReplyIds.add(r.id);
        const ref = r.issueNumber ? `#${r.issueNumber}` : r.issueId;
        const who = r.authorName || (r.authorKind === 'system' ? '系统' : '同事');
        sendBrowserNotice(
          `${who} 回复了你的评论（${ref}）`,
          { body: `${r.issueTitle ? `${r.issueTitle}：` : ''}${r.preview || ''}`, tag: `bot-issue-reply-${r.id}` },
          { id: r.issueId, number: r.issueNumber },
        );
      }
    }

    const unreadStore = { count: 0, listeners: new Set() };
    const setUnread = count => { if (unreadStore.count === count) return; unreadStore.count = count; for (const fn of unreadStore.listeners) fn(count); };
    let seenMigrated = false;
    const applyMetaSnapshot = async (meta) => {
      syncNotifyState();
      processMetaNotifications(meta);
      let serverSeen = meta.seen;
      if (!seenMigrated) {
        seenMigrated = true;
        const legacy = readSeen();
        if (Object.keys(legacy).length) {
          // 旧版本只存浏览器；合并到服务端时只升不降，之后不再受 origin 限制。
          try { serverSeen = (await call('seen', { seen: legacy })).seen; } catch { /* 老后端不支持时走本地兜底 */ }
        }
      }
      setUnread(unreadOf(meta.versions, serverSeen || readSeen()));
    };
    const refreshUnread = async () => {
      try {
        const meta = await call('meta');
        await applyMetaSnapshot(meta);
      } catch { /* ignore */ }
    };
    const markIssueSeen = async (issue) => {
      if (!issue || !issue.id) return;
      try {
        await call('seen', { id: issue.id, version: issue.version });
      } catch {
        try { localStorage.setItem(UNREAD_KEY, JSON.stringify(markSeen(readSeen(), issue.id, issue.version))); } catch { /* ignore */ }
      }
      refreshUnread();
    };

    function Icon({ size }) {
      const s = size || 16;
      const [count, setCount] = React.useState(unreadStore.count);
      React.useEffect(() => {
        const fn = c => setCount(c);
        unreadStore.listeners.add(fn);
        return () => unreadStore.listeners.delete(fn);
      }, []);
      return h('span', { style: { display: 'inline-flex' } },
        h('svg', { width: s, height: s, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' },
          h('path', { d: 'M4 5.5A2.5 2.5 0 0 1 6.5 3H19v13h-8' }),
          h('path', { d: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H19' }),
          h('path', { d: 'M7 7h8M7 11h5' })),
        count > 0 ? h('span', { className: 'is-unread' }, count > 99 ? '99+' : String(count)) : null);
    }

    function NewForm({ onDone, onBack, tags, onCreateTag, onDeleteTag, roster }) {
      const [title, setTitle] = React.useState('');
      const [body, setBody] = React.useState('');
      const [priority, setPriority] = React.useState('P2');
      const [chosen, setChosen] = React.useState([]);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);
      const submit = async () => {
        setBusy(true); setError(null);
        try {
          await call('create', { title, body, priority, tags: chosen, authorKind: 'user' });
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
            h('input', { className: 'is-field', value: title, onChange: e => setTitle(e.target.value), placeholder: '输入事务标题' }),
            h('label', { className: 'is-label' }, '紧急程度'),
            h(PriorityPicker, { value: priority, onChange: setPriority, disabled: busy }),
            h('label', { className: 'is-label' }, '标签'),
            h(TagPicker, { value: chosen, library: tags, onChange: setChosen, onCreate: onCreateTag, onDelete: onDeleteTag }),
            h('label', { className: 'is-label' }, '说明'),
            h(MarkdownField, { rows: 8, value: body, onChange: setBody, roster, placeholder: '输入事务说明…' }),
            h('div', { style: { marginTop: 16 } },
              h('button', { className: 'is-btn', 'data-kind': 'primary', type: 'button', disabled: busy || !title.trim(), onClick: submit }, busy ? '创建中…' : '创建'),
              h('button', { className: 'is-btn', type: 'button', onClick: onBack }, '取消'))))));
    }

    function Detail({ id, refreshKey, onBack, onChanged, roster, tags, onCreateTag, onDeleteTag, onOpenIssue }) {
      const [issue, setIssue] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [note, setNote] = React.useState(null);
      const [comment, setComment] = React.useState('');
      const [replyTo, setReplyTo] = React.useState(null);
      const [flashId, setFlashId] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [started, setStarted] = React.useState(false);
      const [depMode, setDepMode] = React.useState(null); // null | 'dependsOn' | 'blocks'
      const [depBusy, setDepBusy] = React.useState(false);
      const [review, setReview] = React.useState(null); // null | 'done' | 'reject'：验收/打回意见浮窗
      const commentRefs = React.useRef({});
      const composerRef = React.useRef(null);
      const flashTimerRef = React.useRef(null);

      React.useEffect(() => () => {
        if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
      }, []);

      React.useEffect(() => {
        setReplyTo(null);
        setComment('');
        setFlashId(null);
      }, [id]);

      const refresh = React.useCallback(async () => {
        setError(null);
        try {
          const got = (await call('get', { id })).issue;
          setIssue(got);
          markIssueSeen(got);
        } catch (caught) { setError(caught); }
      }, [id]);

      React.useEffect(() => { refresh(); }, [refresh, refreshKey]);

      const act = async (status) => {
        // 验收 / 打回要写意见：开浮窗，不再用浏览器原生 prompt。
        if (status === 'done' || status === 'reject') { setReview(status); return; }
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

      // 浮窗点确认：带意见提交验收/打回。失败抛给浮窗显示，不落面板级 error。
      const submitReview = async (kind, opinion) => {
        if (kind === 'done') {
          await call('update', { id, status: 'done', result: opinion, authorKind: 'user' });
          setNote('已验收通过，意见已写入闭环结果');
        } else {
          await call('update', { id, status: 'dispatched', rejection: opinion, authorKind: 'user' });
          setNote('已打回重做，意见已写入时间线并知会经办人');
        }
        setReview(null);
        onChanged?.();
        await refresh();
      };

      const saveTags = async (next) => {
        setBusy(true); setError(null);
        try {
          await call('update', { id, tags: next, authorKind: 'user' });
          await refresh();
          onChanged?.();
        } catch (caught) { setError(caught); } finally { setBusy(false); }
      };

      const savePriority = async (next) => {
        if (!issue || (issue.status !== 'open' && issue.status !== 'discussing')) return;
        if (!next || next === (issue.priority || 'P2')) return;
        setBusy(true); setError(null);
        try {
          await call('update', { id, priority: next, authorKind: 'user' });
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

      const startReply = (target) => {
        setReplyTo(target);
        requestAnimationFrame(() => {
          composerRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
          composerRef.current?.querySelector?.('textarea')?.focus?.();
        });
      };

      const jumpToComment = (commentId) => {
        const el = commentRefs.current[commentId];
        if (!el) return;
        el.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
        setFlashId(commentId);
        if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
        flashTimerRef.current = setTimeout(() => setFlashId(null), 1600);
      };

      const post = async () => {
        if (!comment.trim()) return;
        setBusy(true); setNote(null); setError(null);
        try {
          await call('comment', {
            id,
            body: comment,
            authorKind: 'user',
            ...(replyTo ? { replyToId: replyTo.id } : {}),
          });
          setComment('');
          setReplyTo(null);
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
      const authorColors = buildAuthorColorMap(roster, timeline);
      const canEditPriority = issue.status === 'open' || issue.status === 'discussing';
      const blocking = (issue.dependsOn || []).filter(dep => dep.status !== 'done');

      const depRow = (dep, side) => h('div', { key: `${side}:${dep.id}`, className: 'is-dep' },
        h('span', { className: 'is-dep-ref' }, dep.number ? `#${dep.number}` : dep.id),
        h('span', { className: 'is-dep-title' }, dep.title),
        h('span', { className: 'is-dep-status', 'data-done': String(dep.status === 'done') }, STATUS_LABEL[dep.status] || dep.status),
        h('button', {
          type: 'button', className: 'is-dep-x', title: side === 'dependsOn' ? '解除这个前置' : '解除这个后置',
          disabled: depBusy, onClick: () => removeDep(dep, side),
        }, '×'));

      const depBlock = (title, list, side, hint) => h('div', { className: 'is-dep-col' },
        h('div', { className: 'is-dep-col-head' },
          h('span', { className: 'is-dep-head', title: hint }, title),
          depMode === side ? null : h('button', { type: 'button', className: 'is-dep-addbtn', onClick: () => setDepMode(side) }, '＋ 添加')),
        list.length
          ? list.map(dep => depRow(dep, side))
          : (depMode === side ? null : h('div', { className: 'is-dep-none' }, '暂无')),
        depMode === side
          ? h(DepPicker, {
            mode: side,
            exclude: [issue.id, ...list.map(dep => dep.id)],
            onPick: addDep,
            onCancel: () => setDepMode(null),
          })
          : null);
      const statusActions = ACTIONS[issue.status] || [];
      return h('div', { className: 'is-root' }, h('div', { className: 'is-main' },
        h('div', { className: 'is-head' },
          h('button', { className: 'is-back', type: 'button', onClick: onBack }, '← 返回'),
          h('span', { className: 'is-head-title' }, issue.title),
          h(Badge, { status: issue.status }),
          h(PriorityBadge, { priority: issue.priority || 'P2' }),
          note ? h('span', { className: 'is-note' }, note) : null),
        h('div', { className: 'is-body' },
          error ? h(ErrorBox, { error }) : null,
          h('div', { className: 'is-detail', style: { margin: '0 0 10px' } },
            `${issue.number ? `#${issue.number}` : issue.id} · ${issue.createdByName || issue.createdBy} 创建于 ${formatTime(issue.createdAt)}`),
          h('div', { className: 'is-blocks' },
            h('div', { className: 'is-block' },
              h('div', { className: 'is-meta-grid' },
                h('div', { className: 'is-meta-row' },
                  h('span', { className: 'is-meta-k' }, '紧急程度'),
                  h('div', { className: 'is-meta-v' },
                    canEditPriority
                      ? h(PriorityPicker, { value: issue.priority || 'P2', onChange: savePriority, disabled: busy })
                      : [
                        h(PriorityBadge, { key: 'b', priority: issue.priority || 'P2' }),
                        h('span', { key: 'l', className: 'is-prio-lock', title: '进行中及之后不可调整，重开回待处理后可修改' }, `${(PRIORITY_META[issue.priority || 'P2'] || PRIORITY_META.P2).desc} · 已锁定`),
                      ])),
                issue.assignee ? h('div', { className: 'is-meta-row' },
                  h('span', { className: 'is-meta-k' }, '执行人'),
                  h('div', { className: 'is-meta-v' }, issue.assignee.name || issue.assignee.sessionId)) : null,
                h('div', { className: 'is-meta-row' },
                  h('span', { className: 'is-meta-k' }, '标签'),
                  h('div', { className: 'is-meta-v' },
                    h(TagPicker, { value: issue.tags || [], library: tags, onChange: saveTags, onCreate: onCreateTag, onDelete: dropTag })))),
              issue.body ? h('div', { className: 'is-block-body' },
                h(Markdown, { text: issue.body, roster, openIssue: onOpenIssue })) : null,
              issue.result ? h('div', { className: 'is-result' },
                h('div', { className: 'is-result-label' }, '闭环结果'),
                h(Markdown, { text: issue.result, roster, openIssue: onOpenIssue })) : null,
              statusActions.length ? h('div', { className: 'is-actions' },
                statusActions.map(([status, label]) =>
                  h('button', {
                    key: status, className: 'is-btn', 'data-kind': actionKind(status), type: 'button',
                    disabled: busy || (status === 'start' && started) || (status === 'done' && blocking.length > 0),
                    onClick: () => act(status),
                  }, label))) : null,
              blocking.length ? h('div', { className: 'is-blocked', title: '前置事务均已闭环后才能验收通过' },
                `前置未闭环：${blocking.map(dep => (dep.number ? `#${dep.number}` : dep.title)).join('、')}`) : null),
            h('div', { className: 'is-block' },
              h('div', { className: 'is-block-head' }, '依赖'),
              h('div', { className: 'is-deps' },
                depBlock('前置', issue.dependsOn || [], 'dependsOn', '前置事务完成后，本事务才可验收通过'),
                depBlock('后置', issue.blocks || [], 'blocks', '本事务完成后，后置事务才可验收通过'))),
            (issue.dispatches && issue.dispatches.length) ? h('div', { className: 'is-block' },
              h('div', { className: 'is-block-head' },
                '派工记录',
                h('span', { className: 'is-block-count' }, String(issue.dispatches.length))),
              (issue.dispatches || []).map(d => h('div', { key: d.id, className: 'is-detail', style: { margin: '4px 0' } }, `${d.taskId} · ${STATUS_LABEL[d.status] || d.status} · ${formatTime(d.at)}`))) : null,
            h('div', { className: 'is-block' },
              h('div', { className: 'is-block-head' },
                '评论与时间线',
                timeline.length ? h('span', { className: 'is-block-count' }, String(timeline.length)) : null),
              timeline.length ? h('div', { className: 'is-tl' },
                timeline.map(c => {
                  const tone = timelineTone(c, authorColors);
                  const quoteTone = c.replyTo ? timelineTone(c.replyTo, authorColors) : null;
                  return h('div', {
                    key: c.id,
                    className: 'is-tl-item',
                    'data-system': String(tone.isSystem),
                    'data-flash': String(flashId === c.id),
                    style: { '--tlc': tone.color },
                    ref: el => { if (el) commentRefs.current[c.id] = el; else delete commentRefs.current[c.id]; },
                  },
                    h('div', { className: 'is-tl-meta' },
                      tone.isSystem
                        ? h('span', { className: 'is-tl-kind', 'data-kind': c.kind }, KIND_LABEL[c.kind] || '系统')
                        : h('span', { className: 'is-tl-author' },
                          h('span', { className: 'is-tl-author-dot' }),
                          authorLabel(c)),
                      tone.isSystem && (c.authorKind === 'user' || c.authorName) ? h('span', { className: 'is-tl-time' }, authorLabel(c)) : null,
                      !tone.isSystem && c.kind !== 'comment'
                        ? h('span', { className: 'is-tl-kind', 'data-kind': c.kind }, KIND_LABEL[c.kind] || c.kind)
                        : null,
                      h('span', { className: 'is-tl-time' }, formatTime(c.at)),
                      c.kind !== 'status' && c.kind !== 'assign'
                        ? h('button', { type: 'button', className: 'is-tl-reply', onClick: () => startReply(c) }, '回复')
                        : null),
                    c.replyTo ? h('button', {
                      type: 'button',
                      className: 'is-tl-quote',
                      style: quoteTone ? { '--qtc': quoteTone.color } : undefined,
                      title: '点击定位到原评论',
                      onClick: () => jumpToComment(c.replyTo.id),
                    }, `↩ 回复 ${authorLabel(c.replyTo)}：${c.replyTo.preview || '（图片/空内容）'}`) : null,
                    h('div', { className: 'is-tl-body' }, h(Markdown, { text: localizeStatusText(c.body), roster, openIssue: onOpenIssue })));
                })) : h('div', { className: 'is-tl-empty' }, '暂无评论'),
              h('div', { ref: composerRef, className: 'is-composer' },
                h('div', { className: 'is-block-head' }, '写评论'),
                replyTo ? h('div', { className: 'is-reply-banner' },
                  h('span', { className: 'is-reply-banner-text' }, `↩ 正在回复 ${authorLabel(replyTo)}：${replyPreviewText(replyTo.body)}`),
                  h('button', { type: 'button', className: 'is-reply-cancel', 'aria-label': '取消回复', onClick: () => setReplyTo(null) }, '×')) : null,
                h(MarkdownField, { rows: 3, value: comment, onChange: setComment, roster, issueId: issue.id, openIssue: onOpenIssue, placeholder: replyTo ? `回复 ${authorLabel(replyTo)}…` : '写评论…' }),
                h('div', { style: { marginTop: 10 } },
                  h('button', { className: 'is-btn', 'data-kind': 'primary', type: 'button', disabled: busy || !comment.trim(), onClick: post }, replyTo ? '提交回复' : '提交评论'))))))),
        review ? h(ReviewDialog, {
          kind: review,
          onSubmit: text => submitReview(review, text),
          onCancel: () => setReview(null),
        }) : null);
    }

    function NotifyButton({ onNotice }) {
      const [status, setStatus] = React.useState(notifyState.status);
      React.useEffect(() => {
        syncNotifyState();
        const fn = s => setStatus(s);
        notifyState.listeners.add(fn);
        return () => notifyState.listeners.delete(fn);
      }, []);
      const onClick = async () => {
        const prev = status;
        const next = await toggleNotify();
        if (next === 'denied') onNotice?.('通知已被浏览器拦截，请在地址栏网站设置中允许通知');
        else if (next === 'insecure') onNotice?.('当前页面不是 localhost 或 HTTPS，浏览器不支持桌面通知');
        else if (next === 'unsupported') onNotice?.('当前浏览器不支持桌面通知');
        else if (prev !== 'enabled' && next === 'enabled') onNotice?.('已开启桌面通知：待验收或收到回复时会弹窗提醒');
        else if (next === 'muted') onNotice?.('已暂停桌面通知（仍保留未读红点）');
      };
      const label = status === 'enabled' ? '🔔 通知已开启'
        : status === 'muted' ? '🔕 通知已暂停'
        : status === 'denied' ? '🔕 通知已拦截'
        : status === 'insecure' || status === 'unsupported' ? '🔕 通知不可用'
        : '🔔 开启通知';
      const title = status === 'enabled' ? '点击可暂停待验收与回复桌面通知'
        : status === 'muted' ? '点击恢复待验收与回复桌面通知'
        : status === 'denied' ? '浏览器已禁止通知，请在地址栏设置中开启'
        : status === 'insecure' ? '需要 localhost 或 HTTPS 才能使用浏览器桌面通知'
        : status === 'unsupported' ? '当前浏览器不支持桌面通知'
        : '点击授权：事务进入待验收或收到回复时通过浏览器提醒你';
      return h('button', { type: 'button', className: 'is-notify-btn', 'data-status': status, title, onClick }, label);
    }

    function Panel() {
      const [statuses, setStatuses] = React.useState(null);
      const [counts, setCounts] = React.useState({});
      const [tags, setTags] = React.useState([]);
      const [filter, setFilter] = React.useState('open');
      const [priorityFilter, setPriorityFilter] = React.useState('all');
      const [view, setView] = React.useState('list'); // list | new | detail
      const [detailId, setDetailId] = React.useState(null);
      const [focusSeq, setFocusSeq] = React.useState(0);
      const [items, setItems] = React.useState([]);
      const [error, setError] = React.useState(null);
      const [busyId, setBusyId] = React.useState(null);
      const [note, setNote] = React.useState(null);
      const [roster, setRoster] = React.useState([]);
      const [navOpen, setNavOpen] = React.useState(false); // 手机：状态筛选抽屉

      // 聊天里点 #N（或点浏览器待验收/回复通知）→ 打开对应事务。
      React.useEffect(() => {
        const focus = (target) => {
          if (!target) return;
          pendingOpen = null;
          setView('detail');
          setDetailId(String(target));
          setFocusSeq(n => n + 1);
        };
        if (pendingOpen !== null) focus(pendingOpen);
        const onFocus = (event) => focus(event?.detail?.target || resolveOpenTarget(event?.detail));
        window.addEventListener('bot-issue:focus', onFocus);
        return () => window.removeEventListener('bot-issue:focus', onFocus);
      }, []);

      const refresh = React.useCallback(async () => {
        setError(null);
        try {
          const meta = await call('meta');
          await applyMetaSnapshot(meta);
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
          const list = await call('list', {
            status: filter,
            ...(priorityFilter !== 'all' ? { priority: priorityFilter } : {}),
            limit: 100,
          });
          setItems(Array.isArray(list.items) ? list.items : []);
        } catch (caught) { setError(caught); setItems([]); }
      }, [filter, priorityFilter]);

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
        id: detailId, refreshKey: focusSeq, onBack: () => { setView('list'); refresh(); }, onChanged: refresh, roster,
        tags, onCreateTag: createTag, onDeleteTag: deleteTag,
        // 评论/正文里的 #N 可点：切到别的事务（失败就重读当前这条）
        onOpenIssue: number => { setDetailId(String(number)); refresh(); },
      });

      const filters = statuses || ['open', 'discussing', 'dispatched', 'in_review', 'done', 'failed', 'cancelled'];
      return h('div', { className: 'is-root' },
        h('div', { className: 'is-side', 'data-open': String(navOpen) },
          h('button', { className: 'is-new', type: 'button', onClick: () => { setNavOpen(false); setView('new'); } },
            h('span', null, '＋'), h('span', null, '新建事务')),
          h('div', { className: 'is-side-title' }, '状态'),
          filters.map(s => h('button', { key: s, type: 'button', className: 'is-filter', 'data-active': String(s === filter), onClick: () => { setFilter(s); setNavOpen(false); } },
            h('span', { className: 'is-filter-dot', style: { background: statusColor(s) } }),
            h('span', null, STATUS_LABEL[s] || s),
            h('span', { className: 'is-filter-count' }, String(counts[s] || 0))))),
        navOpen ? h('div', { className: 'is-scrim', onClick: () => setNavOpen(false) }) : null,
        h('div', { className: 'is-main' },
          h('div', { className: 'is-head' },
            h('button', { className: 'is-nav-btn', type: 'button', onClick: () => setNavOpen(open => !open), 'aria-label': '筛选状态' }, '☰'),
            h('span', { className: 'is-head-title' }, STATUS_LABEL[filter] || filter),
            h('span', { className: 'is-head-count' }, `${items.length} 条`),
            h('div', { className: 'is-head-right' },
              note ? h('span', { className: 'is-note' }, note) : null,
              h(NotifyButton, { onNotice: setNote }))),
          h('div', { className: 'is-prio-bar' },
            h('span', { className: 'is-prio-bar-label' }, '紧急程度'),
            ['all', ...PRIORITIES].map(p => h('button', {
              key: p,
              type: 'button',
              className: 'is-prio-chip',
              'data-prio': p,
              'data-active': String(priorityFilter === p),
              style: p === 'all' ? undefined : { '--pc': PRIORITY_META[p].color },
              onClick: () => setPriorityFilter(p),
            }, p === 'all' ? '全部' : `${p} ${PRIORITY_META[p].desc}`))),
          h('div', { className: 'is-body' },
            items.length ? items.map(issue => {
              const canStart = issue.status === 'open' || issue.status === 'discussing';
              return h('div', { key: issue.id, className: 'is-card', onClick: () => { setDetailId(issue.id); setView('detail'); } },
                h('div', { className: 'is-card-top' },
                  h(Badge, { status: issue.status }),
                  h(PriorityBadge, { priority: issue.priority || 'P2' }),
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
                priorityFilter === 'all' ? '暂无事务' : `暂无 ${priorityFilter} 事务`)))) ;
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
              description: `${STATUS_LABEL[it.status] || it.status} · ${it.priority || 'P2'}${it.type ? ` · ${it.type}` : ''}`,
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
      // 未读角标与待验收/回复桌面通知：面板没打开也轮询刷新（每 10s + 切回前台时立即同步）。
      refreshUnread();
      const unreadTimer = setInterval(refreshUnread, 10_000);
      ctx.effect(() => () => clearInterval(unreadTimer), 'bot-issue: unread poller');
      const onVisibility = () => { if (document.visibilityState === 'visible') refreshUnread(); };
      document.addEventListener?.('visibilitychange', onVisibility);
      ctx.effect(() => () => document.removeEventListener?.('visibilitychange', onVisibility), 'bot-issue: visibility sync');
      // 输入框里打 # → 事务候选补全（需 dsh input-trigger 已支持 #，见 patches/dsh-hash-trigger.md）。
      if (typeof ctx.inject === 'function') {
        ctx.inject(['inputTriggers'], inputCtx => {
          const dispose = inputCtx.inputTriggers.registerSource(issueHintSource());
          return () => { try { dispose(); } catch { /* already gone */ } };
        });
      }
      // 聊天里点 #N 或点浏览器通知：dscord/通知派发 bot-issue:open，这里切到事务面板并打开对应事务。
      const onOpen = (event) => {
        const target = resolveOpenTarget(event?.detail);
        if (!target) return;
        pendingOpen = target;
        const layout = ctx.get?.('layout') ?? ctx.layout;
        layout?.selectPanel?.('bot-issue');
        window.dispatchEvent(new CustomEvent('bot-issue:focus', { detail: { target } }));
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
