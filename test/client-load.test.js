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
