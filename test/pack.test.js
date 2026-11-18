import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACK = join(ROOT, 'scripts', 'pack.mjs');
const DEFINITIONS = [
  ['dscord', 'dscord', '0.4.0-alpha.2'],
  ['bot-issue', 'dsh-plugin-bot-issue', '0.1.0'],
  ['bot-knowledge', 'dsh-plugin-bot-knowledge', '0.1.0'],
];

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), 'stack-pack-'));
  for (const [directory, name, version] of DEFINITIONS) {
    const dir = join(root, directory);
    mkdirSync(join(dir, 'lib'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version, type: 'module', main: './lib/host.js' }, null, 2));
    writeFileSync(join(dir, 'cordis.patch.yml'), `- insert:\n    - id: ${directory}\n      name: ${name}\n`);
    writeFileSync(join(dir, 'lib', 'host.js'), 'export const name = "fixture";\n');
  }
  return root;
}

function pack(root, buildId, release = false) {
  const args = [PACK, '--root', root, '--out', 'dist'];
  if (buildId !== undefined) args.push('--build-id', buildId);
  if (release) args.push('--release');
  execFileSync(process.execPath, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(readFileSync(join(root, 'dist', 'manifest.json'), 'utf8'));
}

function sha(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

test('release pack contains all three packages with source versions and valid SHA256', () => {
  const root = fixtureRoot();
  const manifest = pack(root, 'release.test', true);

  assert.equal(manifest.stack.mode, 'release');
  assert.equal(manifest.packages.length, 3);
  for (const [directory, name, version] of DEFINITIONS) {
    const item = manifest.packages.find(pkg => pkg.directory === directory);
    assert.ok(item, directory);
    assert.equal(item.name, name);
    assert.equal(item.baseVersion, version);
    assert.equal(item.version, version);
    const file = join(root, 'dist', item.filename);
    assert.ok(existsSync(file));
    assert.equal(sha(file), item.sha256);
    assert.ok(item.bytes > 0);
  }
  const sums = readFileSync(join(root, 'dist', 'SHA256SUMS'), 'utf8');
  for (const item of manifest.packages) assert.ok(sums.includes(`${item.sha256}  ${item.filename}`));
});

test('default development build ids are unique even at the same HEAD', () => {
  const root = fixtureRoot();
  const first = pack(root, undefined);
  const second = pack(root, undefined);
  assert.notEqual(first.stack.buildId, second.stack.buildId);
  assert.notEqual(first.packages[0].version, second.packages[0].version);
});

test('development packs have unique versions and pnpm actually reinstalls them', () => {
  const root = fixtureRoot();
  const consumer = join(root, 'consumer');
  mkdirSync(consumer);
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'consumer', private: true }));

  const install = item => {
    execFileSync('pnpm', ['add', join(root, 'dist', item.filename), '--ignore-scripts'], {
      cwd: consumer,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(readFileSync(join(consumer, 'node_modules', item.name, 'package.json'), 'utf8')).version;
  };

  // 每次 pack 会重建 dist，所以按真实部署顺序：第一版先安装，再打第二版。
  const first = pack(root, 'dev.20261118.one');
  const a = first.packages.find(pkg => pkg.name === 'dsh-plugin-bot-issue');
  assert.equal(install(a), a.version);

  const second = pack(root, 'dev.20261118.two');
  const b = second.packages.find(pkg => pkg.name === 'dsh-plugin-bot-issue');
  assert.notEqual(a.version, b.version);
  assert.equal(a.baseVersion, '0.1.0');
  assert.equal(b.baseVersion, '0.1.0');
  assert.ok(a.version.includes('dev.20261118.one'));
  assert.ok(b.version.includes('dev.20261118.two'));
  assert.equal(install(b), b.version, '同名包的新 build 也必须真正替换 node_modules');
});
