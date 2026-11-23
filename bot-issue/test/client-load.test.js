import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

/**
 * 整文件守门：`lib/client.js` 必须在浏览器里真的能解析、能注册模块、能 apply。
 *
 * 为什么需要：host 只把 client.js 原样吐给浏览器，语法错误只有浏览器解析时才暴露——
 * 服务器返回 200、文件拉得下来，都不能证明它可用。dsh-plugin-bot-restart 就因为
 * return 表达式多了一个 `)`，面板从未渲染过，而当时所有测试都是绿的。
 *
 * 另外 `client-modules` 用**包名**当行 id 校验注册（`factories.has(id)`），
 * 注册成别的 id 会让整个 web 启动失败，所以这里也把 id 钉住。
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const SOURCE = readFileSync(join(root, 'lib', 'client.js'), 'utf8');
const PKG = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name;

const noop = () => {};

function sandbox(window, document) {
  return {
    window,
    document,
    fetch: async () => ({ ok: true, json: async () => ({ ok: true }) }),
    setInterval: () => 0,
    clearInterval: noop,
    setTimeout,
    clearTimeout,
    console,
    URL,
    TextEncoder,
  };
}

function loadDefinition() {
  let definition = null;
  const window = {
    __ModuleLoader__: { load: (d) => { definition = d; } },
    addEventListener: noop,
    removeEventListener: noop,
    dispatchEvent: noop,
    confirm: () => true,
    prompt: () => '',
    innerHeight: 800,
    location: {},
  };
  const el = () => ({ textContent: '', style: {}, setAttribute: noop, appendChild: noop, remove: noop });
  const document = {
    createElement: el,
    head: { appendChild: noop },
    body: { appendChild: noop },
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: noop,
    removeEventListener: noop,
  };
  vm.runInNewContext(SOURCE, sandbox(window, document), { filename: 'lib/client.js' });
  assert.ok(definition, 'client.js 必须调用 window.__ModuleLoader__.load 注册模块');
  return { definition, window, document };
}

function fakeReact() {
  return {
    createElement: () => ({}),
    useState: (initial) => [initial, noop],
    useEffect: noop,
    useCallback: (fn) => fn,
    useRef: (current) => ({ current }),
    useMemo: (fn) => fn(),
    Fragment: 'Fragment',
  };
}

test('client.js parses and registers under the package name', () => {
  const { definition } = loadDefinition();
  assert.equal(definition.id, PKG, '必须用包名注册，否则 web 启动会失败');
  assert.equal(typeof definition.factory, 'function');
});

test('client.js factory needs only react and exposes apply', () => {
  const { definition } = loadDefinition();
  const asked = [];
  const plugin = definition.factory((name) => {
    asked.push(name);
    assert.equal(name, 'react');
    return fakeReact();
  });
  assert.deepEqual(asked, ['react']);
  assert.ok(Array.isArray(plugin.inject) && plugin.inject.includes('slots'));
  assert.equal(typeof plugin.apply, 'function');
});

test('apply registers the sidebar entry and the main panel', () => {
  const { definition } = loadDefinition();
  const plugin = definition.factory(() => fakeReact());

  const registrations = [];
  const cleanups = [];
  const ctx = {
    effect: (fn) => {
      const cleanup = fn();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
      return noop;
    },
    slots: {
      inject: (_slot, fn) => fn(),
      register: (slot, component) => { registrations.push({ slot, component }); return {}; },
    },
  };

  plugin.apply(ctx);

  assert.equal(registrations.length, 2, `应注册 2 个 slot，实际 ${registrations.length}`);
  const [sidebar, main] = registrations;
  assert.equal(sidebar.slot.name, 'sidebar.panellist');
  assert.equal(`dsh-plugin-${sidebar.slot.id}`, PKG);
  assert.equal(main.slot.name, 'main');
  assert.equal(`dsh-plugin-${main.slot.key}`, PKG);
  for (const entry of registrations) {
    assert.equal(typeof entry.component, 'function', 'slot 组件必须是函数');
  }
  for (const cleanup of cleanups) cleanup();
});

test('client.js 声明手机断点与筛选抽屉', () => {
  // 手机上市面上固定的 216px 侧栏会挤掉正文，必须变成抽屉 + 遮罩 + ☰ 开关。
  assert.match(SOURCE, /@media\s*\(max-width:\s*768px\)/, '必须有手机断点');
  assert.match(SOURCE, /data-open/, '抽屉开合标记');
  assert.match(SOURCE, /is-scrim/, '抽屉遮罩');
  assert.match(SOURCE, /is-nav-btn/, '☰ 开关按钮');
});

test('client.js 包含评论引用回复与桌面通知开关能力', () => {
  assert.match(SOURCE, /replyToId/, '提交评论时应支持传递 replyToId');
  assert.match(SOURCE, /is-tl-reply/, '时间线项应有回复操作按钮');
  assert.match(SOURCE, /is-tl-quote/, '回复应显示可定位的原评论引用条');
  assert.match(SOURCE, /is-notify-btn/, '面板应有桌面通知开关/授权按钮');
  assert.match(SOURCE, /c\.kind\s*!==\s*'status'\s*&&\s*c\.kind\s*!==\s*'assign'/, '状态变更与指派记录不能展示回复按钮');
  assert.doesNotMatch(SOURCE, /\.is-tl-reply\{[^}]*margin-left:\s*auto/, '回复按钮应紧跟元数据，不要靠右贴边被悬浮按钮遮挡');
});

test('client.js 支持 P0~P3 紧急程度选择、徽标展示与列表筛选', () => {
  assert.match(SOURCE, /PRIORITIES\s*=\s*\['P0',\s*'P1',\s*'P2',\s*'P3'\]/);
  assert.match(SOURCE, /PriorityBadge/);
  assert.match(SOURCE, /PriorityPicker/);
  assert.match(SOURCE, /is-prio-bar/);
  assert.match(SOURCE, /priority:\s*priorityFilter/);
});

test('client.js 为每条评论区分卡片边界、区分个人与系统事件颜色', () => {
  assert.match(SOURCE, /\.is-tl-item\{[^}]*border:[^}]*border-left:/, '每条时间线项应有清晰边框与左侧色条');
  assert.match(SOURCE, /data-system/, '系统事件应有独立标记');
  assert.match(SOURCE, /is-tl-author/, '作者名应带独立色彩标注');
});

test('client.js 主按钮与品牌底色前景在暗色主题下保持高对比度可读', () => {
  assert.match(SOURCE, /\.is-btn\[data-kind="primary"\]\{[^}]*var\(--dsw-alias-button-primary-fill[^}]*var\(--dsw-alias-label-primary-foreground/);
  assert.match(SOURCE, /\.is-new\{[^}]*var\(--dsw-alias-label-primary-foreground/);
  assert.match(SOURCE, /\.is-mitem\[data-active="true"\],\.is-mitem:hover\{[^}]*var\(--dsw-alias-label-primary-foreground/);
  assert.doesNotMatch(SOURCE, /background:var\(--dsw-alias-brand-primary\);color:#fff/, '不能在随主题反白的品牌底色上硬编码白色文字');
});

test('client.js 使用和谐的 P2/P3 配色、进行中后锁定优先级、并采用通用工具栏编辑框（无即时预览）', () => {
  assert.match(SOURCE, /P2:\s*\{[^}]*--dsw-alias-state-business-primary/, 'P2 应使用柔和蓝色而非黑白反色');
  assert.match(SOURCE, /P3:\s*\{[^}]*--dsw-alias-label-tertiary/, 'P3 应使用柔和灰蓝');
  assert.match(SOURCE, /canEditPriority\s*=/, '详情页应判断状态控制优先级是否可编辑');
  assert.match(SOURCE, /is-editor-bar/, '编辑器应采用通用顶部格式工具栏');
  assert.match(SOURCE, /is-editor-foot/, '编辑器应带底部状态栏');
  assert.doesNotMatch(SOURCE, /is-mdpreview/, '去掉即时预览面板，提交后直接渲染 markdown');
});

test('client.js 精简 UI 文本，删掉多余注释并用 hover title 承载说明', () => {
  const verboseHints = [
    /支持 Markdown 语法，提交后自动排版/,
    /点标签选中\/取消/,
    /Esc 或点外面也能取消/,
    /它们不可能再「等本事务完成」/,
    /点左侧「新建事务」开始/,
    /写清你验证了什么/,
    /写清哪里要重做/,
    /前置（它们完成，本事务才能完成）/,
    /后置（本事务完成，它们才能完成）/,
    /背景、要做到什么程度、验收标准/,
    /补充说明、结论或交接信息/,
    /is-tag-hint/,
    /is-dep-hint/,
    /is-empty-hint/,
    /is-modal-hint/,
    /is-editor-hint/,
  ];
  for (const pattern of verboseHints) {
    assert.doesNotMatch(SOURCE, pattern, `UI 中不应保留冗余文字注释：${pattern}`);
  }
  assert.match(SOURCE, /is-editor-md[^}]*title:/, 'M↓ 标识应通过 hover title 展示说明');
  assert.match(SOURCE, /is-prio-lock[^}]*title:/, '锁定状态应通过 hover title 说明解锁条件');
  assert.match(SOURCE, /depBlock\('前置'/, '前置分组标题应简洁，说明放进 hover');
  assert.match(SOURCE, /depBlock\('后置'/, '后置分组标题应简洁，说明放进 hover');
});

test('client.js 详情页采用分块卡片布局与双栏依赖展示', () => {
  assert.match(SOURCE, /\.is-blocks\{/, '详情页应有统一宽度的分块容器');
  assert.match(SOURCE, /\.is-block\{/, '详情页各模块应以卡片分块展示');
  assert.match(SOURCE, /\.is-meta-grid/, '事务属性应采用紧凑键值对行展示');
  assert.match(SOURCE, /\.is-deps\{[^}]*grid-template-columns/, '前置与后置依赖在桌面端应双栏并排');
  assert.match(SOURCE, /\.is-dep-col/, '前置与后置各自成为紧凑子卡');
  assert.match(SOURCE, /\.is-tl\{[^}]*padding-left:22px/, '时间线左侧留出居中轨道空间');
  assert.match(SOURCE, /\.is-tl::before\{[^}]*left:6px;[^}]*width:2px/, '时间线竖线中心应落在 7px');
  assert.match(SOURCE, /\.is-tl-item::before\{[^}]*left:-24px;[^}]*width:12px;[^}]*box-sizing:border-box/, '圆点中心与竖线同在 7px');
});

test('client.js 所有状态流转按钮（除 start 外）均弹出处理意见浮窗并携带 note 提交', () => {
  assert.match(SOURCE, /if\s*\(status\s*!==\s*'start'\)\s*\{\s*setReview\(status\);\s*return;\s*\}/, '除 start 外的所有状态流转均应打开意见浮窗');
  assert.match(SOURCE, /call\('update',\s*\{\s*id,\s*status:\s*kind,\s*note:\s*opinion/, '通用状态流转提交应携带 note: opinion');
});

test('client.js 待验收状态提供「验收不通过」危险按钮并退回待处理', () => {
  assert.match(SOURCE, /in_review:\s*\[\['done',\s*'验收通过'\],\s*\['reject',\s*'验收不通过'\]/);
  assert.match(SOURCE, /reject:\s*'验收不通过'/);
  assert.match(SOURCE, /call\('update',\s*\{\s*id,\s*status:\s*'open',\s*rejection:\s*opinion/);
});
