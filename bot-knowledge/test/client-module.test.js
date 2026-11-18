import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Regression guard for a web-boot outage: `client-modules` keys every client
 * module by a row id that equals the package name, and after loading a bundle
 * it checks `factories.has(id)`. Registering under any other id makes the whole
 * web boot fail with `loaded without registering "<package>"`.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const clientPath = path.join(root, 'lib', 'client.js');
const PROFILE_MODULES = process.env.DSH_PROFILE_MODULES
  || path.join(process.env.HOME || '/tmp', '.dsh/profiles/web/node_modules/');

function packageName() {
  return JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).name;
}

test('client module registers under its package name and fills both slots', async t => {
  if (!existsSync(path.join(PROFILE_MODULES, 'react'))) {
    t.skip(`react not resolvable from ${PROFILE_MODULES}`);
    return;
  }
  const React = createRequire(PROFILE_MODULES)('react');
  const style = { textContent: '', remove() {} };
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  globalThis.document = { head: { appendChild() {} }, createElement: () => style };
  globalThis.__kbRegistration = undefined;
  globalThis.window = { __ModuleLoader__: { load(registration) { globalThis.__kbRegistration = registration; } } };

  try {
    await import(`${clientPath}?v=${Date.now()}`);
    const registration = globalThis.__kbRegistration;
    assert.ok(registration, 'client entry must call window.__ModuleLoader__.load');
    assert.equal(registration.id, packageName(),
      'client module id must equal the package name or the whole web boot fails');

    const module = registration.factory(name => {
      if (name === 'react') return React;
      throw new Error(`unexpected require(${name})`);
    });
    assert.deepEqual(Object.keys(module).sort(), ['apply', 'inject']);
    assert.deepEqual(module.inject, ['slots']);

    const slots = [];
    let effects = 0;
    module.apply({
      slots: {
        inject(_name, register) { register(); },
        register(options, component) { slots.push({ options, component }); return () => {}; },
      },
      effect(register) { effects += 1; register(); return () => {}; },
    });

    assert.equal(effects, 1, 'the stylesheet must be cleaned up through ctx.effect');
    const tile = slots.find(slot => slot.options.name === 'sidebar.panellist');
    const page = slots.find(slot => slot.options.name === 'main');
    assert.equal(tile?.options.id, 'bot-knowledge', 'sidebar icon id');
    assert.equal(tile?.options.order, 30, 'sidebar order must sit after DSCord');
    assert.equal(page?.options.key, 'bot-knowledge', 'main panel key');
    assert.equal(typeof tile?.component, 'function');
    assert.equal(typeof page?.component, 'function');
  } finally {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
  }
});
